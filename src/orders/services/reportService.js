// Reportes de ventas para Estadísticas del panel y su exportación a Excel.
//
// Todo se agrupa por día de Buenos Aires según cuándo se cargó el pedido
// (created_at), con el mismo corte que las visitas (utils/dates). "Vendido"
// es lo mismo que en el resumen del turno: pedidos que no están anulados ni
// devueltos. Solo lectura: no abre turnos ni cajas.

const { query } = require("../db/sql");
const { NOT_BILLED_STATUSES, CASH_MOVEMENT_TYPES, CASH_MOVEMENT_CATEGORIES } = require("../constants");
const { TIMEZONE_BA } = require("../../utils/dates");
const { listSessionsClosedBetween } = require("./cashService");

const round = (value) => Math.round(Number(value) * 100) / 100;

// Rango [from, to] de días de Buenos Aires sobre una columna timestamptz,
// escrito contra la columna sin transformar para que use su índice.
const inRange = (column) =>
  `${column} >= ($2::date::timestamp AT TIME ZONE '${TIMEZONE_BA}')
   AND ${column} < (($3::date + 1)::timestamp AT TIME ZONE '${TIMEZONE_BA}')`;
const LOCAL = (column) => `(${column} AT TIME ZONE '${TIMEZONE_BA}')`;
const BILLED = "NOT (o.status = ANY($4))";
// Filtro opcional por tipo de pedido (mesa, barra, take away, delivery): null = todos.
const SERVICE = "($5::text IS NULL OR o.service_type = $5)";
// Líneas quitadas del pedido (migración 008) no cuentan como vendidas.
const ACTIVE_LINE = "coalesce(to_jsonb(oi) ->> 'status', 'active') <> 'cancelled'";

const emptyDay = (date) => ({
  date, orders: 0, amount: 0, discounts: 0,
  cancelledCount: 0, cancelledAmount: 0, returnedCount: 0, returnedAmount: 0,
});

/**
 * Una fila por día del rango, con ceros en los días sin pedidos.
 * `dates` es la lista de días "YYYY-MM-DD" a devolver, en orden.
 */
const salesByDay = async (ownerId, dates, { serviceType = null } = {}) => {
  if (dates.length === 0) return [];
  const { rows } = await query(
    `SELECT to_char(${LOCAL("o.created_at")}, 'YYYY-MM-DD') AS date,
            count(*) FILTER (WHERE ${BILLED})::int AS orders,
            coalesce(sum(o.total) FILTER (WHERE ${BILLED}), 0) AS amount,
            coalesce(sum(o.discount_amount) FILTER (WHERE ${BILLED}), 0) AS discounts,
            count(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled_count,
            coalesce(sum(o.total) FILTER (WHERE o.status = 'cancelled'), 0) AS cancelled_amount,
            count(*) FILTER (WHERE o.status = 'returned')::int AS returned_count,
            coalesce(sum(o.total) FILTER (WHERE o.status = 'returned'), 0) AS returned_amount
     FROM orders o
     WHERE o.owner_id = $1 AND ${inRange("o.created_at")} AND ${SERVICE}
     GROUP BY 1`,
    [ownerId, dates[0], dates.at(-1), NOT_BILLED_STATUSES, serviceType]
  );
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return dates.map((date) => {
    const row = byDate.get(date);
    if (!row) return emptyDay(date);
    return {
      date,
      orders: row.orders,
      amount: round(row.amount),
      discounts: round(row.discounts),
      cancelledCount: row.cancelled_count,
      cancelledAmount: round(row.cancelled_amount),
      returnedCount: row.returned_count,
      returnedAmount: round(row.returned_amount),
    };
  });
};

const sumDays = (days) => {
  const totals = days.reduce((acc, day) => ({
    orders: acc.orders + day.orders,
    amount: acc.amount + day.amount,
    discounts: acc.discounts + day.discounts,
    cancelledCount: acc.cancelledCount + day.cancelledCount,
    cancelledAmount: acc.cancelledAmount + day.cancelledAmount,
    returnedCount: acc.returnedCount + day.returnedCount,
    returnedAmount: acc.returnedAmount + day.returnedAmount,
  }), emptyDay(null));
  const { date: _date, ...rest } = totals;
  return {
    ...rest,
    amount: round(rest.amount),
    discounts: round(rest.discounts),
    cancelledAmount: round(rest.cancelledAmount),
    returnedAmount: round(rest.returnedAmount),
    averageTicket: rest.orders > 0 ? round(rest.amount / rest.orders) : 0,
  };
};

/**
 * Cómo se reparte lo vendido entre `from` y `to` (días de Buenos Aires,
 * inclusive): canales, origen, operadores, pago, horarios y productos.
 * `productLimit` acota el ranking (el panel pide pocos, el Excel todos).
 * Con `serviceType` todo se limita a ese tipo de pedido, salvo el reparto por
 * tipo (byServiceType), que siempre muestra el total para poder comparar.
 */
