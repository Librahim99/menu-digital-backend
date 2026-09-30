// Cajas y sesiones de caja, separadas del turno.
//
// Un local tiene una o más cajas (cash_registers). Cada caja se abre y se
// cierra por su cuenta (cash_sessions), con su cajero y su fondo inicial:
// se puede cerrar la caja y abrir otra con otro cajero sin cerrar el turno,
// o cerrar el turno y seguir con la misma caja.
//
// Cada pedido queda asociado a la caja abierta al momento de cargarlo (si
// no hay ninguna, se abre sola la caja principal, como el turno). Al cerrar
// una caja se congela su resultado; una devolución posterior se registra en
// la caja abierta en ese momento, no reescribe una caja ya cerrada.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { ACTIVE_STATUSES, LIMITS } = require("../constants");
const { cleanText, optionalMoney } = require("../utils/validate");

const num = (value) => (value === null || value === undefined ? null : Number(value));
const round = (value) => Math.round(value * 100) / 100;

// Serializa las aperturas de caja de un local dentro de la transacción.
const lockOwner = (client, ownerId) =>
  client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`orders:cash:${ownerId}`]);

const toRegisterDTO = (row) => ({
  id: Number(row.id),
  name: row.name,
  active: row.active,
  createdAt: row.created_at,
});

// Caja principal del local (la activa más antigua). La crea si no hay.
const ensureDefaultRegister = async (client, ownerId) => {
  const { rows } = await client.query(
    "SELECT * FROM cash_registers WHERE owner_id = $1 AND active AND deleted_at IS NULL ORDER BY id LIMIT 1",
    [ownerId]
  );
  if (rows[0]) return rows[0];
  const inserted = await client.query(
    "INSERT INTO cash_registers (owner_id, name) VALUES ($1, 'Caja principal') RETURNING *",
    [ownerId]
  );
  return inserted.rows[0];
};

// ── Resultado de una caja ────────────────────
// Vendido: pedidos de la caja no anulados (aunque después se devuelvan: la
// devolución se descuenta aparte, en la caja donde se registró).
const computeSummary = async (runner, session) => {
  const sales = await runner.query(
    `SELECT count(*)::int AS orders_count,
            count(*) FILTER (WHERE status <> 'cancelled')::int AS sales_count,
            coalesce(sum(total) FILTER (WHERE status <> 'cancelled'), 0) AS sales_amount,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
            coalesce(sum(total) FILTER (WHERE status = 'cancelled'), 0) AS cancelled_amount,
            coalesce(sum(discount_amount) FILTER (WHERE status <> 'cancelled'), 0) AS discounts_amount,
            count(*) FILTER (WHERE status = ANY($2))::int AS pending_count
     FROM orders WHERE cash_session_id = $1`,
    [session.id, ACTIVE_STATUSES]
  );
  const returns = await runner.query(
    `SELECT count(*)::int AS count, coalesce(sum(total), 0) AS amount
     FROM orders WHERE returned_cash_session_id = $1 AND status = 'returned'`,
    [session.id]
  );
  const payments = await runner.query(
    `SELECT method_name, method_kind, count(*)::int AS count, coalesce(sum(amount), 0) AS amount
     FROM payments WHERE cash_session_id = $1 AND status = 'approved'
     GROUP BY 1, 2 ORDER BY amount DESC`,
    [session.id]
  );

  const s = sales.rows[0];
  const salesAmount = Number(s.sales_amount);
  const returnedAmount = Number(returns.rows[0].amount);
  const netAmount = round(salesAmount - returnedAmount);
  const paymentsBreakdown = payments.rows.map((row) => ({
    method: row.method_name, kind: row.method_kind, count: row.count, amount: Number(row.amount),
  }));
  // Todavía no se registran cobros: sin cobros, se espera en caja todo lo
  // vendido neto. Cuando existan, solo lo cobrado en efectivo.
  const cashIn = paymentsBreakdown.length > 0
    ? paymentsBreakdown.filter((row) => row.kind === "cash").reduce((sum, row) => sum + row.amount, 0)
    : netAmount;

  return {
    ordersCount: s.orders_count,
    salesCount: s.sales_count,
    salesAmount: round(salesAmount),
    cancelledCount: s.cancelled_count,
    cancelledAmount: round(Number(s.cancelled_amount)),
    returnedCount: returns.rows[0].count,
    returnedAmount: round(returnedAmount),
    discountsAmount: round(Number(s.discounts_amount)),
    netAmount,
    expectedCash: round(Number(session.opening_amount) + cashIn),
    paymentsBreakdown,
    pendingCount: s.pending_count,
  };
};

const summaryFromSnapshot = (row) => ({
  ordersCount: row.orders_count ?? 0,
  salesCount: row.sales_count ?? 0,
  salesAmount: num(row.sales_amount) ?? 0,
  cancelledCount: row.cancelled_count ?? 0,
  cancelledAmount: num(row.cancelled_amount) ?? 0,
  returnedCount: row.returned_count ?? 0,
  returnedAmount: num(row.returned_amount) ?? 0,
  discountsAmount: num(row.discounts_amount) ?? 0,
  netAmount: num(row.net_amount) ?? 0,
  expectedCash: num(row.expected_cash) ?? 0,
  paymentsBreakdown: row.payments_breakdown ?? [],
  pendingCount: 0,
});

