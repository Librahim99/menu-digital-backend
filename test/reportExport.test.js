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
      cashCounted: 49500, difference: -500, closingNotes: null, cashWithdrawn: 29500, cashLeft: 20000,
      summary: {
        salesCount: 2, salesAmount: 30000, cancelledAmount: 5000, returnedAmount: 0, discountsAmount: 0, netAmount: 30000,
        onlineAmount: 0, cashSalesAmount: 34000, incomeAmount: 0, expenseAmount: 4000, withdrawalAmount: 0, expectedCash: 50000,
      },
    }],
    cash: {
      totals: {
        closings: 1, netAmount: 30000, countedCount: 1, difference: -500, exactCount: 0, shortCount: 1, shortAmount: -500,
        overCount: 0, overAmount: 0, cashSalesAmount: 24000, onlineAmount: 0, incomeAmount: 0, expenseAmount: 4000, withdrawalAmount: 29500,
      },
      byMethod: [{ kind: "cash", label: "Efectivo", count: null, amount: 24000 }, { kind: "credit", label: "Crédito", count: 1, amount: 6000 }],
      movements: [
        { type: "withdrawal", typeLabel: "Retiro", category: "closing", label: "Retiro al cerrar la caja", count: 1, amount: 29500 },
        { type: "expense", typeLabel: "Egreso", category: "supplier", label: "Proveedor", count: 1, amount: 4000 },
      ],
      byCashier: [{ name: "Carla", closings: 1, netAmount: 30000, countedCount: 1, difference: -500, exactCount: 0, shortCount: 1, shortAmount: -500, overCount: 0, overAmount: 0 }],
      byRegister: [{ name: "Caja principal", closings: 1, netAmount: 30000, countedCount: 1, difference: -500, exactCount: 0, shortCount: 1, shortAmount: -500, overCount: 0, overAmount: 0 }],
    },
    cashMovements: {
      truncated: false,
      movements: [{
        id: 1, createdAt: "2026-09-01T23:30:00.000Z", registerName: "Caja principal", cashierName: "Carla", type: "Egreso",
        category: "Proveedor", notes: "Verdulería", amount: 4000, actorName: "Panel", voided: false, voidReason: null,
      }],
    },
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
    "Desgloses de caja", "Movimientos de caja", "Visitas por día", "Productos vistos",
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
  assert.equal(cash.getCell("O1").value, "Egresos");
  assert.equal(cash.getCell("O2").value, 4000);
  assert.equal(cash.getCell("S1").value, "Diferencia");
  assert.equal(cash.getCell("S2").value, -500);
  assert.equal(cash.getCell("U2").value, 20000, "lo que quedó en la caja");

  const breakdown = workbook.getWorksheet("Desgloses de caja");
  const rows = [];
  breakdown.eachRow((row, index) => { if (index > 1) rows.push([row.getCell(1).value, row.getCell(2).value, row.getCell(4).value]); });
  assert.deepEqual(rows, [
    ["Cómo se cobró", "Efectivo", 24000],
    ["Cómo se cobró", "Crédito", 6000],
    ["Retiro", "Retiro al cerrar la caja", 29500],
    ["Egreso", "Proveedor", 4000],
    ["Por cajero (cierres y neto)", "Carla", 30000],
    ["Por caja (cierres y neto)", "Caja principal", 30000],
  ]);

  const movements = workbook.getWorksheet("Movimientos de caja");
  assert.equal(movements.getCell("A2").value.toISOString(), "2026-09-01T20:30:00.000Z");
  assert.equal(movements.getCell("E2").value, "Proveedor");
  assert.equal(movements.getCell("G2").value, 4000);
  assert.equal(movements.getCell("I2").value, "Vigente");
  // Un día sin medición de audiencia queda en blanco, no en cero.
  assert.equal(workbook.getWorksheet("Visitas por día").getCell("C2").value, null);
});

test("solo arma las hojas pedidas y disponibles", () => {
  const base = { businessName: "La Perla", from: "2026-09-01", to: "2026-09-03", generatedAt: new Date() };
  const onlyCash = buildReportWorkbook({ ...base, sheets: new Set(["caja"]), sales: salesData(), visits: null });
  assert.deepEqual(sheetNames(onlyCash), ["Resumen", "Cierres de caja", "Desgloses de caja"]);
  // Un servidor que no calculó el reporte de caja (datos viejos) no rompe el libro.
  const { cash: _cash, cashMovements: _movements, ...legacy } = salesData();
  const withoutReport = buildReportWorkbook({ ...base, sheets: new Set(["caja", "movimientos"]), sales: legacy, visits: null });
  assert.deepEqual(sheetNames(withoutReport), ["Resumen", "Cierres de caja"]);
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
