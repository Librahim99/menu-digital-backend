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
// la caja abierta en ese momento, no reescribe una caja ya cerrada. Lo mismo
// si se anula un pedido cuya caja ya cerró (quedó en curso al cerrarla): se
// descuenta en la caja abierta, como una devolución.
//
// La plata que entra o sale del cajón sin ser una venta (un proveedor, un
// retiro) se carga como movimiento (cash_movements) y cuenta para el efectivo
// esperado. El cierre lleva arqueo: efectivo contado, lo que se retira y lo
// que queda, que es el fondo de la próxima apertura.
//
// Lo que se muestra sale ya resuelto de acá (resumen, libro de movimientos,
// historial filtrado y sus totales): el panel no recalcula nada.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { ACTIVE_STATUSES, LIMITS, CASH_MOVEMENT_TYPES, CASH_MOVEMENT_CATEGORIES } = require("../constants");
const { cleanText, optionalMoney, positiveMoney, optionalUuid, positiveInt } = require("../utils/validate");
const { TIMEZONE_BA } = require("../../utils/dates");

const num = (value) => (value === null || value === undefined ? null : Number(value));
const round = (value) => Math.round(value * 100) / 100;
const optionalId = (value) => (value === null || value === undefined ? null : Number(value));

// Serializa las aperturas de caja de un local dentro de la transacción.
const lockOwner = (client, ownerId) =>
  client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`orders:cash:${ownerId}`]);

// openSessionId y suggestedOpening solo vienen cuando la consulta los trae
// (REGISTERS_SQL): el fondo sugerido es lo que quedó en el cajón al cerrar
// esa caja por última vez.
const toRegisterDTO = (row) => ({
  id: Number(row.id),
  name: row.name,
  active: row.active,
  createdAt: row.created_at,
  openSessionId: optionalId(row.open_session_id),
  suggestedOpening: num(row.last_cash_left) ?? 0,
});

