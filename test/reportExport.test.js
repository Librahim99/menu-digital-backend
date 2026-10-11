const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const ExcelJS = require("exceljs");
const mongoose = require("mongoose");
const PageView = require("../src/models/PageView");
const ItemView = require("../src/models/ItemView");
const { buildReportWorkbook, SALES_SHEETS, VISIT_SHEETS } = require("../src/services/reportWorkbook");
const { sumDays } = require("../src/orders/services/reportService");
const { exportReport } = require("../src/controllers/reportExportController");

// Reporte en Excel de Estadísticas: qué hojas salen según lo pedido y el plan.

const day = (date, over = {}) => ({
  date, orders: 0, amount: 0, discounts: 0,
  cancelledCount: 0, cancelledAmount: 0, returnedCount: 0, returnedAmount: 0, ...over,
});

const salesData = () => {
  const days = [
    day("2026-09-01", { orders: 2, amount: 30000, cancelledCount: 1, cancelledAmount: 5000 }),
    day("2026-09-02"),
    day("2026-09-03", { orders: 1, amount: 12000.5 }),
  ];
  return {
    days,
    totals: sumDays(days),
    breakdown: {
      byServiceType: [{ key: "table", count: 2, amount: 30000 }, { key: "delivery", count: 1, amount: 12000.5 }],
      bySource: [{ key: "waiter", count: 3, amount: 42000.5 }],
      byWaiter: [{ key: "", count: 3, amount: 42000.5 }],
      byPayment: [{ key: "none", count: 3, amount: 42000.5 }],
      byCategory: [{ name: "Pizzas", quantity: 4, amount: 42000.5 }],
      hours: Array.from({ length: 24 }, (_, hour) => (hour === 21 ? { count: 3, amount: 42000.5 } : { count: 0, amount: 0 })),
      topProducts: [{ title: "Pizza", option: "Grande", category: "Pizzas", quantity: 4, amount: 42000.5 }],
    },
    orders: {
      truncated: false,
      orders: [{
        id: 1, number: 7, createdAt: "2026-09-01T23:30:00.000Z", status: "delivered", source: "waiter", serviceType: "table",
        tableNumber: 4, waiterName: "Sofía", customerName: null, paymentMode: "none", subtotal: 15000, discountAmount: 0,
        total: 15000, statusReason: null, units: 2,
      }],
    },
    cashSessions: [{
      registerName: "Caja principal", cashierName: "Carla", openingAmount: 20000,
      openedAt: "2026-09-01T15:00:00.000Z", closedAt: "2026-09-02T03:30:00.000Z",
      cashCounted: 49500, difference: -500, closingNotes: null,
      summary: { salesCount: 2, salesAmount: 30000, cancelledAmount: 5000, returnedAmount: 0, discountsAmount: 0, netAmount: 30000, expectedCash: 50000 },
    }],
  };
};

const sheetNames = (workbook) => workbook.worksheets.map((sheet) => sheet.name);

test("totales del período: suma los días y calcula el ticket promedio", () => {
  const totals = sumDays(salesData().days);
  assert.equal(totals.orders, 3);
  assert.equal(totals.amount, 42000.5);
  assert.equal(totals.averageTicket, 14000.17);
  assert.equal(totals.cancelledCount, 1);
  assert.equal(sumDays([]).averageTicket, 0);
});

test("libro completo: una hoja por reporte, con fechas e importes como valores", () => {
  const workbook = buildReportWorkbook({
    businessName: "La Perla", from: "2026-09-01", to: "2026-09-03", generatedAt: new Date("2026-09-04T12:00:00Z"),
    sheets: new Set([...SALES_SHEETS, ...VISIT_SHEETS]),
    sales: salesData(),
    visits: {
      days: [{ date: "2026-09-01", count: 10, visitors: null, returning: null, qr: null, engaged: null, carts: null, orders: null }],
      items: [{ title: "Pizza", views: 8, orders: 1 }],
    },
  });
  assert.deepEqual(sheetNames(workbook), [
    "Resumen", "Ventas por día", "Productos vendidos", "Desgloses", "Pedidos", "Cierres de caja",
    "Visitas por día", "Productos vistos",
  ]);

  const sales = workbook.getWorksheet("Ventas por día");
  assert.ok(sales.getCell("A2").value instanceof Date);
  assert.equal(sales.getCell("C2").value, 30000);
  assert.equal(sales.getCell("D3").value, null, "un día sin pedidos no tiene ticket");
  assert.equal(sales.getCell("A5").value, "Total");
  assert.equal(sales.getCell("C5").value, 42000.5);

  // 23:30 UTC son las 20:30 en Buenos Aires: la celda muestra la hora del local.
  const orders = workbook.getWorksheet("Pedidos");
  assert.equal(orders.getCell("A2").value.toISOString(), "2026-09-01T20:30:00.000Z");
  assert.equal(orders.getCell("C2").value, "Entregado");

  const cash = workbook.getWorksheet("Cierres de caja");
  assert.equal(cash.getCell("N2").value, -500);
  // Un día sin medición de audiencia queda en blanco, no en cero.
  assert.equal(workbook.getWorksheet("Visitas por día").getCell("C2").value, null);
});

