const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_RANGES_PER_DAY = 4;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Argentina no usa horario de verano desde 2009, así que el offset es fijo.
// Mismo criterio que el front al mandar fechas (ver MenuEditor.tsx).
const AR_OFFSET = "-03:00";

const getEmptyDateRange = () => ({ from: null, to: null });

const getEmptySchedule = () => ({
  enabled: false,
  ...Object.fromEntries(DAY_KEYS.map((day) => [day, []])),
  dateRange: getEmptyDateRange(),
});

const toMinutes = (time) => {
  const [, hours, minutes] = time.match(TIME_PATTERN);
  return Number(hours) * 60 + Number(minutes);
};

// El rango de fechas se guarda como instantes, pero el dueño lo elige por
// día calendario: "desde el 1" arranca a las 00:00 de Buenos Aires y "hasta
// el 5" termina al final de ese día. Acepta también un Date/ISO ya armado
// (datos viejos de offerRange, que nació como datetime-local).
const parseRangeDate = (value, edge) => {
  if (value === "" || value == null) return null;
  if (typeof value === "string" && DATE_PATTERN.test(value)) {
    const time = edge === "to" ? "23:59:59.999" : "00:00:00.000";
    return new Date(`${value}T${time}${AR_OFFSET}`);
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

// `from`/`to` son independientes: se puede programar solo un inicio ("desde
// el lunes que viene"), solo un fin, las dos o ninguna.
const validateDateRange = (value) => {
  if (value == null) return { dateRange: getEmptyDateRange() };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "El rango de fechas no es válido." };
  }

  const from = parseRangeDate(value.from, "from");
  const to = parseRangeDate(value.to, "to");
  if (from === undefined || to === undefined) {
    return { error: "Las fechas del rango no son válidas." };
  }
  if (from && to && from > to) {
    return { error: "La fecha de fin debe ser posterior a la de inicio." };
  }

  return { dateRange: { from, to } };
};

const isWithinDateRange = (dateRange, date = new Date()) => {
  const from = dateRange?.from ? new Date(dateRange.from) : null;
  const to = dateRange?.to ? new Date(dateRange.to) : null;
  if (from && !Number.isNaN(from.getTime()) && date < from) return false;
  if (to && !Number.isNaN(to.getTime()) && date > to) return false;
  return true;
};

// Valida el horario semanal que comparten la disponibilidad del producto y
// la oferta programada. `withDateRange` en false lo usa la oferta, que ya
// lleva su propio rango de fechas en offerRange.
const validateAvailabilitySchedule = (value, { withDateRange = true } = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "El horario de disponibilidad no es válido." };
  }

  const schedule = getEmptySchedule();
  if (!withDateRange) delete schedule.dateRange;
  schedule.enabled = value.enabled === true;
  const segments = [];

  for (const [dayIndex, day] of DAY_KEYS.entries()) {
    const ranges = value[day] ?? [];
    if (!Array.isArray(ranges) || ranges.length > MAX_RANGES_PER_DAY) {
      return { error: `Podés configurar hasta ${MAX_RANGES_PER_DAY} horarios por día.` };
    }

    for (const range of ranges) {
      if (!range || !TIME_PATTERN.test(range.from) || !TIME_PATTERN.test(range.to)) {
        return { error: "Cada horario debe tener un inicio y un fin válidos." };
      }

      const from = toMinutes(range.from);
      const to = toMinutes(range.to);

      schedule[day].push({ from: range.from, to: range.to });
      const start = dayIndex * 1440 + from;
      if (to > from) {
        segments.push([start, dayIndex * 1440 + to]);
      } else {
        // Termina al día siguiente (por ejemplo, 20:00–02:00). Horas iguales
        // son las 24 horas del día, mismo criterio que el horario del negocio.
        segments.push([start, (dayIndex + 1) * 1440 + to]);
      }
    }
  }

  if (schedule.enabled && segments.length === 0) {
    return { error: "Agregá al menos un horario antes de activar la programación." };
  }

  // Duplicamos los segmentos cercanos al comienzo de semana para detectar
  // también solapamientos entre un horario del domingo y otro del lunes.
  const weekMinutes = 7 * 1440;
  const normalizedSegments = segments.flatMap(([start, end]) => {
    if (end <= weekMinutes) return [[start, end]];
    return [[start, weekMinutes], [0, end - weekMinutes]];
  }).sort((a, b) => a[0] - b[0]);

  for (let index = 1; index < normalizedSegments.length; index += 1) {
    if (normalizedSegments[index][0] < normalizedSegments[index - 1][1]) {
      return { error: "Los horarios no pueden superponerse." };
    }
  }

  if (withDateRange) {
    const { dateRange, error } = validateDateRange(value.dateRange);
    if (error) return { error };
    schedule.dateRange = dateRange;
  }

  return { schedule };
};

const buenosAiresParts = (date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const dayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(values.weekday);
  return { dayIndex, minutes: Number(values.hour) * 60 + Number(values.minute) };
};

const isScheduleAvailableAt = (schedule, date = new Date()) => {
  if (!schedule?.enabled) return true;
  // Fuera del rango de fechas la programación no rige: el producto queda
  // como esté configurado manualmente.
  if (!isWithinDateRange(schedule.dateRange, date)) return true;

  const { dayIndex, minutes } = buenosAiresParts(date);
  const today = schedule[DAY_KEYS[dayIndex]] || [];
  const previousDay = schedule[DAY_KEYS[(dayIndex + 6) % 7]] || [];

  const insideToday = today.some(({ from, to }) => {
    const start = toMinutes(from);
    const end = toMinutes(to);
    return end > start ? minutes >= start && minutes < end : minutes >= start;
  });
  const insidePreviousOvernight = previousDay.some(({ from, to }) => {
    const start = toMinutes(from);
    const end = toMinutes(to);
    return end <= start && minutes < end;
  });

  return insideToday || insidePreviousOvernight;
};

module.exports = {
  DAY_KEYS,
  getEmptySchedule,
  isScheduleAvailableAt,
  isWithinDateRange,
  validateAvailabilitySchedule,
  validateDateRange,
};