const REGISTERS_SQL = `
  SELECT r.*,
    (SELECT s.id FROM cash_sessions s WHERE s.register_id = r.id AND s.closed_at IS NULL LIMIT 1) AS open_session_id,
    (SELECT s.cash_left FROM cash_sessions s WHERE s.register_id = r.id AND s.closed_at IS NOT NULL
     ORDER BY s.closed_at DESC LIMIT 1) AS last_cash_left
  FROM cash_registers r WHERE r.owner_id = $1 AND r.deleted_at IS NULL ORDER BY r.id`;

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
// devolución se descuenta aparte, en la caja donde se registró). Con las
// devoluciones van las anulaciones de pedidos de una caja ya cerrada.
//
// Efectivo esperado = fondo inicial + ventas en efectivo + ingresos − egresos
// − retiros. Las ventas en efectivo son lo vendido neto menos lo que no pasa
// por el cajón: lo cobrado online (Mercado Pago) y lo que el personal anotó
// con tarjeta, transferencia, etc. Lo que no tiene un cobro anotado se asume
// en efectivo.
const computeSummary = async (runner, session) => {
  const sales = await runner.query(
    `SELECT count(*)::int AS orders_count,
            count(*) FILTER (WHERE status <> 'cancelled')::int AS sales_count,
            coalesce(sum(total) FILTER (WHERE status <> 'cancelled'), 0) AS sales_amount,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
            coalesce(sum(total) FILTER (WHERE status = 'cancelled'), 0) AS cancelled_amount,
            coalesce(sum(discount_amount) FILTER (WHERE status <> 'cancelled'), 0) AS discounts_amount,
            count(*) FILTER (WHERE status = ANY($2))::int AS pending_count,
            count(*) FILTER (WHERE status <> 'cancelled' AND payment_mode = 'mercadopago')::int AS online_count,
            coalesce(sum(total) FILTER (WHERE status <> 'cancelled' AND payment_mode = 'mercadopago'), 0) AS online_amount
     FROM orders WHERE cash_session_id = $1`,
    [session.id, ACTIVE_STATUSES]
  );
  const returns = await runner.query(
    `SELECT count(*)::int AS count, coalesce(sum(total), 0) AS amount,
            coalesce(sum(total) FILTER (WHERE payment_mode = 'mercadopago'), 0) AS online_amount
     FROM orders WHERE returned_cash_session_id = $1 AND status IN ('returned', 'cancelled')`,
    [session.id]
  );
  const payments = await runner.query(
    `SELECT method_name, method_kind, count(*)::int AS count, coalesce(sum(amount), 0) AS amount
     FROM payments WHERE cash_session_id = $1 AND status = 'approved'
     GROUP BY 1, 2 ORDER BY amount DESC`,
    [session.id]
  );
  const movements = await runner.query(
    `SELECT type, count(*)::int AS count, coalesce(sum(amount), 0) AS amount
     FROM cash_movements WHERE cash_session_id = $1 AND voided_at IS NULL AND type <> 'fund_adjustment'
     GROUP BY type`,
    [session.id]
  );

  const s = sales.rows[0];
  const salesAmount = Number(s.sales_amount);
  const returnedAmount = Number(returns.rows[0].amount);
  const netAmount = round(salesAmount - returnedAmount);
  const paymentsBreakdown = payments.rows.map((row) => ({
    method: row.method_name, kind: row.method_kind, count: row.count, amount: Number(row.amount),
  }));
  const nonCash = paymentsBreakdown.filter((row) => row.kind !== "cash").reduce((sum, row) => sum + row.amount, 0);
  // La devolución de un pedido pagado online tampoco sale del cajón.
  const onlineAmount = round(Number(s.online_amount) - Number(returns.rows[0].online_amount));
  if (s.online_count > 0) {
    paymentsBreakdown.push({
      method: "Mercado Pago (online)", kind: "mercadopago", count: s.online_count, amount: Number(s.online_amount),
    });
  }
  const moved = Object.fromEntries(movements.rows.map((row) => [row.type, row]));
  const movedAmount = (type) => round(Number(moved[type]?.amount ?? 0));
  const cashSalesAmount = round(netAmount - onlineAmount - nonCash);

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
    onlineAmount,
    cashSalesAmount,
    incomeAmount: movedAmount("income"),
    expenseAmount: movedAmount("expense"),
    withdrawalAmount: movedAmount("withdrawal"),
    movementsCount: movements.rows.reduce((sum, row) => sum + row.count, 0),
    expectedCash: round(
      Number(session.opening_amount) + cashSalesAmount + movedAmount("income") - movedAmount("expense") - movedAmount("withdrawal")
    ),
    paymentsBreakdown,
    pendingCount: s.pending_count,
  };
};

// Los cierres anteriores a la migración 010 no tienen movimientos ni lo cobrado online.
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
  onlineAmount: num(row.online_amount) ?? 0,
  cashSalesAmount: num(row.cash_sales_amount) ?? round((num(row.expected_cash) ?? 0) - (num(row.opening_amount) ?? 0)),
  incomeAmount: num(row.income_amount) ?? 0,
  expenseAmount: num(row.expense_amount) ?? 0,
  withdrawalAmount: num(row.withdrawal_amount) ?? 0,
  movementsCount: 0,
  expectedCash: num(row.expected_cash) ?? 0,
  paymentsBreakdown: row.payments_breakdown ?? [],
  pendingCount: 0,
});

const toCashSessionDTO = (row, liveSummary = null) => ({
  id: Number(row.id),
  registerId: Number(row.register_id),
  registerName: row.register_name,
  shiftId: row.shift_id === null ? null : Number(row.shift_id),
  cashierId: optionalId(row.cashier_id),
  cashierName: row.cashier_name,
  openingAmount: num(row.opening_amount) ?? 0,
  openedAt: row.opened_at,
  openedByName: row.opened_by_name ?? null,
  closedAt: row.closed_at,
  closedByName: row.closed_by_name ?? null,
  cashCounted: num(row.cash_counted),
  difference: num(row.difference),
  cashWithdrawn: num(row.cash_withdrawn),
  cashLeft: num(row.cash_left),
  closingNotes: row.closing_notes,
  summary: row.closed_at ? summaryFromSnapshot(row) : liveSummary,
});

