// Turnos / días de trabajo.
//
// Siempre hay como mucho un turno abierto por local. Se abre solo con el
// primer pedido (o desde el panel) y se cierra a mano, lo que congela el
// resumen del turno. La caja va aparte (cashService): cerrar el turno no
// cierra la caja ni al revés. Los turnos viejos pueden tener efectivo
// contado (cash_counted) de cuando ambos cierres eran uno solo.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { ACTIVE_STATUSES, NOT_BILLED_STATUSES } = require("../constants");

const TZ = "America/Argentina/Buenos_Aires";
const dateFormatter = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });
const timeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// ¿La hora (HH:MM) cae dentro del turno? Soporta turnos que cruzan la medianoche.
const inShift = (time, shift) => {
  const now = toMinutes(time);
  const from = toMinutes(shift.from);
  const to = toMinutes(shift.to);
  return from < to ? now >= from && now < to : now >= from || now < to;
};

// Nombre del turno que se abre ahora según la configuración del local.
const shiftLabel = (settings, now = new Date()) => {
  const date = dateFormatter.format(now);
  if (settings?.period_mode === "day") return `Día ${date}`;
  const time = timeFormatter.format(now);
  const match = (settings?.shift_schedule ?? []).find((shift) => inShift(time, shift));
  return match ? `${match.name} · ${date}` : `Turno ${date} ${time}`;
};

const num = (value) => (value === null || value === undefined ? null : Number(value));

const toShiftDTO = (row) => row && ({
  id: Number(row.id),
  label: row.label,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  cashCounted: num(row.cash_counted),
  closingNotes: row.closing_notes,
  ordersCount: row.orders_count,
  totalAmount: num(row.total_amount),
});

const findOpenShift = async (ownerId) => {
  const { rows } = await query("SELECT * FROM shifts WHERE owner_id = $1 AND closed_at IS NULL", [ownerId]);
  return rows[0] ?? null;
};

// Turno abierto, bloqueado para esta transacción (serializa la numeración de
// pedidos). Si no hay ninguno, lo abre.
const lockOrOpenShift = async (client, settings) => {
  await client.query(
    `INSERT INTO shifts (owner_id, label) VALUES ($1, $2)
     ON CONFLICT (owner_id) WHERE closed_at IS NULL DO NOTHING`,
    [settings.owner_id, shiftLabel(settings)]
  );
  const { rows } = await client.query(
    "SELECT * FROM shifts WHERE owner_id = $1 AND closed_at IS NULL FOR UPDATE",
    [settings.owner_id]
  );
  return rows[0];
};

const openShift = (settings) => withTransaction((client) => lockOrOpenShift(client, settings));

