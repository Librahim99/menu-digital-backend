const { DAY_KEYS, validateAvailabilitySchedule } = require("./itemAvailability");

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// typeof primero: RegExp.test convierte a string y ["09:00"] pasaría.
const isTime = (value) => typeof value === "string" && HHMM_RE.test(value);

// Horario de atención del negocio. Cada día guarda sus turnos en `ranges`
// (mismo shape y mismas reglas que la programación de productos y ofertas:
// hasta 4 por día, cierre <= apertura termina al día siguiente, horas iguales
// son 24 horas, sin superponerse). `open`/`close` quedan como copia del
// primer turno para que un front anterior a los turnos cortados siga
// mostrando algo coherente; un cliente que no manda `ranges` se interpreta
// como un único turno open–close.
const normalizeBusinessSchedule = (value) => {
  const invalid = { error: "El horario cargado no es válido." };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;

  const schedule = {};
  const openRanges = {};

  for (const day of DAY_KEYS) {
    const d = value[day];
    if (!d || typeof d !== "object" || typeof d.enabled !== "boolean") return invalid;
    if (d.ranges !== undefined && !Array.isArray(d.ranges)) return invalid;

    // Un día cerrado conserva las horas que tenía (open/close) pero no sus
    // turnos: el editor arranca un día que se vuelve a abrir desde el
    // horario general.
    if (!d.enabled) {
      schedule[day] = { enabled: false, ranges: [] };
      if (typeof d.open === "string") schedule[day].open = d.open;
      if (typeof d.close === "string") schedule[day].close = d.close;
      openRanges[day] = [];
      continue;
    }

    const ranges = d.ranges ?? [{ from: d.open, to: d.close }];
    if (ranges.length === 0) return invalid;
    if (ranges.some((range) => !range || !isTime(range.from) || !isTime(range.to))) {
      return invalid;
    }

    const clean = ranges.map(({ from, to }) => ({ from, to }));
    schedule[day] = { enabled: true, open: clean[0].from, close: clean[0].to, ranges: clean };
    openRanges[day] = clean;
  }

  // Cantidad máxima por día y superposiciones (también entre el domingo y el
  // lunes) con el mismo validador que la disponibilidad de productos.
  const { error } = validateAvailabilitySchedule(
    { enabled: false, ...openRanges },
    { withDateRange: false },
  );
  if (error) return { error };

  return { schedule };
};

module.exports = { normalizeBusinessSchedule };
