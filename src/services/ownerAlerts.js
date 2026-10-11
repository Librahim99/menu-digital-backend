// ──────────────────────────────────────────────
// Avisos del panel del dueño: pedido nuevo, mesa abierta, reserva nueva.
// Viajan por los WebSocket de pedidos y de reservas (campo `alert`) y el
// panel abierto los hace sonar y los muestra en cualquier pantalla. Sin push:
// quien trabaja en el local tiene el panel abierto.
// ──────────────────────────────────────────────

// Mismos nombres que el panel (SERVICE_LABEL en el frontend).
const SERVICE_LABEL = { counter: "Barra", takeaway: "Take away", delivery: "Delivery" };

const money = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return `$${amount.toLocaleString("es-AR", { maximumFractionDigits: 2 })}`;
};

const itemsLabel = (items) => {
  const count = (items ?? []).reduce((total, item) => total + (Number(item.quantity) || 0), 0);
  if (!count) return null;
  return count === 1 ? "1 producto" : `${count} productos`;
};

/**
 * Aviso de un pedido recién creado, o null si no amerita avisar. Viaja por el
 * WebSocket del panel. No lleva datos del cliente: solo mesa / tipo, número,
 * cantidad y total.
 *
 * - Pedido del comensal (queda sin confirmar): avisa siempre.
 * - Pedido que abre una mesa (de un operador o del comensal): avisa la mesa.
 * - Pedido cargado desde el panel: no avisa (lo cargó el propio local).
 *
 * @param {object} order       DTO del pedido
 * @param {{ tableOpened?: boolean }} options
 */
const orderAlert = (order, { tableOpened = false } = {}) => {
  if (!order || order.source === "panel") return null;
  const fromCustomer = order.source === "customer";
  const opensTable = tableOpened && order.tableNumber;
  if (!fromCustomer && !opensTable) return null;

  const where = order.tableNumber ? `Mesa ${order.tableNumber}` : SERVICE_LABEL[order.serviceType] ?? "Pedido";
  const details = [itemsLabel(order.items), money(order.total)].filter(Boolean).join(" · ");

  if (opensTable) {
    const who = fromCustomer ? `Pedido #${order.number} por confirmar` : `Pedido #${order.number}${order.waiterName ? ` de ${order.waiterName}` : ""}`;
    return {
      kind: "table",
      key: `table:${order.tableSessionId ?? order.tableNumber}`,
      title: `🍽️ ${where} abierta`,
      body: [who, details].filter(Boolean).join(" · "),
      url: fromCustomer ? "/pedidos" : "/pedidos/mesas",
      orderId: order.id,
    };
  }
  return {
    kind: "order",
    key: `order:${order.id}`,
    title: `🛎️ Nuevo pedido #${order.number}`,
    body: [where, details].filter(Boolean).join(" · "),
    url: "/pedidos",
    orderId: order.id,
  };
};

const formatDate = (date) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return match ? `${match[3]}/${match[2]}` : "";
};

/** Aviso de una reserva pedida desde la web (DTO del dueño). */
const reservationAlert = (reservation) => {
  if (!reservation || reservation.source !== "web" || reservation.status !== "pending") return null;
  const people = Number(reservation.partySize) === 1 ? "1 persona" : `${reservation.partySize} personas`;
  const when = [formatDate(reservation.date), String(reservation.time ?? "").slice(0, 5)].filter(Boolean).join(" ");
  return {
    kind: "reservation",
    key: `reservation:${reservation.id}`,
    title: "📅 Nueva reserva",
    body: [reservation.name, people, when].filter(Boolean).join(" · "),
    url: "/reservas",
  };
};

module.exports = { orderAlert, reservationAlert };
