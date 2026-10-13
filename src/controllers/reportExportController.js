const PageView = require("../models/PageView");
const ItemView = require("../models/ItemView");
const Item = require("../models/Item");
const { getPool } = require("../config/postgres");
const { getRequestPlan } = require("../services/planCatalog");
const { buenosAiresDateStr } = require("../utils/dates");
const { handleError } = require("../utils/handleError");
const { buildReportWorkbook, SALES_SHEETS, VISIT_SHEETS } = require("../services/reportWorkbook");
const reportService = require("../orders/services/reportService");
const { listSessionsClosedBetween } = require("../orders/services/cashService");

const MAX_DAYS = 366;
const MS_PER_DAY = 86_400_000;
// Tope de productos distintos en las hojas de ranking.
const PRODUCT_ROWS = 1000;

const parseDay = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};

const daysBetween = (from, to) => {
  const dates = [];
  for (let time = from.getTime(); time <= to.getTime(); time += MS_PER_DAY) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
};

const count = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

const loadSales = async (ownerId, dates, sheets) => {
  const [from, to] = [dates[0], dates.at(-1)];
  const wantsCash = sheets.has("caja") || sheets.has("movimientos");
  const [days, breakdown, orders, cashSessions, cash, cashMovements] = await Promise.all([
    reportService.salesByDay(ownerId, dates),
    reportService.salesBreakdown(ownerId, from, to, { productLimit: PRODUCT_ROWS }),
    sheets.has("pedidos") ? reportService.listOrdersBetween(ownerId, from, to) : { orders: [], truncated: false },
    listSessionsClosedBetween(ownerId, from, to),
    wantsCash ? reportService.cashReport(ownerId, from, to) : null,
    sheets.has("movimientos")
      ? reportService.listCashMovementsBetween(ownerId, from, to)
      : { movements: [], truncated: false },
  ]);
  return { days, totals: reportService.sumDays(days), breakdown, orders, cashSessions, cash, cashMovements };
};

const loadVisits = async (userId, dates, sheets) => {
  const range = { $gte: dates[0], $lte: dates.at(-1) };
  const [rows, itemRows] = await Promise.all([
    PageView.find({ userID: userId, date: range }),
    sheets.has("vistos")
      ? ItemView.aggregate([
        { $match: { userID: userId, date: range } },
        { $group: { _id: "$itemID", views: { $sum: "$count" }, orders: { $sum: { $ifNull: ["$orders", 0] } } } },
        { $sort: { views: -1, _id: 1 } },
        { $limit: PRODUCT_ROWS },
      ])
      : [],
  ]);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const titles = itemRows.length > 0
    ? new Map((await Item.find({ _id: { $in: itemRows.map((row) => row._id) } }).select("title"))
      .map((item) => [item._id.toString(), item.title]))
    : new Map();
  return {
    // Un día sin las métricas del protocolo de sesiones queda en blanco, no
    // en cero: no se midió (ver models/PageView).
    days: dates.map((date) => {
      const row = byDate.get(date);
      return {
        date,
        count: row?.count || 0,
        visitors: count(row?.visitors),
        returning: count(row?.returning),
        qr: count(row?.qr),
        engaged: count(row?.engaged),
        carts: count(row?.carts),
        orders: count(row?.orders),
      };
    }),
    items: itemRows.map((row) => ({
      title: titles.get(row._id.toString()) || "(producto eliminado)",
      views: row.views,
      orders: row.orders,
    })),
  };
};

// ──────────────────────────────────────────────
// @desc    Reporte en Excel del período pedido: ventas, productos vendidos,
//          desgloses, pedidos, cierres y movimientos de caja (plan Pro, Postgres) y
//          visitas y productos vistos (feature "estadisticas", Mongo).
//          Arma solo lo que el plan del local incluye.
// @route   GET /api/users/me/reports/export?from=YYYY-MM-DD&to=YYYY-MM-DD&sheets=ventas,caja
// @access  Private
// ──────────────────────────────────────────────
const exportReport = async (req, res) => {
  try {
    const from = parseDay(req.query.from);
    const to = parseDay(req.query.to);
    if (!from || !to || from > to) {
      return res.status(400).json({ message: "Elegí un período válido." });
    }
    if (req.query.to > buenosAiresDateStr()) {
      return res.status(400).json({ message: "El período no puede terminar después de hoy." });
    }
    const dates = daysBetween(from, to);
    if (dates.length > MAX_DAYS) {
      return res.status(400).json({ message: "El período no puede superar un año." });
    }

    const plan = await getRequestPlan(req);
    const allowed = [
      ...(req.user.subscription === "pro" && getPool() ? SALES_SHEETS : []),
      ...(plan.features.estadisticas === true ? VISIT_SHEETS : []),
    ];
    const requested = typeof req.query.sheets === "string" && req.query.sheets
      ? req.query.sheets.split(",")
      : allowed;
    const sheets = new Set(requested.filter((sheet) => allowed.includes(sheet)));
    if (sheets.size === 0) {
      return res.status(403).json({
        code: "FEATURE_NOT_INCLUDED",
        feature: "estadisticas",
        message: "Tu plan no incluye los reportes que elegiste.",
      });
    }

    const wants = (group) => group.some((sheet) => sheets.has(sheet));
    const [sales, visits] = await Promise.all([
      wants(SALES_SHEETS) ? loadSales(String(req.user._id), dates, sheets) : null,
      wants(VISIT_SHEETS) ? loadVisits(req.user._id, dates, sheets) : null,
    ]);

    const workbook = buildReportWorkbook({
      businessName: req.user.contactInfo?.businessName || req.user.username,
      from: req.query.from,
      to: req.query.to,
      generatedAt: new Date(),
      sheets,
      sales,
      visits,
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=reporte-${req.query.from}-a-${req.query.to}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = { exportReport };