// Resumen de un turno para la caja y los reportes.
const shiftSummary = async (ownerId, shiftId) => {
  const params = [ownerId, shiftId, NOT_BILLED_STATUSES];
  const [byStatus, bySource, byServiceType, byWaiter, byTable, topProducts, timings] = await Promise.all([
    query(
      `SELECT status, count(*)::int AS count, coalesce(sum(total), 0) AS amount
       FROM orders WHERE owner_id = $1 AND shift_id = $2 GROUP BY status`,
      [ownerId, shiftId]
    ),
    query(
      `SELECT source, count(*)::int AS count, coalesce(sum(total), 0) AS amount
       FROM orders WHERE owner_id = $1 AND shift_id = $2 AND NOT (status = ANY($3)) GROUP BY source`,
      params
    ),
    query(
      `SELECT service_type, count(*)::int AS count, coalesce(sum(total), 0) AS amount
       FROM orders WHERE owner_id = $1 AND shift_id = $2 AND NOT (status = ANY($3)) GROUP BY service_type`,
      params
    ),
    query(
      `SELECT coalesce(waiter_name, 'Sin operador') AS name, count(*)::int AS count, coalesce(sum(total), 0) AS amount
       FROM orders WHERE owner_id = $1 AND shift_id = $2 AND NOT (status = ANY($3))
       GROUP BY 1 ORDER BY amount DESC`,
      params
    ),
    query(
      `SELECT table_number, count(*)::int AS count, coalesce(sum(total), 0) AS amount
       FROM orders WHERE owner_id = $1 AND shift_id = $2 AND NOT (status = ANY($3)) AND table_number IS NOT NULL
       GROUP BY 1 ORDER BY 1`,
      params
    ),
    query(
      `SELECT oi.title, oi.option_name, sum(oi.quantity)::int AS quantity, sum(oi.quantity * oi.unit_price) AS amount
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.owner_id = $1 AND o.shift_id = $2 AND NOT (o.status = ANY($3))
       GROUP BY 1, 2 ORDER BY quantity DESC, amount DESC LIMIT 10`,
      params
    ),
    query(
      `SELECT avg(extract(epoch FROM ready_at - confirmed_at)) AS prep_seconds,
              avg(extract(epoch FROM delivered_at - created_at)) AS service_seconds
       FROM orders WHERE owner_id = $1 AND shift_id = $2 AND NOT (status = ANY($3))`,
      params
    ),
  ]);

  const statuses = Object.fromEntries(byStatus.rows.map((row) => [row.status, { count: row.count, amount: Number(row.amount) }]));
  const billed = bySource.rows.reduce(
    (acc, row) => ({ count: acc.count + row.count, amount: acc.amount + Number(row.amount) }),
    { count: 0, amount: 0 }
  );
  const pendingDelivery = ACTIVE_STATUSES.reduce((sum, status) => sum + (statuses[status]?.count ?? 0), 0);

  return {
    ordersCount: billed.count,
    totalAmount: Math.round(billed.amount * 100) / 100,
    averageTicket: billed.count > 0 ? Math.round((billed.amount / billed.count) * 100) / 100 : 0,
    pendingDelivery,
    byStatus: statuses,
    bySource: bySource.rows.map((row) => ({ source: row.source, count: row.count, amount: Number(row.amount) })),
    byServiceType: byServiceType.rows.map((row) => ({ serviceType: row.service_type, count: row.count, amount: Number(row.amount) })),
    byWaiter: byWaiter.rows.map((row) => ({ name: row.name, count: row.count, amount: Number(row.amount) })),
    byTable: byTable.rows.map((row) => ({ tableNumber: row.table_number, count: row.count, amount: Number(row.amount) })),
    topProducts: topProducts.rows.map((row) => ({
      title: row.title, option: row.option_name, quantity: row.quantity, amount: Number(row.amount),
    })),
    averagePrepMinutes: timings.rows[0]?.prep_seconds ? Math.round(Number(timings.rows[0].prep_seconds) / 60) : null,
    averageServiceMinutes: timings.rows[0]?.service_seconds ? Math.round(Number(timings.rows[0].service_seconds) / 60) : null,
  };
};

const getShift = async (ownerId, shiftId) => {
  const { rows } = await query("SELECT * FROM shifts WHERE owner_id = $1 AND id = $2", [ownerId, shiftId]);
  if (!rows[0]) throw new OrdersError(404, "Turno no encontrado.");
  return rows[0];
};

const listShifts = async (ownerId, { page = 1, pageSize = 20 } = {}) => {
  const offset = (page - 1) * pageSize;
  const [{ rows }, count] = await Promise.all([
    query(
      "SELECT * FROM shifts WHERE owner_id = $1 ORDER BY opened_at DESC LIMIT $2 OFFSET $3",
      [ownerId, pageSize, offset]
    ),
    query("SELECT count(*)::int AS total FROM shifts WHERE owner_id = $1", [ownerId]),
  ]);
  return { shifts: rows.map(toShiftDTO), total: count.rows[0].total, page, pageSize };
};

// Cierre de turno: cierra el turno abierto y congela sus totales. No toca la
// caja. Con pedidos todavía sin entregar pide `force` (esos pedidos siguen
// en el panel igual).
const closeShift = async (ownerId, { notes = null, force = false } = {}) => {
  const shiftId = await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM shifts WHERE owner_id = $1 AND closed_at IS NULL FOR UPDATE",
      [ownerId]
    );
    const shift = rows[0];
    if (!shift) throw new OrdersError(404, "No hay un turno abierto.");

    const active = await client.query(
      "SELECT count(*)::int AS count FROM orders WHERE shift_id = $1 AND status = ANY($2)",
      [shift.id, ACTIVE_STATUSES]
    );
    if (active.rows[0].count > 0 && !force) {
      throw new OrdersError(409, `Hay ${active.rows[0].count} pedido(s) sin entregar en este turno.`, "ACTIVE_ORDERS");
    }

    const totals = await client.query(
      `SELECT count(*)::int AS count, coalesce(sum(total), 0) AS amount
       FROM orders WHERE shift_id = $1 AND NOT (status = ANY($2))`,
      [shift.id, NOT_BILLED_STATUSES]
    );
    await client.query(
      `UPDATE shifts SET closed_at = now(), closing_notes = $2,
         orders_count = $3, total_amount = $4 WHERE id = $1`,
      [shift.id, notes, totals.rows[0].count, totals.rows[0].amount]
    );
    return shift.id;
  });
  return toShiftDTO(await getShift(ownerId, shiftId));
};

module.exports = {
  shiftLabel,
  toShiftDTO,
  findOpenShift,
  lockOrOpenShift,
  openShift,
  shiftSummary,
  getShift,
  listShifts,
  closeShift,
};