const toCashSessionDTO = (row, liveSummary = null) => ({
  id: Number(row.id),
  registerId: Number(row.register_id),
  registerName: row.register_name,
  shiftId: row.shift_id === null ? null : Number(row.shift_id),
  cashierName: row.cashier_name,
  openingAmount: num(row.opening_amount) ?? 0,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  cashCounted: num(row.cash_counted),
  difference: num(row.difference),
  closingNotes: row.closing_notes,
  summary: row.closed_at ? summaryFromSnapshot(row) : liveSummary,
});

// ── Asignación de pedidos ────────────────────

/**
 * Caja abierta a la que va un pedido (o una devolución), bloqueada para la
 * transacción. Prefiere la caja principal; si no hay ninguna abierta, abre
 * la principal sin cajero (se puede completar después).
 */
const lockOrOpenCashSession = async (client, ownerId, shiftId = null) => {
  await lockOwner(client, ownerId);
  const register = await ensureDefaultRegister(client, ownerId);
  const open = await client.query(
    `SELECT * FROM cash_sessions WHERE owner_id = $1 AND closed_at IS NULL
     ORDER BY (register_id = $2) DESC, opened_at DESC LIMIT 1 FOR UPDATE`,
    [ownerId, register.id]
  );
  if (open.rows[0]) return open.rows[0];
  const shift = shiftId ?? (await client.query(
    "SELECT id FROM shifts WHERE owner_id = $1 AND closed_at IS NULL", [ownerId]
  )).rows[0]?.id ?? null;
  const { rows } = await client.query(
    `INSERT INTO cash_sessions (owner_id, register_id, register_name, shift_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [ownerId, register.id, register.name, shift]
  );
  return rows[0];
};

// ── Cajas ────────────────────────────────────

const listRegisters = async (ownerId) => {
  await withTransaction(async (client) => {
    await lockOwner(client, ownerId);
    await ensureDefaultRegister(client, ownerId);
  });
  const { rows } = await query(
    "SELECT * FROM cash_registers WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY id",
    [ownerId]
  );
  return rows.map(toRegisterDTO);
};

const getRegister = async (runner, ownerId, registerId) => {
  const { rows } = await runner.query(
    "SELECT * FROM cash_registers WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL",
    [ownerId, registerId]
  );
  if (!rows[0]) throw new OrdersError(404, "Caja no encontrada.");
  return rows[0];
};

const createRegister = async (ownerId, body = {}) => {
  const name = cleanText(body.name, LIMITS.registerNameLength);
  if (!name) throw new OrdersError(400, "La caja necesita un nombre.");
  const { rows } = await query(
    "INSERT INTO cash_registers (owner_id, name) VALUES ($1, $2) RETURNING *",
    [ownerId, name]
  );
  return toRegisterDTO(rows[0]);
};

const updateRegister = async (ownerId, registerId, body = {}) => {
  const current = await getRegister({ query }, ownerId, registerId);
  const name = body.name === undefined ? current.name : cleanText(body.name, LIMITS.registerNameLength);
  if (!name) throw new OrdersError(400, "La caja necesita un nombre.");
  let active = current.active;
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw new OrdersError(400, "Estado inválido.");
    active = body.active;
  }
  if (!active) {
    const open = await query("SELECT 1 FROM cash_sessions WHERE register_id = $1 AND closed_at IS NULL", [registerId]);
    if (open.rows[0]) throw new OrdersError(409, "Cerrá esa caja antes de desactivarla.");
    const others = await query(
      "SELECT count(*)::int AS count FROM cash_registers WHERE owner_id = $1 AND id <> $2 AND active AND deleted_at IS NULL",
      [ownerId, registerId]
    );
    if (others.rows[0].count === 0) throw new OrdersError(409, "Tiene que quedar al menos una caja activa.");
  }
  const { rows } = await query(
    "UPDATE cash_registers SET name = $3, active = $4, updated_at = now() WHERE owner_id = $1 AND id = $2 RETURNING *",
    [ownerId, registerId, name, active]
  );
  return toRegisterDTO(rows[0]);
};

// ── Sesiones de caja ─────────────────────────

const getSessionRow = async (runner, ownerId, sessionId, { lock = false } = {}) => {
  const { rows } = await runner.query(
    `SELECT * FROM cash_sessions WHERE owner_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [ownerId, sessionId]
  );
  if (!rows[0]) throw new OrdersError(404, "Caja no encontrada.");
  return rows[0];
};

// Cajas abiertas del local, con su resultado en vivo.
const listOpenSessions = async (ownerId) => {
  const { rows } = await query(
    "SELECT * FROM cash_sessions WHERE owner_id = $1 AND closed_at IS NULL ORDER BY opened_at",
    [ownerId]
  );
  return Promise.all(rows.map(async (row) => toCashSessionDTO(row, await computeSummary({ query }, row))));
};

