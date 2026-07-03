// ──────────────────────────────────────────────
// Helpers de fecha en horario de Buenos Aires (America/Argentina/Buenos_Aires,
// UTC-3, sin horario de verano hoy en día).
//
// Por qué existe esto: las visitas se agregan por día (una fila por local por
// día). Si el "día" se calcula con new Date().toISOString() —que es UTC— el
// corte de día ocurre a las 21:00 hora argentina: toda visita entre las 21:00
// y la medianoche se contaba en el día SIGUIENTE, corriendo las estadísticas.
// Formateando en la zona horaria local, el corte de día es a la medianoche de
// Buenos Aires, como espera el usuario.
// ──────────────────────────────────────────────

const TZ = "America/Argentina/Buenos_Aires";

// Usamos el locale en-CA a propósito: formatea las fechas como "YYYY-MM-DD",
// que es justo el formato con el que guardamos PageView.date (ordenable como
// string y sin ambigüedad día/mes).
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Devuelve la fecha "YYYY-MM-DD" correspondiente al instante `date` (default:
 * ahora) pero leída en horario de Buenos Aires.
 */
const buenosAiresDateStr = (date = new Date()) => formatter.format(date);

module.exports = { buenosAiresDateStr, TIMEZONE_BA: TZ };
