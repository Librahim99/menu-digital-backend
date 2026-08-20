const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_RANGES_PER_DAY = 4;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const getEmptySchedule = () => ({
  enabled: false,
  ...Object.fromEntries(DAY_KEYS.map((day) => [day, []])),
});

const toMinutes = (time) => {
  const [, hours, minutes] = time.match(TIME_PATTERN);
  return Number(hours) * 60 + Number(minutes);
};

const validateAvailabilitySchedule = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "El horario de disponibilidad no es válido." };
  }

  const schedule = getEmptySchedule();
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
      if (from === to) {
        return { error: "El inicio y el fin de un horario no pueden ser iguales." };
      }

      schedule[day].push({ from: range.from, to: range.to });
      const start = dayIndex * 1440 + from;
      const end = dayIndex * 1440 + to;
      if (to > from) {
        segments.push([start, end]);
      } else {
        // El rango termina al día siguiente (por ejemplo, 20:00–02:00).
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
      return { error: "Los horarios de disponibilidad no pueden superponerse." };
    }
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
    return end < start && minutes < end;
  });

  return insideToday || insidePreviousOvernight;
};

module.exports = {
  DAY_KEYS,
  getEmptySchedule,
  isScheduleAvailableAt,
  validateAvailabilitySchedule,
};