// ── Apertura ─────────────────────────────────

// Lo que quedó en el cajón la última vez que se cerró esa caja.
const suggestedOpening = async (client, registerId) => {
  const { rows } = await client.query(
    "SELECT cash_left FROM cash_sessions WHERE register_id = $1 AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1",
    [registerId]
  );
  return num(rows[0]?.cash_left) ?? 0;
};

/**
 * Abre una caja (con el local ya bloqueado).
 * @param {{ cashier?: {id, name}|null, openingAmount?: number, shiftId?: number|null, actor?: {type, name}|null }} input
 *   Sin openingAmount, el fondo es lo que quedó del último cierre de esa caja.
 */
const insertSession = async (client, ownerId, register, { cashier = null, openingAmount, shiftId = null, actor = null } = {}) => {
  const shift = shiftId ?? (await client.query(
    "SELECT id FROM shifts WHERE owner_id = $1 AND closed_at IS NULL", [ownerId]
  )).rows[0]?.id ?? null;
  const { rows } = await client.query(
    `INSERT INTO cash_sessions (owner_id, register_id, register_name, shift_id, cashier_id, cashier_name, opening_amount,
       opened_by_type, opened_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [ownerId, register.id, register.name, shift, cashier?.id ?? null, cashier?.name ?? null,
      openingAmount ?? await suggestedOpening(client, register.id), actor?.type ?? "system", actor?.name ?? null]
  );
  return rows[0];
};

/**
 * Caja abierta a la que va un pedido (o un cobro, o una devolución), bloqueada
 * para la transacción. Prefiere la caja principal; si no hay ninguna abierta,
 * abre la principal sin cajero (se puede completar después) y con el fondo
 * que quedó del último cierre.
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
  return insertSession(client, ownerId, register, { shiftId });
};

// ── Cajas ────────────────────────────────────

const listRegisters = async (ownerId) => {
  await withTransaction(async (client) => {
    await lockOwner(client, ownerId);
    await ensureDefaultRegister(client, ownerId);
  });
  const { rows } = await query(REGISTERS_SQL, [ownerId]);
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

/**
 * Cajero de una caja: un operador del local (`cashierId`, se guarda también
 * su nombre) o, si no es un operador, un nombre a mano (`cashierName`). Sin
 * ninguno de los dos queda el que estaba.
 */
const resolveCashier = async (runner, ownerId, body, current = null) => {
  if (body.cashierId !== undefined && body.cashierId !== null && body.cashierId !== "") {
    const { rows } = await runner.query(
      "SELECT id, name FROM waiters WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL",
      [ownerId, positiveInt(body.cashierId, { field: "Cajero" })]
    );
    if (!rows[0]) throw new OrdersError(404, "Ese operador ya no existe.");
    return { id: Number(rows[0].id), name: rows[0].name };
  }
  if (body.cashierId === undefined && body.cashierName === undefined) return current;
  return { id: null, name: cleanText(body.cashierName, LIMITS.cashierNameLength) };
};

/**
 * Abre una caja. Sin `openingAmount` el fondo inicial es lo que quedó en el
 * cajón al cerrarla por última vez.
 * @param {{ registerId?, cashierId?, cashierName?, openingAmount? }} body
 */
const openSession = async (ownerId, body = {}, actor = null) => withTransaction(async (client) => {
  await lockOwner(client, ownerId);
  const register = body.registerId
    ? await getRegister(client, ownerId, body.registerId)
    : await ensureDefaultRegister(client, ownerId);
  if (!register.active) throw new OrdersError(409, "Esa caja está desactivada.");
  const open = await client.query("SELECT 1 FROM cash_sessions WHERE register_id = $1 AND closed_at IS NULL", [register.id]);
  if (open.rows[0]) throw new OrdersError(409, `La ${register.name} ya está abierta.`, "CASH_ALREADY_OPEN");

  const row = await insertSession(client, ownerId, register, {
    cashier: await resolveCashier(client, ownerId, body),
    openingAmount: optionalMoney(body.openingAmount, "El fondo inicial") ?? undefined,
    actor,
  });
  return toCashSessionDTO(row, await computeSummary(client, row));
});

const insertMovement = async (client, session, { type, category = "other", amount, notes = null, actor = null, key = null }) => {
  const { rows } = await client.query(
    `INSERT INTO cash_movements (owner_id, cash_session_id, type, category, amount, notes, actor_type, actor_id, actor_name, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [session.owner_id, session.id, type, category, amount, notes, actor?.type ?? "system",
      actor?.id == null ? null : String(actor.id), actor?.name ?? null, key]
  );
  return rows[0];
};

// Cajero y fondo de una caja abierta (ej. la que se abrió sola con un pedido).
// Cambiar el fondo deja el rastro en el libro de la caja.
const updateSession = async (ownerId, sessionId, body = {}, actor = null) => withTransaction(async (client) => {
  const row = await getSessionRow(client, ownerId, sessionId, { lock: true });
  if (row.closed_at) throw new OrdersError(409, "Esa caja ya está cerrada.");
  const cashier = await resolveCashier(client, ownerId, body, { id: row.cashier_id, name: row.cashier_name });
  const opening = body.openingAmount === undefined
    ? Number(row.opening_amount)
    : optionalMoney(body.openingAmount, "El fondo inicial") ?? 0;
  const { rows } = await client.query(
    `UPDATE cash_sessions SET cashier_id = $3, cashier_name = $4, opening_amount = $5, updated_at = now()
     WHERE owner_id = $1 AND id = $2 RETURNING *`,
    [ownerId, sessionId, cashier?.id ?? null, cashier?.name ?? null, opening]
  );
  if (opening !== Number(row.opening_amount)) {
    await insertMovement(client, row, {
      type: "fund_adjustment", amount: opening, notes: `Antes: $${Number(row.opening_amount)}`, actor,
    });
  }
  return toCashSessionDTO(rows[0], await computeSummary(client, rows[0]));
});

/**
 * Cierre con arqueo: congela el resultado del momento. No toca el turno.
 * - `cashCounted` (obligatorio): el efectivo que hay en el cajón.
 * - `cashWithdrawn`: lo que se retira al cerrar. El resto queda en el cajón y
 *   es el fondo sugerido de la próxima apertura de esa caja.
 * Los pedidos todavía en curso quedan en este cierre (se cargaron en esta caja).
 */
const closeSession = async (ownerId, sessionId, body = {}, actor = null) => withTransaction(async (client) => {
  const row = await getSessionRow(client, ownerId, sessionId, { lock: true });
  if (row.closed_at) throw new OrdersError(409, "Esa caja ya está cerrada.");

  const cashCounted = optionalMoney(body.cashCounted, "El efectivo contado");
  if (cashCounted === null) {
    throw new OrdersError(400, "Contá el efectivo que hay en la caja para cerrarla.", "CASH_COUNT_REQUIRED");
  }
  const cashWithdrawn = optionalMoney(body.cashWithdrawn, "El retiro") ?? 0;
  if (cashWithdrawn > cashCounted) throw new OrdersError(400, "No se puede retirar más de lo que hay en la caja.");

  const summary = await computeSummary(client, row);
  const { rows } = await client.query(
    `UPDATE cash_sessions SET closed_at = now(), updated_at = now(),
       orders_count = $3, sales_count = $4, sales_amount = $5, cancelled_count = $6, cancelled_amount = $7,
       returned_count = $8, returned_amount = $9, discounts_amount = $10, net_amount = $11,
       expected_cash = $12, cash_counted = $13, difference = $14, payments_breakdown = $15::jsonb,
       closing_notes = $16, income_amount = $17, expense_amount = $18, withdrawal_amount = $19, online_amount = $20,
       cash_sales_amount = $21, cash_withdrawn = $22, cash_left = $23, closed_by_type = $24, closed_by_name = $25
     WHERE owner_id = $1 AND id = $2 RETURNING *`,
    [ownerId, sessionId, summary.ordersCount, summary.salesCount, summary.salesAmount, summary.cancelledCount,
      summary.cancelledAmount, summary.returnedCount, summary.returnedAmount, summary.discountsAmount,
      summary.netAmount, summary.expectedCash, cashCounted, round(cashCounted - summary.expectedCash),
      JSON.stringify(summary.paymentsBreakdown), cleanText(body.notes, 300), summary.incomeAmount, summary.expenseAmount,
      summary.withdrawalAmount, summary.onlineAmount, summary.cashSalesAmount, cashWithdrawn,
      round(cashCounted - cashWithdrawn), actor?.type ?? "system", actor?.name ?? null]
  );
  return toCashSessionDTO(rows[0]);
});

// ── Movimientos ──────────────────────────────

const findMovementByKey = async (runner, ownerId, key) => {
  const { rows } = await runner.query("SELECT * FROM cash_movements WHERE owner_id = $1 AND idempotency_key = $2", [ownerId, key]);
  return rows[0] ?? null;
};

const liveSession = async (runner, ownerId, sessionId) => {
  const row = await getSessionRow(runner, ownerId, sessionId);
  return toCashSessionDTO(row, await computeSummary(runner, row));
};

/**
 * Registra plata que entra o sale del cajón sin ser una venta.
 * @param {{ type: "income"|"expense"|"withdrawal", category?, amount, notes?, idempotencyKey? }} body
 * @returns {{ session, duplicate }}  la caja con el resultado ya actualizado
 */
const addMovement = async (ownerId, sessionId, body = {}, actor = null) => {
  const type = body.type;
  if (!Object.prototype.hasOwnProperty.call(CASH_MOVEMENT_TYPES, type)) throw new OrdersError(400, "Elegí el tipo de movimiento.");
  const category = body.category ?? "other";
  if (!Object.prototype.hasOwnProperty.call(CASH_MOVEMENT_CATEGORIES[type], category)) throw new OrdersError(400, "Concepto inválido.");
  const amount = positiveMoney(body.amount, "Importe");
  const notes = cleanText(body.notes, LIMITS.cashNotesLength);
  const key = optionalUuid(body.idempotencyKey);

  try {
    return await withTransaction(async (client) => {
      const session = await getSessionRow(client, ownerId, sessionId, { lock: true });
      if (key && await findMovementByKey(client, ownerId, key)) {
        return { session: await liveSession(client, ownerId, sessionId), duplicate: true };
      }
      if (session.closed_at) throw new OrdersError(409, "Esa caja ya está cerrada.");
      await insertMovement(client, session, { type, category, amount, notes, actor, key });
      return { session: await liveSession(client, ownerId, sessionId), duplicate: false };
    });
  } catch (error) {
    // Dos reintentos simultáneos: el segundo choca con el UNIQUE de idempotency_key.
    if (error.code === "23505" && key && await findMovementByKey({ query }, ownerId, key)) {
      return { session: await liveSession({ query }, ownerId, sessionId), duplicate: true };
    }
    throw error;
  }
};

// Anula un movimiento mal cargado (no se borra). Solo con la caja abierta:
// un cierre ya congelado no se reescribe.
const voidMovement = async (ownerId, movementId, body = {}, actor = null) => withTransaction(async (client) => {
  const { rows } = await client.query(
    "SELECT * FROM cash_movements WHERE owner_id = $1 AND id = $2 FOR UPDATE",
    [ownerId, movementId]
  );
  const movement = rows[0];
  if (!movement || movement.type === "fund_adjustment") throw new OrdersError(404, "Movimiento no encontrado.");
  const session = await getSessionRow(client, ownerId, movement.cash_session_id, { lock: true });
  if (session.closed_at) throw new OrdersError(409, "Esa caja ya está cerrada: el movimiento no se puede anular.");
  if (!movement.voided_at) {
    await client.query(
      "UPDATE cash_movements SET voided_at = now(), void_reason = $2, voided_by_name = $3 WHERE id = $1",
      [movement.id, cleanText(body.reason, LIMITS.statusReasonLength), actor?.name ?? null]
    );
  }
  return { session: await liveSession(client, ownerId, session.id) };
});

// ── Libro de la caja ─────────────────────────
// Todo lo que movió plata en una caja, de un solo lado: la apertura, los
// cobros anotados, las devoluciones, los movimientos manuales y el cierre.
// Las ventas sin cobro anotado no están acá (se asumen en efectivo en el
// resumen): esto es lo que alguien registró.

const LEDGER_TYPES = ["opening", "payment", "return", "income", "expense", "withdrawal", "fund_adjustment", "closing"];

const LEDGER_SQL = `
  WITH s AS (SELECT * FROM cash_sessions WHERE owner_id = $1 AND id = $2),
  ledger AS (
    SELECT 'opening-' || s.id AS key, 'opening' AS type, s.opened_at AS at, s.opening_amount AS amount, 'in' AS direction,
           true AS cash, 'Efectivo'::text AS method_name, NULL::text AS category, NULL::text AS detail,
           s.opened_by_name AS actor_name, false AS voided, NULL::text AS void_reason, NULL::bigint AS movement_id
    FROM s
    UNION ALL
    SELECT 'payment-' || p.id, 'payment', p.created_at, p.amount, 'in', p.method_kind = 'cash', p.method_name, NULL,
           concat_ws(' · ', 'Mesa ' || ts.table_number, p.payer_name, p.reference),
           coalesce(p.actor_name, p.waiter_name), p.status = 'voided', p.void_reason, NULL
    FROM payments p LEFT JOIN table_sessions ts ON ts.id = p.table_session_id
    WHERE p.owner_id = $1 AND p.cash_session_id = $2
    UNION ALL
    SELECT 'return-' || o.id, 'return', coalesce(o.returned_at, o.cancelled_at, o.updated_at), o.total, 'out',
           o.payment_mode <> 'mercadopago',
           CASE WHEN o.payment_mode = 'mercadopago' THEN 'Mercado Pago (online)' ELSE 'Efectivo' END, o.status,
           concat_ws(' · ', 'Pedido #' || o.number, o.status_reason), NULL, false, NULL, NULL
    FROM orders o WHERE o.owner_id = $1 AND o.returned_cash_session_id = $2 AND o.status IN ('returned', 'cancelled')
    UNION ALL
    SELECT 'movement-' || m.id, m.type, m.created_at, m.amount,
           CASE m.type WHEN 'income' THEN 'in' WHEN 'fund_adjustment' THEN 'none' ELSE 'out' END,
           true, 'Efectivo', m.category, m.notes, m.actor_name, m.voided_at IS NOT NULL, m.void_reason, m.id
    FROM cash_movements m WHERE m.owner_id = $1 AND m.cash_session_id = $2
    UNION ALL
    SELECT 'closing-' || s.id, 'closing', s.closed_at, s.cash_counted, 'none', true, 'Efectivo', NULL, s.closing_notes,
           s.closed_by_name, false, NULL, NULL
    FROM s WHERE s.closed_at IS NOT NULL
  )
  SELECT *, count(*) OVER () AS total_rows,
         coalesce(sum(amount) FILTER (WHERE direction = 'in' AND NOT voided) OVER (), 0) AS total_in,
         coalesce(sum(amount) FILTER (WHERE direction = 'out' AND NOT voided) OVER (), 0) AS total_out
  FROM ledger
  WHERE ($3::text IS NULL OR type = $3) AND ($4::boolean IS NOT TRUE OR cash)
  ORDER BY at DESC, key DESC LIMIT $5 OFFSET $6`;

const LEDGER_LABELS = {
  opening: "Apertura · fondo inicial",
  fund_adjustment: "Cambio del fondo inicial",
  closing: "Cierre · efectivo contado",
};

const ledgerLabel = (row) => {
  if (row.type === "payment") return `Cobro · ${row.method_name}`;
  // En las devoluciones "category" trae el estado del pedido.
  if (row.type === "return") return row.category === "cancelled" ? "Anulación · pedido de una caja cerrada" : "Devolución";
  return LEDGER_LABELS[row.type]
    ?? `${CASH_MOVEMENT_TYPES[row.type]} · ${CASH_MOVEMENT_CATEGORIES[row.type]?.[row.category] ?? "Otro"}`;
};

const toLedgerDTO = (row, open) => ({
  key: row.key,
  type: row.type,
  at: row.at,
  amount: num(row.amount) ?? 0,
  // in: entra · out: sale · none: no suma ni resta (cambio de fondo, arqueo).
  direction: row.direction,
  // false: no pasó por el cajón (tarjeta, transferencia, online).
  cash: row.cash,
  label: ledgerLabel(row),
  detail: row.detail || null,
  actorName: row.actor_name ?? null,
  voided: row.voided,
  voidReason: row.void_reason ?? null,
  // Solo los movimientos manuales de una caja abierta se anulan desde acá.
  movementId: open && row.movement_id !== null && row.type !== "fund_adjustment" && !row.voided ? Number(row.movement_id) : null,
});

/**
 * Libro de una caja, filtrado y paginado por el servidor.
 * @param {{ type?: string, cashOnly?: boolean, page?: number }} filters
 */
const getLedger = async (ownerId, sessionId, { type = null, cashOnly = false, page = 1 } = {}) => {
  if (type !== null && !LEDGER_TYPES.includes(type)) throw new OrdersError(400, "Tipo de movimiento inválido.");
  const session = await getSessionRow({ query }, ownerId, sessionId);
  const pageSize = LIMITS.cashLedgerPageSize;
  const { rows } = await query(LEDGER_SQL, [ownerId, sessionId, type, cashOnly, pageSize, (page - 1) * pageSize]);
  return {
    entries: rows.map((row) => toLedgerDTO(row, !session.closed_at)),
    total: Number(rows[0]?.total_rows ?? 0),
    totals: { in: num(rows[0]?.total_in) ?? 0, out: num(rows[0]?.total_out) ?? 0 },
    page,
    pageSize,
  };
};

// ── Historial ────────────────────────────────

const CLOSE_RESULTS = {
  exact: "difference = 0",
  short: "difference < 0",
  over: "difference > 0",
  uncounted: "difference IS NULL",
};

/**
 * Cajas cerradas, de la más reciente a la más vieja, filtradas por el servidor.
 * Devuelve además los totales de todo lo que cumple el filtro (no solo de la
 * página) y las opciones para armar los filtros.
 * @param {{ registerId?, cashier?, result?: "exact"|"short"|"over"|"uncounted", from?, to?, page?, pageSize? }} filters
 *   from / to: días de Buenos Aires (YYYY-MM-DD, inclusive) según el cierre.
 */
const listClosedSessions = async (ownerId, {
  registerId = null, cashier = null, result = null, from = null, to = null, page = 1, pageSize = 20,
} = {}) => {
  if (result !== null && !CLOSE_RESULTS[result]) throw new OrdersError(400, "Resultado inválido.");
  const where = ["owner_id = $1", "closed_at IS NOT NULL"];
  const params = [ownerId];
  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };
  if (registerId) add("register_id = ?", registerId);
  if (cashier) add("cashier_name = ?", cashier);
  if (result) where.push(CLOSE_RESULTS[result]);
  if (from) add(`closed_at >= (?::date::timestamp AT TIME ZONE '${TIMEZONE_BA}')`, from);
  if (to) add(`closed_at < ((?::date + 1)::timestamp AT TIME ZONE '${TIMEZONE_BA}')`, to);
  const whereSql = where.join(" AND ");

  const [{ rows }, totals, registers, cashiers] = await Promise.all([
    query(
      `SELECT * FROM cash_sessions WHERE ${whereSql} ORDER BY closed_at DESC LIMIT ${Number(pageSize)} OFFSET ${(Number(page) - 1) * Number(pageSize)}`,
      params
    ),
    query(
      `SELECT count(*)::int AS total,
              coalesce(sum(net_amount), 0) AS net_amount,
              coalesce(sum(difference), 0) AS difference,
              coalesce(sum(expense_amount), 0) AS expense_amount,
              coalesce(sum(cash_withdrawn), 0) + coalesce(sum(withdrawal_amount), 0) AS withdrawn_amount,
              count(*) FILTER (WHERE difference = 0)::int AS exact_count,
              count(*) FILTER (WHERE difference < 0)::int AS short_count,
              coalesce(sum(difference) FILTER (WHERE difference < 0), 0) AS short_amount,
              count(*) FILTER (WHERE difference > 0)::int AS over_count,
              coalesce(sum(difference) FILTER (WHERE difference > 0), 0) AS over_amount
       FROM cash_sessions WHERE ${whereSql}`,
      params
    ),
    query("SELECT id, name FROM cash_registers WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY id", [ownerId]),
    query(
      `SELECT DISTINCT cashier_name FROM cash_sessions
       WHERE owner_id = $1 AND closed_at IS NOT NULL AND cashier_name IS NOT NULL ORDER BY 1`,
      [ownerId]
    ),
  ]);
  const t = totals.rows[0];
  return {
    sessions: rows.map((row) => toCashSessionDTO(row)),
    total: t.total,
    page,
    pageSize,
    totals: {
      netAmount: Number(t.net_amount),
      difference: Number(t.difference),
      expenseAmount: Number(t.expense_amount),
      withdrawnAmount: Number(t.withdrawn_amount),
      exactCount: t.exact_count,
      shortCount: t.short_count,
      shortAmount: Number(t.short_amount),
      overCount: t.over_count,
      overAmount: Number(t.over_amount),
    },
    filters: {
      registers: registers.rows.map((row) => ({ id: Number(row.id), name: row.name })),
      cashiers: cashiers.rows.map((row) => row.cashier_name),
    },
  };
};

