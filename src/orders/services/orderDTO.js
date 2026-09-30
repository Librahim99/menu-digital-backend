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
});

const toOrderDTO = (row, items = []) => ({
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
  subtotal: num(row.subtotal ?? row.total),
  discountAmount: num(row.discount_amount) ?? 0,
  total: num(row.total),
  createdAt: row.created_at,
  confirmedAt: row.confirmed_at,
  readyAt: row.ready_at,
  deliveredAt: row.delivered_at,
  cancelledAt: row.cancelled_at,
  returnedAt: row.returned_at,
  items,
});

// Trae las líneas de varios pedidos en una sola consulta.
const withItems = async (rows, runner = { query }) => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const { rows: itemRows } = await runner.query(
    "SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY order_id, position, id",
    [ids]
  );
  const byOrder = new Map();
  for (const item of itemRows) {
    const key = String(item.order_id);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(toItemDTO(item));
  }
  return rows.map((row) => toOrderDTO(row, byOrder.get(String(row.id)) ?? []));
};

module.exports = { toOrderDTO, withItems };
