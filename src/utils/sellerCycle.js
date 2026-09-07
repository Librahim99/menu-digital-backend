// ──────────────────────────────────────────────
// Ventanas de ciclo mensual de comisión de un vendedor, ancladas a su
// startDate (asignada desde el ABM). Reusa addCalendarMonths (utils/dates.js)
// para conservar el mismo criterio de "clampeo" en meses cortos que ya usa el
// resto del backend (ej: ancla el día 31 -> 28/29 de febrero).
// ──────────────────────────────────────────────

const { addCalendarMonths } = require("./dates");

// Vendedores creados antes de que existiera este campo (o a los que nunca se
// les cargó) no tienen startDate: se ancla en su alta como mejor aproximación
// disponible.
function cycleAnchor(seller) {
  return new Date(seller.startDate || seller.createdAt);
}

// Ventana [start, end) del ciclo que empieza `offset` meses calendario
// después del ancla. offset 0 = el ciclo que arranca el día del ancla en su
// mes actual; offset -1 = el ciclo anterior; offset 1 = el siguiente.
function cycleWindowAtOffset(anchor, offset) {
  return {
    offset,
    start: addCalendarMonths(anchor, offset),
    end: addCalendarMonths(anchor, offset + 1),
  };
}

// Encuentra el offset/ventana que contiene `now`. La resta de meses entre
// ancla y `now` es solo una ESTIMACIÓN del offset correcto cerca de fin de
// mes (addCalendarMonths clampea meses cortos, así que ese clampeo puede
// correr el límite real de la ventana un día para un lado u otro) — el bucle
// acotado de corrección la ajusta a la ventana exacta sin tener que duplicar
// la lógica de clampeo en una fórmula cerrada.
function currentCycleWindow(anchor, now = new Date()) {
  let offset =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());
  let window = cycleWindowAtOffset(anchor, offset);

  let guard = 0;
  while (now < window.start && guard < 8) {
    offset -= 1;
    window = cycleWindowAtOffset(anchor, offset);
    guard += 1;
  }
  guard = 0;
  while (now >= window.end && guard < 8) {
    offset += 1;
    window = cycleWindowAtOffset(anchor, offset);
    guard += 1;
  }

  return window;
}

module.exports = { cycleAnchor, cycleWindowAtOffset, currentCycleWindow };
