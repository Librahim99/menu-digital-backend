// ──────────────────────────────────────────────
// Motor de cálculo del panel de vendedores. Todo se deriva de SellerSale (el
// registro inmutable de cada venta atribuida) — nunca de Plan/PaymentTransaction
// directamente — para no arrastrar precios en vivo ni datos ajenos a lo que un
// vendedor efectivamente vendió.
//
// Regla de elegibilidad (confirmada con el negocio, no surge sola del modelo):
// la primera venta de un cliente siempre genera comisión y puntos. Una
// renovación solo genera comisión, puntos, y cuenta como "cliente vendido" si
// el contrato ANTERIOR de ese mismo cliente era de 1 mes — una renovación
// desde un plan de 3/6/12 meses no suma nada, porque ese período ya se pagó
// como una sola venta.
// ──────────────────────────────────────────────

const SellerSale = require("../models/SellerSale");
const { pointsForMonths, tierForPoints, commissionForSale } = require("../config/sellerCommission");
const { cycleAnchor, cycleWindowAtOffset, currentCycleWindow } = require("../utils/sellerCycle");

const sum = (arr) => arr.reduce((acc, n) => acc + n, 0);
const round2 = (n) => Math.round(n * 100) / 100;

const groupBy = (rows, keyFn) => {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

// Para un conjunto de userIDs, trae TODO su historial de SellerSale (todo el
// tiempo, todos los vendedores que alguna vez estuvieron a cargo) ordenado
// cronológicamente, y marca cada venta como elegible según la regla de arriba.
async function computeEligibility(userIDs) {
  if (!userIDs.length) return new Set();

  const rows = await SellerSale.find({ userID: { $in: userIDs } })
    .select("_id userID months subscriptionDate")
    .sort({ subscriptionDate: 1, createdAt: 1 })
    .lean();

  const eligible = new Set();
  const byUser = groupBy(rows, (row) => String(row.userID));
  for (const sales of byUser.values()) {
    let prevMonths = null;
    for (const sale of sales) {
      if (prevMonths === null || prevMonths === 1) eligible.add(String(sale._id));
      prevMonths = sale.months;
    }
  }
  return eligible;
}

// Ventas elegibles atribuidas a estos vendedores puntualmente (sellerID en la
// fila), pero la elegibilidad de cada una se decide con el historial COMPLETO
// del cliente (incluyendo ventas de antes de una eventual reasignación de
// vendedor) — por eso el cálculo de elegibilidad no se limita a sellerIDs.
async function loadEligibleSalesForSellers(sellerIDs) {
  if (!sellerIDs.length) return [];

  const sales = await SellerSale.find({ sellerID: { $in: sellerIDs } })
    .select("_id sellerID userID plan amount months subscriptionDate")
    .lean();
  if (!sales.length) return [];

  const userIDs = [...new Set(sales.map((sale) => String(sale.userID)))];
  const eligibleIDs = await computeEligibility(userIDs);
  return sales.filter((sale) => eligibleIDs.has(String(sale._id)));
}

const emptyPlanBucket = () => ({ count: 0, points: 0, commission: 0, revenue: 0 });

// Resume UN ciclo: el tier se calcula una sola vez a partir del total de
// puntos del ciclo, y se aplica esa misma tasa a cada venta de ese ciclo —
// así es como lo especifica la estructura de comisiones (el nivel es mensual,
// no por venta).
function summarizeCycle(salesInWindow) {
  const points = sum(salesInWindow.map((sale) => pointsForMonths(sale.months)));
  const tier = tierForPoints(points);

  const byPlan = (plan) => {
    const rows = salesInWindow.filter((sale) => sale.plan === plan);
    if (!rows.length) return emptyPlanBucket();
    return {
      count: rows.length,
      points: sum(rows.map((sale) => pointsForMonths(sale.months))),
      commission: round2(sum(rows.map((sale) => commissionForSale(sale.plan, sale.months, tier.rate)))),
      revenue: round2(sum(rows.map((sale) => sale.amount))),
    };
  };

  const basic = byPlan("basic");
  const pro = byPlan("pro");

  return {
    points,
    tier,
    basic,
    pro,
    total: {
      count: salesInWindow.length,
      points,
      commission: round2(basic.commission + pro.commission),
      revenue: round2(basic.revenue + pro.revenue),
    },
  };
}

// Suma ciclo por ciclo a través de TODA la historia elegible de un vendedor
// (hasta `uptoOffset` inclusive, por si se quiere acotar al ciclo actual).
// No se puede sumar todas las ventas de un saque y aplicarles un único tier:
// el nivel es un concepto mensual, cada ciclo tiene el suyo propio según sus
// propios puntos.
function summarizeHistoric(seller, eligibleSales, uptoOffset = Infinity) {
  const anchor = cycleAnchor(seller);
  const byOffset = groupBy(
    eligibleSales.filter((sale) => {
      const offset = currentCycleWindow(anchor, new Date(sale.subscriptionDate)).offset;
      return offset <= uptoOffset;
    }),
    (sale) => currentCycleWindow(anchor, new Date(sale.subscriptionDate)).offset,
  );

  const buckets = { basic: emptyPlanBucket(), pro: emptyPlanBucket(), total: { count: 0, points: 0, commission: 0, revenue: 0 } };

  for (const salesInCycle of byOffset.values()) {
    const cycleSummary = summarizeCycle(salesInCycle);
    for (const key of ["basic", "pro"]) {
      buckets[key].count += cycleSummary[key].count;
      buckets[key].points += cycleSummary[key].points;
      buckets[key].commission += cycleSummary[key].commission;
      buckets[key].revenue += cycleSummary[key].revenue;
    }
    buckets.total.count += cycleSummary.total.count;
    buckets.total.points += cycleSummary.total.points;
    buckets.total.commission += cycleSummary.total.commission;
    buckets.total.revenue += cycleSummary.total.revenue;
  }

  buckets.basic.commission = round2(buckets.basic.commission);
  buckets.basic.revenue = round2(buckets.basic.revenue);
  buckets.pro.commission = round2(buckets.pro.commission);
  buckets.pro.revenue = round2(buckets.pro.revenue);
  buckets.total.commission = round2(buckets.total.commission);
  buckets.total.revenue = round2(buckets.total.revenue);

  return { cyclesCount: byOffset.size, tier: null, ...buckets };
}

// "Panel general": clientes vendidos totales + del ciclo actual + comisión
// del ciclo actual, para uno o varios vendedores a la vez (una sola pasada de
// consultas, sin N+1 por vendedor).
async function getOverviewForSellers(sellers, { now = new Date() } = {}) {
  const sellerIDs = sellers.map((seller) => seller._id);
  const allEligibleSales = await loadEligibleSalesForSellers(sellerIDs);
  const salesBySeller = groupBy(allEligibleSales, (sale) => String(sale.sellerID));

  return sellers.map((seller) => {
    const anchor = cycleAnchor(seller);
    const window = currentCycleWindow(anchor, now);
    const sellerSales = salesBySeller.get(String(seller._id)) || [];
    const salesInWindow = sellerSales.filter(
      (sale) => sale.subscriptionDate >= window.start && sale.subscriptionDate < window.end,
    );

    return {
      sellerID: seller._id,
      name: seller.name,
      code: seller.code,
      active: seller.active,
      cycle: { start: window.start, end: window.end, offset: window.offset },
      clientsSoldTotal: sellerSales.length,
      currentCycle: summarizeCycle(salesInWindow),
    };
  });
}

// Ranking: comisión/puntos por vendedor, separado por plan, para un período
// dado. "previous" y "current" son una sola ventana; "historic" suma todos
// los ciclos pasados de ese vendedor (ver summarizeHistoric).
async function getRanking(sellers, { period = "current", now = new Date() } = {}) {
  const sellerIDs = sellers.map((seller) => seller._id);
  const allEligibleSales = await loadEligibleSalesForSellers(sellerIDs);
  const salesBySeller = groupBy(allEligibleSales, (sale) => String(sale.sellerID));

  return sellers.map((seller) => {
    const anchor = cycleAnchor(seller);
    const current = currentCycleWindow(anchor, now);
    const sellerSales = salesBySeller.get(String(seller._id)) || [];

    let summary;
    if (period === "historic") {
      summary = summarizeHistoric(seller, sellerSales, current.offset);
    } else {
      const window = period === "previous" ? cycleWindowAtOffset(anchor, current.offset - 1) : current;
      const salesInWindow = sellerSales.filter(
        (sale) => sale.subscriptionDate >= window.start && sale.subscriptionDate < window.end,
      );
      summary = summarizeCycle(salesInWindow);
    }

    return {
      sellerID: seller._id,
      name: seller.name,
      code: seller.code,
      active: seller.active,
      period,
      tier: summary.tier,
      basic: summary.basic,
      pro: summary.pro,
      total: summary.total,
    };
  });
}

module.exports = {
  computeEligibility,
  loadEligibleSalesForSellers,
  summarizeCycle,
  summarizeHistoric,
  getOverviewForSellers,
  getRanking,
};