// Cajas cerradas entre dos días de Buenos Aires (inclusive), según cuándo se
// cerraron. Para los reportes: sin paginar, de la más vieja a la más nueva.
const listSessionsClosedBetween = async (ownerId, from, to, { limit = 1000 } = {}) => {
  const { rows } = await query(
    `SELECT * FROM cash_sessions
     WHERE owner_id = $1
       AND closed_at >= ($2::date::timestamp AT TIME ZONE '${TIMEZONE_BA}')
       AND closed_at < (($3::date + 1)::timestamp AT TIME ZONE '${TIMEZONE_BA}')
     ORDER BY closed_at LIMIT $4`,
    [ownerId, from, to, limit]
  );
  return rows.map((row) => toCashSessionDTO(row));
};

// ── Pantalla de caja ─────────────────────────

const catalogOf = (labels) => Object.entries(labels).map(([key, label]) => ({ key, label }));

/**
 * Todo lo que necesita la pantalla de caja, en una sola consulta: las cajas
 * (cuál está abierta y con qué fondo abriría), las abiertas con su resultado,
 * los operadores que pueden ser cajeros y los tipos de movimiento con sus conceptos.
 */
const getOverview = async (ownerId) => {
  const registers = await listRegisters(ownerId);
  const [sessions, cashiers] = await Promise.all([
    listOpenSessions(ownerId),
    query("SELECT id, name FROM waiters WHERE owner_id = $1 AND active AND deleted_at IS NULL ORDER BY name", [ownerId]),
  ]);
  return {
    registers,
    sessions,
    cashiers: cashiers.rows.map((row) => ({ id: Number(row.id), name: row.name })),
    movementTypes: catalogOf(CASH_MOVEMENT_TYPES).map((type) => ({
      ...type, categories: catalogOf(CASH_MOVEMENT_CATEGORIES[type.key]),
    })),
  };
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
  addMovement,
  voidMovement,
  getLedger,
  listClosedSessions,
  listSessionsClosedBetween,
  getOverview,
};
