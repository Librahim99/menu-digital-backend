// Excel del cierre de una caja (menú contextual de Caja: "Exportar cierre a
// Excel"). Función pura sobre la caja y su libro ya consultados: no toca la
// base ni la respuesta HTTP, así se prueba leyendo el libro que devuelve.
//
// Mismo criterio que los reportes de Estadísticas (services/reportWorkbook):
// importes como números con formato y fechas como celdas de fecha en la hora
// de Buenos Aires, para poder sumar y filtrar.

const ExcelJS = require("exceljs");

const MONEY = '"$" #,##0.00';
const DATE_TIME = "dd/mm/yyyy hh:mm";
const BA_OFFSET_MS = 3 * 60 * 60 * 1000;
const instantCell = (value) => (value ? new Date(new Date(value).getTime() - BA_OFFSET_MS) : null);

const DIRECTION_LABEL = { in: "Entra", out: "Sale", none: "—" };

const styleHead = (row) => {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1EDE8" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFBDB5AA" } } };
  });
};

const addSummarySheet = (workbook, session) => {
  const sheet = workbook.addWorksheet("Cierre");
  sheet.columns = [{ key: "label", width: 34 }, { key: "value", width: 26 }];
  sheet.addRow({ label: `Cierre de ${session.registerName}` }).font = { bold: true, size: 14 };

  const line = (label, value, numFmt) => {
    const row = sheet.addRow({ label, value: value ?? "—" });
    if (numFmt && value !== null && value !== undefined) row.getCell("value").numFmt = numFmt;
    row.getCell("value").alignment = { horizontal: "left" };
  };
  const section = (name) => {
    sheet.addRow({});
    sheet.addRow({ label: name }).font = { bold: true };
  };

  line("Cajero", session.cashierName || "Sin indicar");
  line("Apertura", instantCell(session.openedAt), DATE_TIME);
  line("Abrió", session.openedByName);
  line("Cierre", instantCell(session.closedAt), DATE_TIME);
  line("Cerró", session.closedByName);
  line("Fondo inicial", session.openingAmount, MONEY);

  const summary = session.summary;
  if (summary) {
    section("Ventas");
    line("Pedidos", summary.ordersCount);
    line("Ventas", summary.salesAmount, MONEY);
    line("Descuentos", summary.discountsAmount, MONEY);
    line(`Cancelados (${summary.cancelledCount})`, summary.cancelledAmount, MONEY);
    line(`Devueltos (${summary.returnedCount})`, summary.returnedAmount, MONEY);
    line("Neto", summary.netAmount, MONEY);
    line("Cobrado online (Mercado Pago)", summary.onlineAmount, MONEY);
    line("Ventas en efectivo", summary.cashSalesAmount, MONEY);

    section("Efectivo");
    line("Ingresos", summary.incomeAmount, MONEY);
    line("Egresos", summary.expenseAmount, MONEY);
    line("Retiros", summary.withdrawalAmount, MONEY);
    line("Esperado en el cajón", summary.expectedCash, MONEY);
  }

  section("Arqueo");
  line("Contado", session.cashCounted, MONEY);
  line("Diferencia", session.difference, MONEY);
  line("Retirado al cerrar", session.cashWithdrawn, MONEY);
  line("Quedó en el cajón", session.cashLeft, MONEY);
  if (session.closingNotes) line("Notas", session.closingNotes);
  return sheet;
};

const addPaymentsSheet = (workbook, session) => {
  const sheet = workbook.addWorksheet("Cobros por medio", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Medio", key: "method", width: 26 },
    { header: "Cobros", key: "count", width: 10 },
    { header: "Total", key: "amount", width: 16 },
  ];
  styleHead(sheet.getRow(1));
  sheet.getColumn("amount").numFmt = MONEY;
  for (const row of session.summary?.paymentsBreakdown ?? []) sheet.addRow(row);
  return sheet;
};

const addLedgerSheet = (workbook, entries) => {
  const sheet = workbook.addWorksheet("Movimientos", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Fecha", key: "at", width: 18 },
    { header: "Movimiento", key: "label", width: 34 },
    { header: "Detalle", key: "detail", width: 30 },
    { header: "Entra / sale", key: "direction", width: 12 },
    { header: "Efectivo", key: "cash", width: 10 },
    { header: "Importe", key: "amount", width: 16 },
    { header: "Quién", key: "actor", width: 18 },
    { header: "Anulado", key: "voided", width: 22 },
  ];
  styleHead(sheet.getRow(1));
  sheet.getColumn("at").numFmt = DATE_TIME;
  sheet.getColumn("amount").numFmt = MONEY;
  for (const entry of entries) {
    sheet.addRow({
      at: instantCell(entry.at),
      label: entry.label,
      detail: entry.detail ?? "",
      direction: DIRECTION_LABEL[entry.direction] ?? entry.direction,
      cash: entry.cash ? "Sí" : "No",
      amount: entry.amount,
      actor: entry.actorName ?? "",
      voided: entry.voided ? `Sí${entry.voidReason ? ` · ${entry.voidReason}` : ""}` : "",
    });
  }
  if (entries.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: entries.length + 1, column: 8 } };
  }
  return sheet;
};

/**
 * @param {object} session  caja (CashSessionDTO), cerrada o abierta
 * @param {object[]} entries movimientos del libro (LedgerDTO), todos
 */
const cashCloseWorkbook = (session, entries) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Menú Digital";
  addSummarySheet(workbook, session);
  addPaymentsSheet(workbook, session);
  addLedgerSheet(workbook, entries);
  return workbook;
};

/** Nombre del archivo: "cierre-barra-2026-10-14.xlsx". */
const cashCloseFileName = (session) => {
  const slug = String(session.registerName || "caja")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "caja";
  const day = new Date(new Date(session.closedAt || session.openedAt).getTime() - BA_OFFSET_MS).toISOString().slice(0, 10);
  return `cierre-${slug}-${day}.xlsx`;
};

module.exports = { cashCloseWorkbook, cashCloseFileName };
