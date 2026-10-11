// Arma el Excel de reportes de Estadísticas (GET /api/users/me/reports/export).
// Función pura sobre datos ya consultados: no toca bases ni la respuesta HTTP,
// así se puede probar leyendo el libro que devuelve.
//
// Las fechas van como celdas de fecha y los importes como números con
// formato, no como texto: el archivo es para filtrar, sumar y armar tablas
// dinámicas, no solo para leerlo.

const ExcelJS = require("exceljs");

const MONEY = '"$" #,##0.00';
const INTEGER = "#,##0";
const PERCENT = "0.0%";
const DATE = "dd/mm/yyyy";
const DATE_TIME = "dd/mm/yyyy hh:mm";

// ExcelJS escribe las fechas en UTC. Un día "YYYY-MM-DD" va a medianoche UTC
// y un instante se corre a la hora de Buenos Aires (UTC-3 fijo, ver
// utils/dates) para que la celda muestre la hora del local.
const BA_OFFSET_MS = 3 * 60 * 60 * 1000;
const dayCell = (day) => new Date(`${day}T00:00:00Z`);
const instantCell = (value) => (value ? new Date(new Date(value).getTime() - BA_OFFSET_MS) : null);

const SERVICE_LABEL = { table: "Mesa", counter: "Barra", takeaway: "Take away", delivery: "Delivery" };
const SOURCE_LABEL = { customer: "Desde la mesa (QR)", waiter: "Operador", panel: "Cargado en el panel" };
const PAYMENT_LABEL = { none: "En el local", mercadopago: "Mercado Pago (online)" };
const STATUS_LABEL = {
  pending: "Sin confirmar", confirmed: "En preparación", ready: "Listo",
  delivered: "Entregado", cancelled: "Cancelado", returned: "Devuelto",
};

// Hoja con encabezado fijo, filtros y formato por columna.
// columns: [{ header, key, width, numFmt? }]
const addSheet = (workbook, name, columns, rows, { totals } = {}) => {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  const head = sheet.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: "middle", wrapText: true };
  head.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1EDE8" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFBDB5AA" } } };
  });
  columns.forEach(({ key, numFmt }) => { if (numFmt) sheet.getColumn(key).numFmt = numFmt; });
  rows.forEach((row) => sheet.addRow(row));
  if (rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: columns.length } };
  }
  if (totals && rows.length > 0) {
    const row = sheet.addRow(totals);
    row.font = { bold: true };
    row.eachCell((cell) => { cell.border = { top: { style: "thin", color: { argb: "FFBDB5AA" } } }; });
  }
  return sheet;
};

const share = (value, total) => (total > 0 ? value / total : 0);

const addSummary = (workbook, { businessName, from, to, generatedAt, sales, visits }) => {
  const sheet = workbook.addWorksheet("Resumen");
  sheet.columns = [{ key: "label", width: 38 }, { key: "value", width: 24 }];
  const title = sheet.addRow({ label: businessName || "Reporte" });
  title.font = { bold: true, size: 14 };
  sheet.addRow({ label: "Período", value: `${from.split("-").reverse().join("/")} al ${to.split("-").reverse().join("/")}` });
  const generated = sheet.addRow({ label: "Generado", value: instantCell(generatedAt) });
  generated.getCell("value").numFmt = DATE_TIME;
  generated.getCell("value").alignment = { horizontal: "left" };

  const section = (name) => {
    sheet.addRow({});
    sheet.addRow({ label: name }).font = { bold: true };
  };
  const metric = (label, value, numFmt) => {
    const row = sheet.addRow({ label, value });
    if (numFmt) row.getCell("value").numFmt = numFmt;
    row.getCell("value").alignment = { horizontal: "left" };
  };

  if (sales) {
    const { totals, cashSessions } = sales;
    section("Ventas");
    metric("Vendido", totals.amount, MONEY);
    metric("Pedidos", totals.orders, INTEGER);
    metric("Ticket promedio", totals.averageTicket, MONEY);
    metric("Descuentos", totals.discounts, MONEY);
    metric("Pedidos anulados", totals.cancelledCount, INTEGER);
    metric("Importe anulado", totals.cancelledAmount, MONEY);
    metric("Pedidos devueltos", totals.returnedCount, INTEGER);
    metric("Importe devuelto", totals.returnedAmount, MONEY);
    section("Caja");
    metric("Cierres de caja", cashSessions.length, INTEGER);
    const counted = cashSessions.filter((session) => session.difference !== null);
    metric("Cierres con efectivo contado", counted.length, INTEGER);
    metric("Diferencia acumulada", counted.reduce((sum, session) => sum + session.difference, 0), MONEY);
  }
  if (visits) {
    const total = visits.days.reduce((sum, day) => sum + day.count, 0);
    section("Visitas a la carta");
    metric("Visitas", total, INTEGER);
    metric("Promedio por día", visits.days.length ? Math.round((total / visits.days.length) * 10) / 10 : 0, "#,##0.0");
    metric("Pedidos enviados por WhatsApp", visits.days.reduce((sum, day) => sum + (day.orders ?? 0), 0), INTEGER);
  }
};

