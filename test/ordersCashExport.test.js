// Excel del cierre de una caja ("Exportar cierre a Excel" del menú de Caja).

const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { cashCloseWorkbook, cashCloseFileName } = require("../src/orders/services/cashExport");

const session = {
  id: 9, registerName: "Barra Principal", cashierName: "Ana", openedAt: "2026-10-14T12:00:00Z", openedByName: "Lucas",
  closedAt: "2026-10-14T23:30:00Z", closedByName: "Lucas", openingAmount: 5000, cashCounted: 18250, difference: -250,
  cashWithdrawn: 15000, cashLeft: 3250, closingNotes: "Faltó cambio",
  summary: {
    ordersCount: 12, salesCount: 11, salesAmount: 20000, cancelledCount: 1, cancelledAmount: 1500, returnedCount: 0,
    returnedAmount: 0, discountsAmount: 500, netAmount: 19500, onlineAmount: 3000, cashSalesAmount: 14000, incomeAmount: 0,
    expenseAmount: 500, withdrawalAmount: 0, expectedCash: 18500,
    paymentsBreakdown: [{ method: "Débito", kind: "debit", count: 2, amount: 2500 }], pendingCount: 0,
  },
};

const entries = [
  { at: "2026-10-14T12:00:00Z", label: "Apertura", detail: null, direction: "none", cash: true, amount: 5000, actorName: "Lucas", voided: false },
  { at: "2026-10-14T15:00:00Z", label: "Egreso · Proveedores", detail: "Hielo", direction: "out", cash: true, amount: 500, actorName: "Ana", voided: true, voidReason: "Duplicado" },
];

const reread = async (workbook) => {
  const copy = new ExcelJS.Workbook();
  await copy.xlsx.load(await workbook.xlsx.writeBuffer());
  return copy;
};

test("el cierre trae el resumen, los cobros por medio y el libro completo", async () => {
  const book = await reread(cashCloseWorkbook(session, entries));
  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ["Cierre", "Cobros por medio", "Movimientos"]);

  const summary = book.getWorksheet("Cierre");
  const rows = new Map();
  summary.eachRow((row) => rows.set(row.getCell(1).value, row.getCell(2).value));
  assert.equal(summary.getRow(1).getCell(1).value, "Cierre de Barra Principal");
  assert.equal(rows.get("Neto"), 19500);
  assert.equal(rows.get("Esperado en el cajón"), 18500);
  assert.equal(rows.get("Diferencia"), -250);
  assert.equal(rows.get("Notas"), "Faltó cambio");
  assert.ok(rows.get("Cierre") instanceof Date, "las fechas van como fechas");

  const payments = book.getWorksheet("Cobros por medio");
  assert.equal(payments.getRow(2).getCell(1).value, "Débito");
  assert.equal(payments.getRow(2).getCell(3).value, 2500);

  const ledger = book.getWorksheet("Movimientos");
  assert.equal(ledger.rowCount, 3);
  assert.equal(ledger.getRow(3).getCell(4).value, "Sale");
  assert.equal(ledger.getRow(3).getCell(8).value, "Sí · Duplicado");
});

test("el archivo se nombra con la caja y el día del cierre (en Buenos Aires)", () => {
  assert.equal(cashCloseFileName(session), "cierre-barra-principal-2026-10-14.xlsx");
  assert.equal(cashCloseFileName({ ...session, closedAt: "2026-10-15T02:00:00Z" }), "cierre-barra-principal-2026-10-14.xlsx");
});