const salesBreakdown = async (ownerId, from, to, { productLimit = 10, serviceType = null } = {}) => {
  const params = [ownerId, from, to, NOT_BILLED_STATUSES, serviceType];
  const allServices = `o.owner_id = $1 AND ${inRange("o.created_at")} AND ${BILLED}`;
  const where = `${allServices} AND ${SERVICE}`;
  const grouped = (expression, condition = where) => query(
    `SELECT ${expression} AS key, count(*)::int AS count, coalesce(sum(o.total), 0) AS amount
     FROM orders o WHERE ${condition} GROUP BY 1 ORDER BY amount DESC, key`,
    condition === where ? params : params.slice(0, 4)
  );

  const [byServiceType, bySource, byWaiter, byPayment, byHour, products, categories, timings] = await Promise.all([
    grouped("o.service_type", allServices),
    grouped("o.source"),
    grouped("coalesce(o.waiter_name, '')"),
    grouped("o.payment_mode"),
    query(
      `SELECT extract(hour FROM ${LOCAL("o.created_at")})::int AS hour,
              count(*)::int AS count, coalesce(sum(o.total), 0) AS amount
       FROM orders o WHERE ${where} GROUP BY 1`,
      params
    ),
    query(
      `SELECT oi.title, oi.option_name, max(oi.category_name) AS category_name,
              sum(oi.quantity)::int AS quantity, sum(oi.quantity * oi.unit_price) AS amount
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE ${where} AND ${ACTIVE_LINE}
       GROUP BY 1, 2 ORDER BY quantity DESC, amount DESC, oi.title LIMIT $6`,
      [...params, productLimit]
    ),
    query(
      `SELECT coalesce(oi.category_name, '') AS name,
              sum(oi.quantity)::int AS quantity, sum(oi.quantity * oi.unit_price) AS amount
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE ${where} AND ${ACTIVE_LINE}
       GROUP BY 1 ORDER BY amount DESC, name`,
      params
    ),
    query(
      `SELECT avg(extract(epoch FROM o.ready_at - o.confirmed_at)) AS prep_seconds,
              avg(extract(epoch FROM o.delivered_at - o.created_at)) AS service_seconds
       FROM orders o WHERE ${where}`,
      params
    ),
  ]);

  const toGroup = (result) => result.rows.map((row) => ({ key: row.key, count: row.count, amount: round(row.amount) }));
  const hours = Array.from({ length: 24 }, () => ({ count: 0, amount: 0 }));
  byHour.rows.forEach((row) => { hours[row.hour] = { count: row.count, amount: round(row.amount) }; });
  const minutes = (seconds) => (seconds ? Math.round(Number(seconds) / 60) : null);

  return {
    byServiceType: toGroup(byServiceType),
    bySource: toGroup(bySource),
    byWaiter: toGroup(byWaiter),
    byPayment: toGroup(byPayment),
    hours,
    topProducts: products.rows.map((row) => ({
      title: row.title,
      option: row.option_name,
      category: row.category_name,
      quantity: row.quantity,
      amount: round(row.amount),
    })),
    byCategory: categories.rows.map((row) => ({ name: row.name, quantity: row.quantity, amount: round(row.amount) })),
    averagePrepMinutes: minutes(timings.rows[0]?.prep_seconds),
    averageServiceMinutes: minutes(timings.rows[0]?.service_seconds),
  };
};

/** Pedidos del rango, uno por fila, del más viejo al más nuevo (para el Excel). */
const listOrdersBetween = async (ownerId, from, to, { limit = 5000 } = {}) => {
  const { rows } = await query(
    `SELECT o.id, o.number, o.created_at, o.status, o.source, o.service_type, o.table_number, o.waiter_name,
            o.customer_name, o.payment_mode, o.subtotal, o.discount_amount, o.total, o.status_reason,
            (SELECT coalesce(sum(oi.quantity), 0)::int FROM order_items oi
              WHERE oi.order_id = o.id AND ${ACTIVE_LINE}) AS units
     FROM orders o
     WHERE o.owner_id = $1 AND ${inRange("o.created_at")}
     ORDER BY o.created_at, o.id LIMIT $4`,
    [ownerId, from, to, limit + 1]
  );
  return {
    truncated: rows.length > limit,
    orders: rows.slice(0, limit).map((row) => ({
      id: Number(row.id),
      number: row.number,
      createdAt: row.created_at,
      status: row.status,
      source: row.source,
      serviceType: row.service_type,
      tableNumber: row.table_number,
      waiterName: row.waiter_name,
      customerName: row.customer_name,
      paymentMode: row.payment_mode,
      subtotal: round(row.subtotal ?? row.total),
      discountAmount: round(row.discount_amount),
      total: round(row.total),
      statusReason: row.status_reason,
      units: row.units,
    })),
  };
};