/**
 * @param {object} data
 *   businessName, from, to ("YYYY-MM-DD"), generatedAt (Date)
 *   sheets: Set con las hojas pedidas (ver SHEET_KEYS)
 *   sales:  null | { days, totals, breakdown, orders: { orders, truncated }, cashSessions }
 *   visits: null | { days, items }
 */
const buildReportWorkbook = (data) => {
  const { sheets, sales, visits } = data;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Menú Digital";
  workbook.created = data.generatedAt;
  addSummary(workbook, data);

  if (sales && sheets.has("ventas")) {
    addSheet(workbook, "Ventas por día", [
      { header: "Fecha", key: "date", width: 13, numFmt: DATE },
      { header: "Pedidos", key: "orders", width: 10, numFmt: INTEGER },
      { header: "Vendido", key: "amount", width: 16, numFmt: MONEY },
      { header: "Ticket promedio", key: "ticket", width: 16, numFmt: MONEY },
      { header: "Descuentos", key: "discounts", width: 14, numFmt: MONEY },
      { header: "Anulados", key: "cancelledCount", width: 10, numFmt: INTEGER },
      { header: "Importe anulado", key: "cancelledAmount", width: 16, numFmt: MONEY },
      { header: "Devueltos", key: "returnedCount", width: 10, numFmt: INTEGER },
      { header: "Importe devuelto", key: "returnedAmount", width: 16, numFmt: MONEY },
    ], sales.days.map((day) => ({
      ...day,
      date: dayCell(day.date),
      ticket: day.orders > 0 ? Math.round((day.amount / day.orders) * 100) / 100 : null,
    })), { totals: { ...sales.totals, date: "Total", ticket: sales.totals.averageTicket } });
  }

  if (sales && sheets.has("productos")) {
    const total = sales.breakdown.topProducts.reduce((sum, product) => sum + product.amount, 0);
    addSheet(workbook, "Productos vendidos", [
      { header: "Producto", key: "title", width: 34 },
      { header: "Variante", key: "option", width: 20 },
      { header: "Categoría", key: "category", width: 22 },
      { header: "Unidades", key: "quantity", width: 11, numFmt: INTEGER },
      { header: "Importe", key: "amount", width: 16, numFmt: MONEY },
      { header: "% del importe", key: "share", width: 14, numFmt: PERCENT },
    ], sales.breakdown.topProducts.map((product) => ({ ...product, share: share(product.amount, total) })));
  }

  if (sales && sheets.has("desgloses")) {
    const { breakdown, totals } = sales;
    const group = (name, rows, label) => rows.map((row) => ({
      group: name, detail: label(row.key), count: row.count, amount: row.amount, share: share(row.amount, totals.amount),
    }));
    addSheet(workbook, "Desgloses", [
      { header: "Desglose", key: "group", width: 20 },
      { header: "Detalle", key: "detail", width: 28 },
      { header: "Pedidos", key: "count", width: 10, numFmt: INTEGER },
      { header: "Importe", key: "amount", width: 16, numFmt: MONEY },
      { header: "% del importe", key: "share", width: 14, numFmt: PERCENT },
    ], [
      ...group("Tipo de pedido", breakdown.byServiceType, (key) => SERVICE_LABEL[key] || key),
      ...group("Origen", breakdown.bySource, (key) => SOURCE_LABEL[key] || key),
      ...group("Forma de pago", breakdown.byPayment, (key) => PAYMENT_LABEL[key] || key),
      ...group("Operador", breakdown.byWaiter, (key) => key || "Sin operador"),
      ...breakdown.byCategory.map((row) => ({
        group: "Categoría", detail: row.name || "Sin categoría", count: null, amount: row.amount,
        share: share(row.amount, totals.amount),
      })),
      ...breakdown.hours.map((hour, index) => ({ hour, index })).filter(({ hour }) => hour.count > 0).map(({ hour, index }) => ({
        group: "Hora", detail: `${index} a ${(index + 1) % 24} h`, count: hour.count, amount: hour.amount,
        share: share(hour.amount, totals.amount),
      })),
    ]);
  }

  if (sales && sheets.has("pedidos")) {
    const sheet = addSheet(workbook, "Pedidos", [
      { header: "Fecha y hora", key: "createdAt", width: 18, numFmt: DATE_TIME },
      { header: "N.º", key: "number", width: 7 },
      { header: "Estado", key: "status", width: 16 },
      { header: "Tipo", key: "serviceType", width: 12 },
      { header: "Mesa", key: "tableNumber", width: 7 },
      { header: "Origen", key: "source", width: 22 },
      { header: "Operador", key: "waiterName", width: 18 },
      { header: "Cliente", key: "customerName", width: 20 },
      { header: "Forma de pago", key: "paymentMode", width: 22 },
      { header: "Unidades", key: "units", width: 10, numFmt: INTEGER },
      { header: "Subtotal", key: "subtotal", width: 14, numFmt: MONEY },
      { header: "Descuento", key: "discountAmount", width: 13, numFmt: MONEY },
      { header: "Total", key: "total", width: 14, numFmt: MONEY },
      { header: "Motivo (anulación o devolución)", key: "statusReason", width: 34 },
    ], sales.orders.orders.map((order) => ({
      ...order,
      createdAt: instantCell(order.createdAt),
      status: STATUS_LABEL[order.status] || order.status,
      serviceType: SERVICE_LABEL[order.serviceType] || order.serviceType,
      source: SOURCE_LABEL[order.source] || order.source,
      paymentMode: PAYMENT_LABEL[order.paymentMode] || order.paymentMode,
    })));
    if (sales.orders.truncated) {
      sheet.addRow({ status: `Se muestran los primeros ${sales.orders.orders.length} pedidos: elegí un período más corto para verlos todos.` });
    }
  }

  if (sales && sheets.has("caja")) {
    addSheet(workbook, "Cierres de caja", [
      { header: "Caja", key: "registerName", width: 18 },
      { header: "Cajero", key: "cashierName", width: 18 },
      { header: "Apertura", key: "openedAt", width: 18, numFmt: DATE_TIME },
      { header: "Cierre", key: "closedAt", width: 18, numFmt: DATE_TIME },
      { header: "Fondo inicial", key: "openingAmount", width: 14, numFmt: MONEY },
      { header: "Pedidos", key: "salesCount", width: 10, numFmt: INTEGER },
      { header: "Vendido", key: "salesAmount", width: 15, numFmt: MONEY },
      { header: "Anulado", key: "cancelledAmount", width: 14, numFmt: MONEY },
      { header: "Devuelto", key: "returnedAmount", width: 14, numFmt: MONEY },
      { header: "Descuentos", key: "discountsAmount", width: 14, numFmt: MONEY },
      { header: "Neto", key: "netAmount", width: 15, numFmt: MONEY },
      { header: "Efectivo esperado", key: "expectedCash", width: 17, numFmt: MONEY },
      { header: "Efectivo contado", key: "cashCounted", width: 17, numFmt: MONEY },
      { header: "Diferencia", key: "difference", width: 14, numFmt: MONEY },
      { header: "Notas", key: "closingNotes", width: 34 },
    ], sales.cashSessions.map((session) => ({
      ...session.summary,
      registerName: session.registerName,
      cashierName: session.cashierName,
      openedAt: instantCell(session.openedAt),
      closedAt: instantCell(session.closedAt),
      openingAmount: session.openingAmount,
      cashCounted: session.cashCounted,
      difference: session.difference,
      closingNotes: session.closingNotes,
    })));
  }

  if (visits && sheets.has("visitas")) {
    addSheet(workbook, "Visitas por día", [
      { header: "Fecha", key: "date", width: 13, numFmt: DATE },
      { header: "Visitas", key: "count", width: 10, numFmt: INTEGER },
      { header: "Visitantes", key: "visitors", width: 12, numFmt: INTEGER },
      { header: "Ya habían venido", key: "returning", width: 16, numFmt: INTEGER },
      { header: "Llegaron por el QR", key: "qr", width: 17, numFmt: INTEGER },
      { header: "Abrieron un producto", key: "engaged", width: 19, numFmt: INTEGER },
      { header: "Armaron un pedido", key: "carts", width: 17, numFmt: INTEGER },
      { header: "Pedidos por WhatsApp", key: "orders", width: 19, numFmt: INTEGER },
    ], visits.days.map((day) => ({ ...day, date: dayCell(day.date) })));
  }

  if (visits && sheets.has("vistos")) {
    addSheet(workbook, "Productos vistos", [
      { header: "Producto", key: "title", width: 34 },
      { header: "Vistas", key: "views", width: 10, numFmt: INTEGER },
      { header: "Pedidos por WhatsApp", key: "orders", width: 19, numFmt: INTEGER },
    ], visits.items);
  }

  return workbook;
};

const SALES_SHEETS = ["ventas", "productos", "desgloses", "pedidos", "caja"];
const VISIT_SHEETS = ["visitas", "vistos"];

module.exports = { buildReportWorkbook, SALES_SHEETS, VISIT_SHEETS };
