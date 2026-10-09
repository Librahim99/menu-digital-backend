// Forma pública de un pedido (lo que reciben el panel y el tomador del
// operador). Aparte de orderService para que otros servicios (sesiones de
// mesa) puedan devolver pedidos sin depender de él.

const { query } = require("../db/sql");

const num = (value) => (value === null || value === undefined ? null : Number(value));
const optionalId = (value) => (value === null || value === undefined ? null : Number(value));

const toItemDTO = (row) => ({
  id: Number(row.id),
  itemId: row.item_id,
  title: row.title,
  categoryName: row.category_name ?? null,
  option: row.option_name,
  unitPrice: num(row.unit_price),
  quantity: row.quantity,
  notes: row.notes,
  // Sector de la comanda a la que fue la línea (null sin sectores).
  sectorName: row.ticket_sector_name ?? null,
  // Entrega en partes: cuándo se entregó esta línea (null si todavía no).
  deliveredAt: row.delivered_at ?? null,
});

// Línea quitada del pedido (falta de stock, error…): no suma al total.
const toRemovedItemDTO = (row) => ({
  ...toItemDTO(row),
  reason: row.status_reason ?? null,
  removedAt: row.cancelled_at ?? null,
});

const isRemoved = (row) => row.status === "cancelled";
const cents = (value) => Math.round(Number(value) * 100);

// Comandas del pedido (una por sector), con su avance.
const toTicketSummary = (row) => ({
  id: Number(row.ticket_id),
  sectorId: Number(row.ticket_sector_id),
  sectorName: row.ticket_sector_name,
  status: row.ticket_status,
  doneAt: row.ticket_done_at,
});

// Delivery que ya salió del local. Vale solo si la salida es posterior a la última
// vez que el pedido quedó listo; así, si vuelve atrás y se lo marca listo de nuevo,
// deja de figurar en camino sin tener que limpiar nada.
const dispatchedAtOf = (row) => {
  if (!row.dispatched_at) return null;
  if (row.status !== "ready") return null;
  if (row.ready_at && new Date(row.dispatched_at).getTime() < new Date(row.ready_at).getTime()) return null;
  return row.dispatched_at;
};

const toOrderDTO = (row, items = [], tickets = [], { removedItems = [], refundDue = 0 } = {}) => ({
  id: Number(row.id),
  shiftId: Number(row.shift_id),
  number: row.number,
  source: row.source,
  status: row.status,
  // Un pedido "de mesa" sin mesa solo puede venir de antes de service_type.
  serviceType: row.service_type && (row.service_type !== "table" || row.table_number)
    ? row.service_type
    : (row.table_number ? "table" : "counter"),
  tableNumber: row.table_number,
  tableSessionId: optionalId(row.table_session_id),
  cashSessionId: optionalId(row.cash_session_id),
  customerName: row.customer_name ?? null,
  customerPhone: row.customer_phone ?? null,
  deliveryAddress: row.delivery_address ?? null,
  deliveryNotes: row.delivery_notes ?? null,
  waiterId: optionalId(row.waiter_id),
  waiterName: row.waiter_name,
  notes: row.notes,
  statusReason: row.status_reason ?? null,
  // Estado del pago, aparte del estado del pedido (un pedido pagado puede estar
  // todavía sin aceptar). Sin la migración de pagos, todos son "sin cobro online".
  paymentMode: row.payment_mode ?? "none",
  paymentStatus: row.payment_status ?? "NOT_REQUIRED",
  subtotal: num(row.subtotal ?? row.total),
  discountAmount: num(row.discount_amount) ?? 0,
  total: num(row.total),
  createdAt: row.created_at,
  confirmedAt: row.confirmed_at,
  readyAt: row.ready_at,
  dispatchedAt: dispatchedAtOf(row),
  deliveredAt: row.delivered_at,
  cancelledAt: row.cancelled_at,
  returnedAt: row.returned_at,
  items,
  tickets,
  // Productos quitados del pedido (no están en `items` ni en el total).
  removedItems,
  // Pagado online y con productos quitados: lo que falta devolverle al cliente.
  refundDue,
});

// Lo cobrado online que ya no corresponde al pedido (se quitaron productos):
// cobrado − devuelto − devoluciones en curso − total actual. Solo consulta los
// pagos de pedidos online con algo quitado, así el resto no depende de ellos.
const refundDueByOrder = async (rows, removedByOrder, runner) => {
  const ids = rows
    .filter((row) => row.payment_mode === "mercadopago" && removedByOrder.has(String(row.id)))
    .map((row) => row.id);
  const due = new Map();
  if (ids.length === 0) return due;
  const { rows: payments } = await runner.query(
    `SELECT p.order_id, p.amount, p.refunded_amount,
            coalesce((SELECT sum(r.amount) FROM order_refunds r
                      WHERE r.online_payment_id = p.id AND r.status = 'PENDING'), 0) AS pending_amount
     FROM order_online_payments p
     WHERE p.order_id = ANY($1) AND p.status IN ('APPROVED', 'PARTIALLY_REFUNDED')`,
    [ids]
  );
  const totals = new Map(rows.map((row) => [String(row.id), cents(row.total)]));
  for (const payment of payments) {
    const key = String(payment.order_id);
    const left = cents(payment.amount) - cents(payment.refunded_amount) - cents(payment.pending_amount) - totals.get(key);
    if (left > 0) due.set(key, left / 100);
  }
  return due;
};

// Trae las líneas (y las comandas) de varios pedidos en una sola consulta.
const withItems = async (rows, runner = { query }) => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const { rows: itemRows } = await runner.query(
    `SELECT i.*, t.sector_id AS ticket_sector_id, t.sector_name AS ticket_sector_name,
            t.status AS ticket_status, t.done_at AS ticket_done_at
     FROM order_items i LEFT JOIN order_tickets t ON t.id = i.ticket_id
     WHERE i.order_id = ANY($1) ORDER BY i.order_id, i.position, i.id`,
    [ids]
  );
  const byOrder = new Map();
  const removedByOrder = new Map();
  const ticketsByOrder = new Map();
  for (const item of itemRows) {
    const key = String(item.order_id);
    const target = isRemoved(item) ? removedByOrder : byOrder;
    if (!target.has(key)) target.set(key, []);
    target.get(key).push(isRemoved(item) ? toRemovedItemDTO(item) : toItemDTO(item));
    if (item.ticket_id !== null && item.ticket_id !== undefined) {
      if (!ticketsByOrder.has(key)) ticketsByOrder.set(key, new Map());
      ticketsByOrder.get(key).set(String(item.ticket_id), toTicketSummary(item));
    }
  }
  const refundDue = await refundDueByOrder(rows, removedByOrder, runner);
  return rows.map((row) => toOrderDTO(
    row,
    byOrder.get(String(row.id)) ?? [],
    [...(ticketsByOrder.get(String(row.id))?.values() ?? [])],
    { removedItems: removedByOrder.get(String(row.id)) ?? [], refundDue: refundDue.get(String(row.id)) ?? 0 }
  ));
};

module.exports = { toOrderDTO, withItems, dispatchedAtOf };