test("solo arma las hojas pedidas y disponibles", () => {
  const base = { businessName: "La Perla", from: "2026-09-01", to: "2026-09-03", generatedAt: new Date() };
  const onlyCash = buildReportWorkbook({ ...base, sheets: new Set(["caja"]), sales: salesData(), visits: null });
  assert.deepEqual(sheetNames(onlyCash), ["Resumen", "Cierres de caja"]);
  const noSales = buildReportWorkbook({
    ...base, sheets: new Set(["ventas", "visitas"]), sales: null, visits: { days: [], items: [] },
  });
  assert.deepEqual(sheetNames(noSales), ["Resumen", "Visitas por día"]);
});

const response = () => {
  const res = new PassThrough();
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  return Object.assign(res, {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    buffer: () => Buffer.concat(chunks),
  });
};

const user = { _id: new mongoose.Types.ObjectId(), username: "laperla", subscription: "basic" };
// req.plan ya resuelto: getRequestPlan lo reusa sin consultar el catálogo.
const request = (query, features = { estadisticas: true }) => ({ user, query, plan: { features } });

test("exportación: rechaza períodos inválidos, futuros o de más de un año", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-16T15:00:00Z").getTime() });
  for (const query of [
    {}, { from: "2026-09-01" }, { from: "2026-09-10", to: "2026-09-01" }, { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-09-01", to: "2026-09-17" }, { from: "2025-09-01", to: "2026-09-16" },
  ]) {
    const res = response();
    await exportReport(request(query), res);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
  }
});

test("exportación: 403 si el plan no incluye ninguna hoja pedida", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-16T15:00:00Z").getTime() });
  const noStats = response();
  await exportReport(request({ from: "2026-09-01", to: "2026-09-16" }, { estadisticas: false }), noStats);
  assert.equal(noStats.statusCode, 403);
  // Con estadísticas pero sin Pro, las hojas de ventas no existen.
  const onlySales = response();
  await exportReport(request({ from: "2026-09-01", to: "2026-09-16", sheets: "ventas,caja" }), onlySales);
  assert.equal(onlySales.statusCode, 403);
  assert.equal(onlySales.body.code, "FEATURE_NOT_INCLUDED");
});

test("exportación: sin Pro devuelve solo las visitas del local autenticado", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-16T15:00:00Z").getTime() });
  t.mock.method(PageView, "find", async (query) => {
    assert.equal(query.userID, user._id);
    assert.deepEqual(query.date, { $gte: "2026-09-14", $lte: "2026-09-16" });
    return [{ date: "2026-09-15", count: 12, tracked: 12, visitors: 9, qr: 4 }];
  });
  t.mock.method(ItemView, "aggregate", async () => []);
  const res = response();
  await exportReport(request({ from: "2026-09-14", to: "2026-09-16", userID: "otro-local" }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Disposition"], /reporte-2026-09-14-a-2026-09-16\.xlsx/);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.buffer());
  assert.deepEqual(sheetNames(workbook), ["Resumen", "Visitas por día", "Productos vistos"]);
  const visits = workbook.getWorksheet("Visitas por día");
  assert.equal(visits.rowCount, 4);
  assert.equal(visits.getCell("B3").value, 12);
  assert.equal(visits.getCell("B2").value, 0);
});

// Una ruta con un handler sin exportar tira al cargar el router: la API no levanta.
test("las rutas de pedidos cargan con todos sus handlers", () => {
  const router = require("../src/orders/routes");
  const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.ok(paths.includes("/reports/sales"));
  assert.equal(typeof require("../src/orders/controllers/ownerController").getSalesReport, "function");
  assert.equal(typeof require("../src/controllers/reportExportController").exportReport, "function");
});
