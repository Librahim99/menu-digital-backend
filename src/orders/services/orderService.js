// Pedidos: alta (comensal, mozo o panel), cambios de estado y consultas.

const crypto = require("crypto");
const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const {
  ACTIVE_STATUSES, ORDER_STATUSES, STATUS_TRANSITIONS, STATUS_TIMESTAMPS, LIMITS,
} = require("../constants");
const { lockOrOpenShift } = require("./shiftService");
const { priceOrderLines } = require("./menuCatalog");

const num = (value) => (value === null || value === undefined ? null : Number(value));

const toItemDTO = (row) => ({
  id: Number(row.id),
  itemId: row.item_id,
  title: row.title,
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
  tableNumber: row.table_number,
  waiterId: row.waiter_id === null ? null : Number(row.waiter_id),
  waiterName: row.waiter_name,
  notes: row.notes,
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

// Huella del contenido: mismos productos, variantes, cantidades, aclaraciones
// y mesa = mismo pedido.
const contentHashOf = (lines, tableNumber) => {
  const normalized = lines
    .map((line) => [line.itemId, line.option ?? "", line.quantity, line.notes ?? ""].join("|"))
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(`${tableNumber ?? ""}\n${normalized}`).digest("hex");
};

const findByClientRequest = async (runner, ownerId, clientRequestId) => {
  const { rows } = await runner.query(
    "SELECT * FROM orders WHERE owner_id = $1 AND client_request_id = $2",
    [ownerId, clientRequestId]
  );
  return rows[0] ?? null;
};

/**
 * Crea un pedido.
 * @param {object} input
 * @param {object} input.owner          User (Mongo) del local
 * @param {object} input.settings       fila de order_settings
 * @param {"customer"|"waiter"|"panel"} input.source
 * @param {Array}  input.lines          salida de parseOrderLines
 * @param {number|null} input.tableNumber
 * @param {{id:number,name:string}|null} input.waiter
 * @param {string|null} input.notes
 * @param {string|null} input.clientRequestId  idempotencia (reintentos del mismo envío)
 * @param {string|null} input.fingerprint      solo comensales: frecuencia y duplicados
 * @returns {{ order: object, duplicate: boolean }}
 */
const createOrder = async ({
  owner, settings, source, lines, tableNumber = null, waiter = null, notes = null,
  clientRequestId = null, fingerprint = null,
}) => {
  const ownerId = String(owner._id);
  const priced = await priceOrderLines(owner, lines);
  const contentHash = fingerprint ? contentHashOf(lines, tableNumber) : null;
  // Los pedidos del personal entran confirmados; los del comensal esperan
  // que el local los confirme.
  const status = source === "customer" ? "pending" : "confirmed";

  try {
    return await withTransaction(async (client) => {
      if (clientRequestId) {
        const existing = await findByClientRequest(client, ownerId, clientRequestId);
        if (existing) return { order: (await withItems([existing], client))[0], duplicate: true };
      }

      if (fingerprint) {
        const { rows } = await client.query(
          `SELECT created_at, content_hash FROM orders
           WHERE owner_id = $1 AND client_fingerprint = $2 AND created_at > now() - make_interval(secs => $3)
           ORDER BY created_at DESC LIMIT 5`,
          [ownerId, fingerprint, LIMITS.duplicateWindowMs / 1000]
        );
        if (rows.some((row) => row.content_hash === contentHash)) {
          throw new OrdersError(409, "Ya enviaste este mismo pedido hace un momento.", "DUPLICATE_ORDER");
        }
        if (rows[0] && Date.now() - new Date(rows[0].created_at).getTime() < LIMITS.customerCooldownMs) {
          throw new OrdersError(429, "Esperá unos segundos antes de enviar otro pedido.", "ORDER_COOLDOWN");
        }
      }

      const shift = await lockOrOpenShift(client, settings);
      const next = await client.query(
        "SELECT coalesce(max(number), 0) + 1 AS number FROM orders WHERE shift_id = $1",
        [shift.id]
      );

      const { rows: [order] } = await client.query(
        `INSERT INTO orders (owner_id, shift_id, number, source, status, table_number, waiter_id, waiter_name,
           notes, total, client_request_id, client_fingerprint, content_hash, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [ownerId, shift.id, next.rows[0].number, source, status, tableNumber, waiter?.id ?? null,
          waiter?.name ?? null, notes, priced.total, clientRequestId, fingerprint, contentHash,
          status === "confirmed" ? new Date() : null]
      );

      for (const line of priced.lines) {
        await client.query(
          `INSERT INTO order_items (order_id, item_id, title, option_name, unit_price, quantity, notes, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [order.id, line.itemId, line.title, line.option, line.unitPrice, line.quantity, line.notes, line.position]
        );
      }

      return { order: (await withItems([order], client))[0], duplicate: false };
    });
  } catch (error) {
    // Dos reintentos simultáneos del mismo envío: el segundo choca con el
    // UNIQUE de client_request_id y devuelve el pedido del primero.
    if (error.code === "23505" && clientRequestId) {
      const existing = await findByClientRequest({ query }, ownerId, clientRequestId);
      if (existing) return { order: (await withItems([existing]))[0], duplicate: true };
    }
    throw error;
  }
};

// Lo que muestra el panel: todo pedido sin entregar ni cancelar, de
// cualquier turno (un pedido que quedó abierto al cerrar la caja no se pierde).
const listActiveOrders = async (ownerId) => {
  const { rows } = await query(
    "SELECT * FROM orders WHERE owner_id = $1 AND status = ANY($2) ORDER BY created_at",
    [ownerId, ACTIVE_STATUSES]
  );
  return withItems(rows);
};

// Historial con filtros y paginado.
const listOrders = async (ownerId, { shiftId, status, from, to, tableNumber, page = 1, pageSize = 30 } = {}) => {
  const where = ["owner_id = $1"];
  const params = [ownerId];
  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };
  if (shiftId) add("shift_id = ?", shiftId);
  if (status) add("status = ?", status);
  if (tableNumber) add("table_number = ?", tableNumber);
  if (from) add("created_at >= ?", from);
  if (to) add("created_at < ?", to);

  const whereSql = where.join(" AND ");
  const [{ rows }, count] = await Promise.all([
    query(
      `SELECT * FROM orders WHERE ${whereSql} ORDER BY created_at DESC LIMIT ${Number(pageSize)} OFFSET ${(Number(page) - 1) * Number(pageSize)}`,
      params
    ),
    query(`SELECT count(*)::int AS total FROM orders WHERE ${whereSql}`, params),
  ]);
  return { orders: await withItems(rows), total: count.rows[0].total, page, pageSize };
};

const getOwnedOrder = async (runner, ownerId, orderId, { lock = false } = {}) => {
  const { rows } = await runner.query(
    `SELECT * FROM orders WHERE owner_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [ownerId, orderId]
  );
  if (!rows[0]) throw new OrdersError(404, "Pedido no encontrado.");
  return rows[0];
};

const updateStatus = async (ownerId, orderId, status) => {
  if (!ORDER_STATUSES.includes(status)) throw new OrdersError(400, "Estado inválido.");
  return withTransaction(async (client) => {
    const order = await getOwnedOrder(client, ownerId, orderId, { lock: true });
    if (order.status === status) return (await withItems([order], client))[0];
    if (!STATUS_TRANSITIONS[order.status].includes(status)) {
      throw new OrdersError(409, "Ese cambio de estado no es posible para este pedido.");
    }
    const column = STATUS_TIMESTAMPS[status];
    const { rows } = await client.query(
      `UPDATE orders SET status = $3, updated_at = now()${column ? `, ${column} = now()` : ""}
       WHERE owner_id = $1 AND id = $2 RETURNING *`,
      [ownerId, orderId, status]
    );
    return (await withItems(rows, client))[0];
  });
};

const assignWaiter = async (ownerId, orderId, waiter) => {
  await getOwnedOrder({ query }, ownerId, orderId);
  const { rows } = await query(
    `UPDATE orders SET waiter_id = $3, waiter_name = $4, updated_at = now()
     WHERE owner_id = $1 AND id = $2 RETURNING *`,
    [ownerId, orderId, waiter?.id ?? null, waiter?.name ?? null]
  );
  return (await withItems(rows))[0];
};

// Pedidos que tomó un mozo en el turno abierto (para su propio seguimiento).
const listWaiterOrders = async (ownerId, waiterId) => {
  const { rows } = await query(
    `SELECT o.* FROM orders o JOIN shifts s ON s.id = o.shift_id
     WHERE o.owner_id = $1 AND o.waiter_id = $2 AND s.closed_at IS NULL
     ORDER BY o.created_at DESC LIMIT 50`,
    [ownerId, waiterId]
  );
  return withItems(rows);
};

module.exports = {
  toOrderDTO,
  createOrder,
  listActiveOrders,
  listOrders,
  updateStatus,
  assignWaiter,
  listWaiterOrders,
};