// ── Caja ─────────────────────────────────────
// Los reportes de caja salen de las cajas CERRADAS en el período (según el
// día del cierre): son números congelados, así todo cierra contra la lista de
// cierres. Lo de una caja todavía abierta entra cuando se cierra.

const closedInRange = `s.owner_id = $1 AND ${inRange("s.closed_at")}`;
// Los cierres anteriores a la migración 010 no guardaron las ventas en
// efectivo: son el efectivo esperado menos el fondo.
const CASH_SALES = "coalesce(s.cash_sales_amount, s.expected_cash - s.opening_amount, 0)";
const CLOSING_RESULT = `
  count(*)::int AS closings,
  coalesce(sum(s.net_amount), 0) AS net_amount,
  count(s.difference)::int AS counted_count,
  coalesce(sum(s.difference), 0) AS difference,
  count(*) FILTER (WHERE s.difference = 0)::int AS exact_count,
  count(*) FILTER (WHERE s.difference < 0)::int AS short_count,
  coalesce(sum(s.difference) FILTER (WHERE s.difference < 0), 0) AS short_amount,
  count(*) FILTER (WHERE s.difference > 0)::int AS over_count,
  coalesce(sum(s.difference) FILTER (WHERE s.difference > 0), 0) AS over_amount`;

const toClosingResult = (row) => ({
  closings: row.closings,
  netAmount: round(row.net_amount),
  // Cierres con el efectivo contado: la diferencia solo se mide en esos.
  countedCount: row.counted_count,
  difference: round(row.difference),
  exactCount: row.exact_count,
  shortCount: row.short_count,
  shortAmount: round(row.short_amount),
  overCount: row.over_count,
  overAmount: round(row.over_amount),
});

/**
 * Reporte de caja entre `from` y `to` (días de Buenos Aires, inclusive):
 * totales, cómo se cobró, movimientos por concepto y resultado por cajero y
 * por caja. Todo agregado acá: el panel y el Excel solo lo muestran.
 */
const cashReport = async (ownerId, from, to) => {
  const params = [ownerId, from, to];
  const [totals, byCashier, byRegister, payments, movements] = await Promise.all([
    query(
      `SELECT ${CLOSING_RESULT},
              coalesce(sum(${CASH_SALES}), 0) AS cash_sales_amount,
              coalesce(sum(s.online_amount), 0) AS online_amount,
              coalesce(sum(s.income_amount), 0) AS income_amount,
              coalesce(sum(s.expense_amount), 0) AS expense_amount,
              coalesce(sum(s.withdrawal_amount), 0) AS withdrawal_amount,
              count(*) FILTER (WHERE s.cash_withdrawn > 0)::int AS closing_withdrawn_count,
              coalesce(sum(s.cash_withdrawn), 0) AS closing_withdrawn_amount
       FROM cash_sessions s WHERE ${closedInRange}`,
      params
    ),
    query(
      `SELECT coalesce(s.cashier_name, '') AS name, ${CLOSING_RESULT}
       FROM cash_sessions s WHERE ${closedInRange} GROUP BY 1 ORDER BY net_amount DESC, name`,
      params
    ),
    query(
      `SELECT s.register_name AS name, ${CLOSING_RESULT}
       FROM cash_sessions s WHERE ${closedInRange} GROUP BY 1 ORDER BY net_amount DESC, name`,
      params
    ),
    query(
      `SELECT p.method_kind AS kind, max(p.method_name) AS label, count(*)::int AS count, coalesce(sum(p.amount), 0) AS amount
       FROM payments p JOIN cash_sessions s ON s.id = p.cash_session_id
       WHERE ${closedInRange} AND p.status = 'approved' AND p.method_kind <> 'cash'
       GROUP BY 1 ORDER BY amount DESC, kind`,
      params
    ),
    query(
      `SELECT m.type, m.category, count(*)::int AS count, coalesce(sum(m.amount), 0) AS amount
       FROM cash_movements m JOIN cash_sessions s ON s.id = m.cash_session_id
       WHERE ${closedInRange} AND m.voided_at IS NULL AND m.type <> 'fund_adjustment'
       GROUP BY 1, 2 ORDER BY amount DESC, m.category`,
      params
    ),
  ]);

  const t = totals.rows[0];
  // Cómo entró lo vendido: efectivo (lo que no tiene otro cobro anotado), los
  // medios que anotó el personal y lo cobrado online. Suma el neto.
  const byMethod = [
    { kind: "cash", label: "Efectivo", count: null, amount: round(t.cash_sales_amount) },
    ...payments.rows.map((row) => ({ kind: row.kind, label: row.label, count: row.count, amount: round(row.amount) })),
    { kind: "mercadopago", label: "Mercado Pago (online)", count: null, amount: round(t.online_amount) },
  ].filter((row) => row.amount !== 0);

  const movementRows = movements.rows.map((row) => ({
    type: row.type,
    typeLabel: CASH_MOVEMENT_TYPES[row.type] ?? row.type,
    category: row.category,
    label: CASH_MOVEMENT_CATEGORIES[row.type]?.[row.category] ?? "Otro",
    count: row.count,
    amount: round(row.amount),
  }));
  // Lo que se retira al cerrar también sale del cajón: va con los retiros.
  if (Number(t.closing_withdrawn_amount) > 0) {
    movementRows.push({
      type: "withdrawal", typeLabel: CASH_MOVEMENT_TYPES.withdrawal, category: "closing", label: "Retiro al cerrar la caja",
      count: t.closing_withdrawn_count, amount: round(t.closing_withdrawn_amount),
    });
  }

  const named = (result, fallback) => result.rows.map((row) => ({ name: row.name || fallback, ...toClosingResult(row) }));
  return {
    from,
    to,
    totals: {
      ...toClosingResult(t),
      cashSalesAmount: round(t.cash_sales_amount),
      onlineAmount: round(t.online_amount),
      incomeAmount: round(t.income_amount),
      expenseAmount: round(t.expense_amount),
      // Retiros con la caja abierta + lo retirado al cerrar.
      withdrawalAmount: round(Number(t.withdrawal_amount) + Number(t.closing_withdrawn_amount)),
    },
    byMethod,
    movements: movementRows.sort((a, b) => b.amount - a.amount),
    byCashier: named(byCashier, "Sin cajero"),
    byRegister: named(byRegister, "Caja"),
  };
};

