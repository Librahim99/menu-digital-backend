// Sesiones de mesa: desde el primer pedido de una mesa hasta que se cierra
// la mesa (la cuenta). Agrupan todos los pedidos de esa estadía, así se
// puede ver el consumo total, la cantidad de pedidos, cuánto duró, etc.
//
// - Se abre sola con el primer pedido de la mesa (de cualquier origen).
// - El operador a cargo es el primero que carga un pedido en ella.
// - La cierra el operador a cargo desde su tomador, o cualquiera desde el
//   panel. Un pedido nuevo en esa mesa después del cierre abre otra sesión.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { ACTIVE_STATUSES, NOT_BILLED_STATUSES, LIMITS } = require("../constants");
const { withItems } = require("./orderDTO");
const realtime = require("../delivery/realtime");

const num = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Sesión abierta de la mesa (la crea si no hay), bloqueada para la transacción.
 * @param {object} client
 * @param {{ ownerId, tableNumber, shiftId, waiter: {id,name}|null }} input
 */
const lockOrOpenTableSession = async (client, { ownerId, tableNumber, shiftId, waiter }) => {
  await client.query(
    `INSERT INTO table_sessions (owner_id, table_number, shift_id, waiter_id, waiter_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (owner_id, table_number) WHERE closed_at IS NULL DO NOTHING`,
    [ownerId, tableNumber, shiftId, waiter?.id ?? null, waiter?.name ?? null]
  );
  const { rows } = await client.query(
    "SELECT * FROM table_sessions WHERE owner_id = $1 AND table_number = $2 AND closed_at IS NULL FOR UPDATE",
    [ownerId, tableNumber]
  );
  const session = rows[0];
  // Mesa abierta por un pedido del comensal o del panel: la toma el primer
  // operador que le carga un pedido.
  if (waiter && session.waiter_id === null) {
    const updated = await client.query(
      "UPDATE table_sessions SET waiter_id = $2, waiter_name = $3, updated_at = now() WHERE id = $1 RETURNING *",
      [session.id, waiter.id, waiter.name]
    );
    return updated.rows[0];
  }
  return session;
};

// Sesiones con sus totales en vivo (las cerradas usan su snapshot).
// $notBilled / $active: posición de esos parámetros en la consulta.
const selectWithTotals = (notBilled, active) => `
  SELECT ts.*,
         count(o.id) FILTER (WHERE NOT (o.status = ANY($${notBilled})))::int AS live_orders_count,
         coalesce(sum(o.total) FILTER (WHERE NOT (o.status = ANY($${notBilled}))), 0) AS live_total,
         count(o.id) FILTER (WHERE o.status = ANY($${active}))::int AS active_orders
  FROM table_sessions ts
  LEFT JOIN orders o ON o.table_session_id = ts.id`;

const toSessionDTO = (row, orders) => ({
  id: Number(row.id),
  tableNumber: row.table_number,
  shiftId: row.shift_id === null ? null : Number(row.shift_id),
  waiterId: row.waiter_id === null ? null : Number(row.waiter_id),
  waiterName: row.waiter_name,
  guests: row.guests,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  closedByType: row.closed_by_type,
  closedByName: row.closed_by_name,
  ordersCount: row.closed_at ? row.orders_count ?? 0 : row.live_orders_count ?? 0,
  totalAmount: row.closed_at ? num(row.total_amount) ?? 0 : num(row.live_total) ?? 0,
  activeOrders: row.active_orders ?? 0,
  ...(orders ? { orders } : {}),
});

// Pedidos de varias sesiones (para mostrar la cuenta de cada mesa).
const attachOrders = async (rows) => {
  if (rows.length === 0) return [];
  const { rows: orderRows } = await query(
    "SELECT * FROM orders WHERE table_session_id = ANY($1) ORDER BY created_at",
    [rows.map((row) => row.id)]
  );
  const orders = await withItems(orderRows);
  const bySession = new Map();
  for (const order of orders) {
    const key = String(order.tableSessionId);
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(order);
  }
  return rows.map((row) => toSessionDTO(row, bySession.get(String(row.id)) ?? []));
};

/**
 * @param {string} ownerId
 * @param {object} filters
 * @param {"open"|"closed"} filters.status
 * @param {number|null} filters.waiterId      solo las de ese operador
 * @param {boolean} filters.includeUnassigned con waiterId: suma las que no tienen operador
 * @param {boolean} filters.withOrders        incluye los pedidos de cada sesión
 */
