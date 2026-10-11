// Reportes de ventas para Estadísticas del panel y su exportación a Excel.
//
// Todo se agrupa por día de Buenos Aires según cuándo se cargó el pedido
// (created_at), con el mismo corte que las visitas (utils/dates). "Vendido"
// es lo mismo que en el resumen del turno: pedidos que no están anulados ni
// devueltos. Solo lectura: no abre turnos ni cajas.

const { query } = require("../db/sql");
const { NOT_BILLED_STATUSES } = require("../constants");
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

/**
 * Lo que muestra Estadísticas: el período de días completos, el anterior de
 * igual largo para comparar y hoy aparte (ver utils/statsPeriod).
 */
const salesDashboard = async (ownerId, period, { serviceType = null } = {}) => {
  const { dates, previousDates, ...meta } = period;
  const [allDays, breakdown, cashSessions] = await Promise.all([
    salesByDay(ownerId, [...previousDates, ...dates, meta.todayDate], { serviceType }),
    // El panel muestra la tabla de productos completa (con buscador), no solo el top.
    salesBreakdown(ownerId, meta.periodStart, meta.periodEnd, { productLimit: 300, serviceType }),
    listSessionsClosedBetween(ownerId, meta.periodStart, meta.todayDate),
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
  };
};

module.exports = { salesByDay, sumDays, salesBreakdown, listOrdersBetween, salesDashboard };