const MOVEMENT_TYPE_LABEL = { ...CASH_MOVEMENT_TYPES, fund_adjustment: "Cambio de fondo" };

/** Movimientos de las cajas cerradas en el rango, uno por fila (para el Excel). Incluye los anulados. */
const listCashMovementsBetween = async (ownerId, from, to, { limit = 5000 } = {}) => {
  const { rows } = await query(
    `SELECT m.id, m.created_at, m.type, m.category, m.amount, m.notes, m.actor_name, m.voided_at, m.void_reason,
            s.register_name, s.cashier_name
     FROM cash_movements m JOIN cash_sessions s ON s.id = m.cash_session_id
     WHERE ${closedInRange}
     ORDER BY m.created_at, m.id LIMIT $4`,
    [ownerId, from, to, limit + 1]
  );
  return {
    truncated: rows.length > limit,
    movements: rows.slice(0, limit).map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at,
      registerName: row.register_name,
      cashierName: row.cashier_name,
      type: MOVEMENT_TYPE_LABEL[row.type] ?? row.type,
      category: row.type === "fund_adjustment" ? null : CASH_MOVEMENT_CATEGORIES[row.type]?.[row.category] ?? "Otro",
      notes: row.notes,
      amount: round(row.amount),
      actorName: row.actor_name,
      voided: row.voided_at !== null,
      voidReason: row.void_reason,
    })),
  };
};

/**
 * Lo que muestra Estadísticas: el período de días completos, el anterior de
 * igual largo para comparar y hoy aparte (ver utils/statsPeriod).
 */
const salesDashboard = async (ownerId, period, { serviceType = null } = {}) => {
  const { dates, previousDates, ...meta } = period;
  const [allDays, breakdown, cashSessions, cash] = await Promise.all([
    salesByDay(ownerId, [...previousDates, ...dates, meta.todayDate], { serviceType }),
    // El panel muestra la tabla de productos completa (con buscador), no solo el top.
    salesBreakdown(ownerId, meta.periodStart, meta.periodEnd, { productLimit: 300, serviceType }),
    listSessionsClosedBetween(ownerId, meta.periodStart, meta.todayDate),
    cashReport(ownerId, meta.periodStart, meta.todayDate),
  ]);
  const previousDays = allDays.slice(0, previousDates.length);
  const days = allDays.slice(previousDates.length, -1);
  const today = allDays.at(-1);
  return {
    ...meta,
    serviceType,
    totals: sumDays(days),
    previousTotals: sumDays(previousDays),
    today: { orders: today.orders, amount: today.amount },
    days,
    previousDays: previousDays.map(({ date, orders, amount }) => ({ date, orders, amount })),
    ...breakdown,
    cashSessions,
    // Mismo rango que cashSessions: del inicio del período hasta hoy.
    cash,
  };
};

module.exports = {
  salesByDay, sumDays, salesBreakdown, listOrdersBetween, cashReport, listCashMovementsBetween, salesDashboard,
};