const listSessions = async (ownerId, {
  status = "open", waiterId = null, includeUnassigned = false, withOrders = false, page = 1, pageSize = 30,
} = {}) => {
  const params = [ownerId];
  const where = ["ts.owner_id = $1", status === "open" ? "ts.closed_at IS NULL" : "ts.closed_at IS NOT NULL"];
  if (waiterId) {
    params.push(waiterId);
    where.push(includeUnassigned ? `(ts.waiter_id = $${params.length} OR ts.waiter_id IS NULL)` : `ts.waiter_id = $${params.length}`);
  }
  const whereSql = where.join(" AND ");
  const order = status === "open" ? "ts.table_number" : "ts.closed_at DESC";
  const offset = (Number(page) - 1) * Number(pageSize);
  const n = params.length;

  const [{ rows }, count] = await Promise.all([
    query(
      `${selectWithTotals(n + 1, n + 2)} WHERE ${whereSql} GROUP BY ts.id ORDER BY ${order} LIMIT ${Number(pageSize)} OFFSET ${offset}`,
      [...params, NOT_BILLED_STATUSES, ACTIVE_STATUSES]
    ),
    query(`SELECT count(*)::int AS total FROM table_sessions ts WHERE ${whereSql}`, params),
  ]);

  const sessions = withOrders ? await attachOrders(rows) : rows.map((row) => toSessionDTO(row));
  return { sessions, total: count.rows[0].total, page, pageSize };
};

const getSessionRow = async (runner, ownerId, sessionId, { lock = false } = {}) => {
  const { rows } = await runner.query(
    `SELECT * FROM table_sessions WHERE owner_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [ownerId, sessionId]
  );
  if (!rows[0]) throw new OrdersError(404, "Mesa no encontrada.");
  return rows[0];
};

const getSession = async (ownerId, sessionId) => {
  const { rows } = await query(
    `${selectWithTotals(3, 4)} WHERE ts.owner_id = $1 AND ts.id = $2 GROUP BY ts.id`,
    [ownerId, sessionId, NOT_BILLED_STATUSES, ACTIVE_STATUSES]
  );
  if (!rows[0]) throw new OrdersError(404, "Mesa no encontrada.");
  return (await attachOrders(rows))[0];
};

// Un operador solo maneja sus mesas (o las que todavía no tomó nadie).
const assertWaiterCanManage = (session, waiterId) => {
  if (waiterId && session.waiter_id !== null && Number(session.waiter_id) !== Number(waiterId)) {
    throw new OrdersError(403, "Esta mesa la atiende otro operador.");
  }
};

/**
 * Cierra la mesa y congela su consumo. Con pedidos sin entregar pide `force`.
 * @param {{ force?: boolean, actor: { type: "waiter"|"panel", name: string|null }, waiterId?: number|null }} options
 */
const closeSession = async (ownerId, sessionId, { force = false, actor, waiterId = null }) => {
  await withTransaction(async (client) => {
    const session = await getSessionRow(client, ownerId, sessionId, { lock: true });
    if (session.closed_at) throw new OrdersError(409, "Esta mesa ya está cerrada.");
    assertWaiterCanManage(session, waiterId);

    const { rows: [totals] } = await client.query(
      `SELECT count(*) FILTER (WHERE NOT (status = ANY($2)))::int AS count,
              coalesce(sum(total) FILTER (WHERE NOT (status = ANY($2))), 0) AS amount,
              count(*) FILTER (WHERE status = ANY($3))::int AS active
       FROM orders WHERE table_session_id = $1`,
      [session.id, NOT_BILLED_STATUSES, ACTIVE_STATUSES]
    );
    if (totals.active > 0 && !force) {
      throw new OrdersError(409, `La mesa tiene ${totals.active} pedido(s) sin entregar.`, "ACTIVE_ORDERS");
    }
    await client.query(
      `UPDATE table_sessions SET closed_at = now(), updated_at = now(), closed_by_type = $2, closed_by_name = $3,
         orders_count = $4, total_amount = $5 WHERE id = $1`,
      [session.id, actor.type, actor.name, totals.count, totals.amount]
    );
  });
  realtime.emit({ ownerId, event: "table", staff: true });
  return getSession(ownerId, sessionId);
};

// Cantidad de comensales de la mesa (para consumo por persona).
const setGuests = async (ownerId, sessionId, guests, { waiterId = null } = {}) => {
  let value = null;
  if (guests !== null && guests !== undefined && guests !== "") {
    value = Number(guests);
    if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.maxGuests) {
      throw new OrdersError(400, `Los comensales tienen que ser entre 1 y ${LIMITS.maxGuests}.`);
    }
  }
  const session = await getSessionRow({ query }, ownerId, sessionId);
  assertWaiterCanManage(session, waiterId);
  await query("UPDATE table_sessions SET guests = $2, updated_at = now() WHERE id = $1", [sessionId, value]);
  realtime.emit({ ownerId, event: "table", staff: true });
  return getSession(ownerId, sessionId);
};

module.exports = {
  lockOrOpenTableSession,
  listSessions,
  getSession,
  closeSession,
  setGuests,
};