const getSession = async (ownerId, sessionId) => {
  const row = await getSessionRow({ query }, ownerId, sessionId);
  return toCashSessionDTO(row, row.closed_at ? null : await computeSummary({ query }, row));
};

const readCashier = (body) => cleanText(body.cashierName, LIMITS.cashierNameLength);

const openSession = async (ownerId, body = {}) => withTransaction(async (client) => {
  await lockOwner(client, ownerId);
  const register = body.registerId
    ? await getRegister(client, ownerId, body.registerId)
    : await ensureDefaultRegister(client, ownerId);
  if (!register.active) throw new OrdersError(409, "Esa caja está desactivada.");
  const open = await client.query("SELECT 1 FROM cash_sessions WHERE register_id = $1 AND closed_at IS NULL", [register.id]);
  if (open.rows[0]) throw new OrdersError(409, `La ${register.name} ya está abierta.`, "CASH_ALREADY_OPEN");

  const shift = await client.query("SELECT id FROM shifts WHERE owner_id = $1 AND closed_at IS NULL", [ownerId]);
  const { rows } = await client.query(
    `INSERT INTO cash_sessions (owner_id, register_id, register_name, shift_id, cashier_name, opening_amount)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ownerId, register.id, register.name, shift.rows[0]?.id ?? null, readCashier(body),
      optionalMoney(body.openingAmount, "El fondo inicial") ?? 0]
  );
  return toCashSessionDTO(rows[0], await computeSummary(client, rows[0]));
});

// Cajero y fondo de una caja abierta (ej. la que se abrió sola con un pedido).
const updateSession = async (ownerId, sessionId, body = {}) => withTransaction(async (client) => {
  const row = await getSessionRow(client, ownerId, sessionId, { lock: true });
  if (row.closed_at) throw new OrdersError(409, "Esa caja ya está cerrada.");
  const cashier = body.cashierName === undefined ? row.cashier_name : readCashier(body);
  const opening = body.openingAmount === undefined
    ? row.opening_amount
    : optionalMoney(body.openingAmount, "El fondo inicial") ?? 0;
  const { rows } = await client.query(
    "UPDATE cash_sessions SET cashier_name = $3, opening_amount = $4, updated_at = now() WHERE owner_id = $1 AND id = $2 RETURNING *",
    [ownerId, sessionId, cashier, opening]
  );
  return toCashSessionDTO(rows[0], await computeSummary(client, rows[0]));
});

// Cierre: congela el resultado del momento. No toca el turno.
const closeSession = async (ownerId, sessionId, body = {}) => withTransaction(async (client) => {
  const row = await getSessionRow(client, ownerId, sessionId, { lock: true });
  if (row.closed_at) throw new OrdersError(409, "Esa caja ya está cerrada.");

  const cashCounted = optionalMoney(body.cashCounted, "El efectivo contado");
  const summary = await computeSummary(client, row);
  const difference = cashCounted === null ? null : round(cashCounted - summary.expectedCash);

  const { rows } = await client.query(
    `UPDATE cash_sessions SET closed_at = now(), updated_at = now(),
       orders_count = $3, sales_count = $4, sales_amount = $5, cancelled_count = $6, cancelled_amount = $7,
       returned_count = $8, returned_amount = $9, discounts_amount = $10, net_amount = $11,
       expected_cash = $12, cash_counted = $13, difference = $14, payments_breakdown = $15::jsonb,
       closing_notes = $16
     WHERE owner_id = $1 AND id = $2 RETURNING *`,
    [ownerId, sessionId, summary.ordersCount, summary.salesCount, summary.salesAmount, summary.cancelledCount,
      summary.cancelledAmount, summary.returnedCount, summary.returnedAmount, summary.discountsAmount,
      summary.netAmount, summary.expectedCash, cashCounted, difference, JSON.stringify(summary.paymentsBreakdown),
      cleanText(body.notes, 300)]
  );
  return toCashSessionDTO(rows[0]);
});

// Cajas cerradas, de la más reciente a la más vieja.
const listClosedSessions = async (ownerId, { page = 1, pageSize = 20 } = {}) => {
  const offset = (page - 1) * pageSize;
  const [{ rows }, count] = await Promise.all([
    query(
      "SELECT * FROM cash_sessions WHERE owner_id = $1 AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT $2 OFFSET $3",
      [ownerId, pageSize, offset]
    ),
    query("SELECT count(*)::int AS total FROM cash_sessions WHERE owner_id = $1 AND closed_at IS NOT NULL", [ownerId]),
  ]);
  return { sessions: rows.map((row) => toCashSessionDTO(row)), total: count.rows[0].total, page, pageSize };
};

module.exports = {
  lockOrOpenCashSession,
  listRegisters,
  createRegister,
  updateRegister,
  listOpenSessions,
  getSession,
  openSession,
  updateSession,
  closeSession,
  listClosedSessions,
};
