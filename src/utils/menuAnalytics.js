const { buenosAiresHour } = require("./dates");

// ──────────────────────────────────────────────
// Analítica de la carta pública: qué cuenta una visita y cómo se resume.
//
// La carta decide si una carga es una visita nueva (ver
// src/lib/menuAnalytics.ts del frontend) y lo avisa en la misma
// GET /:slug/menu, con estos parámetros:
//   - sin `track`: bundle anterior a este protocolo. Se cuenta cada carga,
//     como antes, para no perder visitas mientras quedan pestañas viejas.
//   - track=0: no se cuenta (el dueño mirando su carta, la vista previa del
//     panel, o una recarga dentro de la misma sesión).
//   - track=1: visita nueva. nv=1 si es la primera del día en ese
//     dispositivo, ret=1 si ese dispositivo ya había entrado otro día y
//     src=qr si llegó escaneando el QR descargado del panel.
// Front y back se despliegan por separado y en cualquier orden: un backend
// anterior ignora los parámetros y un front anterior no los manda.
// ──────────────────────────────────────────────

const parseVisit = (query = {}) => {
  if (query.track === undefined) return { count: true, detailed: false };
  if (query.track !== "1") return { count: false, detailed: false };
  const newVisitor = query.nv === "1";
  return {
    count: true,
    detailed: true,
    newVisitor,
    returning: newVisitor && query.ret === "1",
    qr: query.src === "qr",
  };
};

// Update de PageView para una visita contada. La hora sale del servidor
// (Buenos Aires), así que los horarios pico valen también para las visitas
// de bundles anteriores.
const buildVisitUpdate = (visit, now = new Date()) => {
  const inc = { count: 1, [`hours.${buenosAiresHour(now)}`]: 1 };
  if (visit.detailed) {
    inc.tracked = 1;
    if (visit.newVisitor) inc.visitors = 1;
    if (visit.returning) inc.returning = 1;
    if (visit.qr) inc.qr = 1;
  }
  return { $inc: inc };
};

// Eventos del embudo que manda la carta (POST /:slug/menu/events), una vez
// por sesión cada uno salvo el pedido, que se manda por cada pedido
// distinto. El valor es el campo de PageView que suman.
const MENU_EVENTS = { engaged: "engaged", cart: "carts", order: "orders" };

// Tope de productos distintos de un pedido que se registran (un carrito
// real no llega; frena un body inflado a propósito).
const ORDER_ITEMS_MAX = 50;

const AUDIENCE_FIELDS = ["tracked", "visitors", "returning", "qr", "engaged", "carts", "orders"];
const isCount = value => typeof value === "number" && Number.isFinite(value) && value > 0;

// Resume los días del período (solo días completos, sin hoy) para las
// estadísticas del panel:
// - hours: visitas por hora del día, sumadas. hoursFrom es el primer día
//   del período con horas registradas (antes de este cambio no había).
// - audience: lo que solo mide el protocolo nuevo (sesiones, visitantes,
//   QR, embudo). `visits` son las visitas contadas con ese protocolo, que
//   es la base correcta de cada proporción; `from` es el primer día con
//   datos, para que el panel aclare desde cuándo se mide.
const summarizeWindow = (rows, dates) => {
  const inWindow = new Set(dates);
  const hours = Array(24).fill(0);
  const audience = { from: null, visits: 0, visitors: 0, returning: 0, qr: 0, engaged: 0, carts: 0, orders: 0 };
  let hoursFrom = null;

  for (const row of rows) {
    if (!inWindow.has(row.date)) continue;
    const rowHours = row.hours && typeof row.hours === "object" ? row.hours : null;
    let hasHours = false;
    if (rowHours) {
      for (let hour = 0; hour < 24; hour += 1) {
        const value = rowHours[hour] ?? rowHours[String(hour)];
        if (isCount(value)) { hours[hour] += value; hasHours = true; }
      }
    }
    if (hasHours && (hoursFrom === null || row.date < hoursFrom)) hoursFrom = row.date;

    if (!AUDIENCE_FIELDS.some(field => isCount(row[field]))) continue;
    if (audience.from === null || row.date < audience.from) audience.from = row.date;
    audience.visits += isCount(row.tracked) ? row.tracked : 0;
    for (const field of ["visitors", "returning", "qr", "engaged", "carts", "orders"]) {
      if (isCount(row[field])) audience[field] += row[field];
    }
  }

  return { hours, hoursFrom, audience };
};

module.exports = {
  parseVisit,
  buildVisitUpdate,
  summarizeWindow,
  MENU_EVENTS,
  ORDER_ITEMS_MAX,
};
