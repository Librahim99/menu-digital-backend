const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startOrdersDb, fakeCatalog } = require("../test-support/ordersDb");

// Circuito de caja: movimientos, efectivo esperado, arqueo, pedidos en curso
// al cerrar, libro de la caja e historial filtrado.
// Corre contra SQL de verdad en memoria, con las migraciones reales.

const PIZZA = "a".repeat(24);
const BEER = "b".repeat(24);
const PRODUCTS = {
  [PIZZA]: { title: "Pizza", price: 10000 },
  [BEER]: { title: "Cerveza", price: 2500 },
};
const PANEL = { type: "panel", id: "panel", name: "Panel" };
const BILL = { actor: PANEL, waiterId: null };

let db;
let cash;
let orders;
let bill;
let settings;
let waiters;
let seq = 0;

test.before(async () => {
  db = await startOrdersDb(null, { catalog: fakeCatalog({ products: PRODUCTS }) });
  cash = db.load("services/cashService");
  orders = db.load("services/orderService");
  bill = db.load("services/billService");
  settings = db.load("services/settingsService");
  waiters = db.load("services/waiterService");
});
test.after(() => db.close());

// Un local nuevo por test: nada se pisa entre casos.
const venue = async () => {
  seq += 1;
  const owner = { _id: `owner-cash-${seq}`, slug: `caja-${seq}` };
  return { owner, ownerId: owner._id, settings: await settings.getOrCreateSettings(owner._id) };
};

const line = (itemId, quantity = 1) => ({ itemId, option: null, quantity, notes: null });

const order = async (v, lines, over = {}) => (await orders.createOrder({
  owner: v.owner, settings: v.settings, source: "panel", lines, serviceType: "counter", actor: PANEL, ...over,
})).order;

const openOf = async (v) => (await cash.listOpenSessions(v.ownerId))[0];
const rejects = (promise, status, code) => assert.rejects(promise, (error) => {
  assert.equal(error.status, status, error.message);
  if (code) assert.equal(error.code, code);
  return true;
});

test("efectivo esperado: fondo + ventas + ingresos − egresos − retiros", async () => {
  const v = await venue();
  const session = await cash.openSession(v.ownerId, { openingAmount: 5000 }, PANEL);
  await order(v, [line(PIZZA), line(BEER, 2)]);

  await cash.addMovement(v.ownerId, session.id, { type: "income", category: "change", amount: 2000 }, PANEL);
  await cash.addMovement(v.ownerId, session.id, { type: "expense", category: "supplier", amount: 4000, notes: "Verdulería" }, PANEL);
  const { session: live } = await cash.addMovement(v.ownerId, session.id, { type: "withdrawal", category: "owner", amount: 3000 }, PANEL);

  assert.equal(live.summary.cashSalesAmount, 15000);
  assert.equal(live.summary.incomeAmount, 2000);
  assert.equal(live.summary.expenseAmount, 4000);
  assert.equal(live.summary.withdrawalAmount, 3000);
  assert.equal(live.summary.expectedCash, 5000 + 15000 + 2000 - 4000 - 3000);
  // Un gasto no baja la venta: solo el efectivo.
  assert.equal(live.summary.netAmount, 15000);
});

test("movimientos: validación, idempotencia y anulación", async () => {
  const v = await venue();
  const session = await cash.openSession(v.ownerId, {}, PANEL);

  await rejects(cash.addMovement(v.ownerId, session.id, { type: "sale", amount: 100 }, PANEL), 400);
  await rejects(cash.addMovement(v.ownerId, session.id, { type: "expense", category: "owner", amount: 100 }, PANEL), 400);
  await rejects(cash.addMovement(v.ownerId, session.id, { type: "expense", amount: 0 }, PANEL), 400);

  const key = crypto.randomUUID();
  const first = await cash.addMovement(v.ownerId, session.id, { type: "expense", amount: 1500, idempotencyKey: key }, PANEL);
  const retry = await cash.addMovement(v.ownerId, session.id, { type: "expense", amount: 1500, idempotencyKey: key }, PANEL);
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.session.summary.expenseAmount, 1500, "el reintento no carga el gasto dos veces");

  const ledger = await cash.getLedger(v.ownerId, session.id, { type: "expense" });
  assert.equal(ledger.entries.length, 1);
  const voided = await cash.voidMovement(v.ownerId, ledger.entries[0].movementId, { reason: "Error de carga" }, PANEL);
  assert.equal(voided.session.summary.expenseAmount, 0);
  assert.equal(voided.session.summary.expectedCash, 0);

  const after = await cash.getLedger(v.ownerId, session.id, { type: "expense" });
  assert.equal(after.entries[0].voided, true, "queda en el libro, anulado");
  assert.equal(after.entries[0].movementId, null);
  assert.equal(after.totals.out, 0);
});

test("lo cobrado online no se espera en efectivo", async () => {
  const v = await venue();
  await order(v, [line(PIZZA)]);
  await order(v, [line(BEER, 2)], {
    source: "customer", serviceType: "takeaway", payment: { mode: "mercadopago", status: "APPROVED" },
  });

  const { summary } = await openOf(v);
  assert.equal(summary.netAmount, 15000);
  assert.equal(summary.onlineAmount, 5000);
  assert.equal(summary.expectedCash, 10000);
  assert.deepEqual(summary.paymentsBreakdown, [
    { method: "Mercado Pago (online)", kind: "mercadopago", count: 1, amount: 5000 },
  ]);
});

test("cierre con arqueo: contado obligatorio, retiro y fondo de la próxima apertura", async () => {
  const v = await venue();
  const session = await cash.openSession(v.ownerId, { openingAmount: 2000 }, PANEL);
  const sold = await order(v, [line(PIZZA)]);
  await orders.updateStatus(v.ownerId, sold.id, "delivered");

  await rejects(cash.closeSession(v.ownerId, session.id, {}, PANEL), 400, "CASH_COUNT_REQUIRED");
  await rejects(cash.closeSession(v.ownerId, session.id, { cashCounted: 1000, cashWithdrawn: 1500 }, PANEL), 400);

  const closed = await cash.closeSession(v.ownerId, session.id, { cashCounted: 11500, cashWithdrawn: 9500, notes: "Todo ok" }, PANEL);
  assert.equal(closed.summary.expectedCash, 12000);
  assert.equal(closed.difference, -500);
  assert.equal(closed.cashWithdrawn, 9500);
  assert.equal(closed.cashLeft, 2000);
  assert.equal(closed.closedByName, "Panel");
  await rejects(cash.addMovement(v.ownerId, session.id, { type: "expense", amount: 100 }, PANEL), 409);

  const [register] = await cash.listRegisters(v.ownerId);
  assert.equal(register.suggestedOpening, 2000);
  assert.equal(register.openSessionId, null);

  const next = await cash.openSession(v.ownerId, {}, PANEL);
  assert.equal(next.openingAmount, 2000, "sin indicar fondo, abre con lo que quedó en el cajón");
  const explicit = await cash.updateSession(v.ownerId, next.id, { openingAmount: 0 }, PANEL);
  assert.equal(explicit.openingAmount, 0);
});

test("anular un pedido de una caja ya cerrada se descuenta en la caja abierta", async () => {
  const v = await venue();
  const first = await cash.openSession(v.ownerId, {}, PANEL);
  const done = await order(v, [line(PIZZA)]);
  await orders.updateStatus(v.ownerId, done.id, "delivered");
  const pending = await order(v, [line(BEER, 2)]);

  assert.equal((await openOf(v)).summary.pendingCount, 1);
  const closed = await cash.closeSession(v.ownerId, first.id, { cashCounted: 15000 }, PANEL);
  assert.equal(closed.summary.salesAmount, 15000, "el pedido en curso queda en el cierre de su caja");
  assert.equal(closed.difference, 0);

  // Se anula con esa caja ya cerrada: el cierre no se toca, se descuenta en la abierta.
  const second = await cash.openSession(v.ownerId, { openingAmount: 0 }, PANEL);
  await orders.updateStatus(v.ownerId, pending.id, "cancelled", { reason: "El cliente se fue" });
  let live = await openOf(v);
  assert.equal(live.summary.returnedAmount, 5000);
  assert.equal(live.summary.netAmount, -5000);
  assert.equal(live.summary.expectedCash, -5000);
  assert.equal((await cash.getSession(v.ownerId, first.id)).summary.salesAmount, 15000);
  const ledger = await cash.getLedger(v.ownerId, second.id, { type: "return" });
  assert.equal(ledger.entries[0].label, "Anulación · pedido de una caja cerrada");
  assert.equal(ledger.entries[0].detail, "Pedido #2 · El cliente se fue");

  // Se reactiva con la caja que lo descontó todavía abierta: se saca el descuento.
  await orders.updateStatus(v.ownerId, pending.id, "pending");
  live = await openOf(v);
  assert.equal(live.summary.returnedAmount, 0);
  assert.equal(live.summary.expectedCash, 0);

  // Anulado y cerrada también la caja que lo descontó: al reactivarlo cuenta en la nueva.
  await orders.updateStatus(v.ownerId, pending.id, "cancelled");
  await cash.closeSession(v.ownerId, second.id, { cashCounted: 0 }, PANEL);
  const third = await cash.openSession(v.ownerId, {}, PANEL);
  const reopened = await orders.updateStatus(v.ownerId, pending.id, "pending");
  assert.equal(reopened.cashSessionId, third.id);
  live = await openOf(v);
  assert.equal(live.summary.salesAmount, 5000);
  assert.equal(live.summary.returnedAmount, 0);
});

test("anular un pedido de la caja abierta no pasa por devoluciones", async () => {
  const v = await venue();
  const pending = await order(v, [line(PIZZA)]);
  await orders.updateStatus(v.ownerId, pending.id, "cancelled");
  const { summary } = await openOf(v);
  assert.equal(summary.cancelledAmount, 10000);
  assert.equal(summary.returnedAmount, 0);
  assert.equal(summary.expectedCash, 0);
});

test("cajero vinculado a un operador; cambiar el fondo deja rastro", async () => {
  const v = await venue();
  const waiter = await waiters.createWaiter(v.ownerId, { name: "Juana" });
  const session = await cash.openSession(v.ownerId, { cashierId: waiter.id, openingAmount: 1000 }, PANEL);
  assert.equal(session.cashierId, waiter.id);
  assert.equal(session.cashierName, "Juana");
  assert.equal(session.openedByName, "Panel");
  await rejects(cash.openSession(v.ownerId, { cashierId: 999999 }, PANEL), 409, "CASH_ALREADY_OPEN");
  await rejects(cash.updateSession(v.ownerId, session.id, { cashierId: 999999 }, PANEL), 404);

  const manual = await cash.updateSession(v.ownerId, session.id, { cashierId: null, cashierName: "Pedro", openingAmount: 3000 }, PANEL);
  assert.equal(manual.cashierId, null);
  assert.equal(manual.cashierName, "Pedro");
  assert.equal(manual.summary.expectedCash, 3000);

  const same = await cash.updateSession(v.ownerId, session.id, { openingAmount: 3000 }, PANEL);
  assert.equal(same.cashierName, "Pedro", "sin cajero en el pedido, queda el que estaba");

  const ledger = await cash.getLedger(v.ownerId, session.id, { type: "fund_adjustment" });
  assert.equal(ledger.entries.length, 1, "solo el cambio real del fondo queda registrado");
  assert.equal(ledger.entries[0].amount, 3000);
  assert.equal(ledger.entries[0].direction, "none");
  assert.equal(ledger.entries[0].movementId, null, "el rastro no se anula");

  const overview = await cash.getOverview(v.ownerId);
  assert.deepEqual(overview.cashiers, [{ id: waiter.id, name: "Juana" }]);
  assert.equal(overview.registers[0].openSessionId, session.id);
  assert.deepEqual(overview.movementTypes.map((type) => type.key), ["income", "expense", "withdrawal"]);
  assert.ok(overview.movementTypes[1].categories.some((category) => category.key === "supplier"));
});

test("libro de la caja: junta todo, filtra y pagina en el servidor", async () => {
  const v = await venue();
  const session = await cash.openSession(v.ownerId, { openingAmount: 1000 }, PANEL);
  const table = await order(v, [line(PIZZA), line(BEER, 2)], { serviceType: "table", tableNumber: 3 });
  await bill.recordPayment(v.ownerId, table.tableSessionId, { amount: 5000, methodKind: "cash" }, BILL);
  await bill.recordPayment(v.ownerId, table.tableSessionId, { amount: 10000, methodKind: "credit", reference: "4421" }, BILL);
  await cash.addMovement(v.ownerId, session.id, { type: "expense", category: "supplies", amount: 800, notes: "Hielo" }, PANEL);
  const returned = await order(v, [line(BEER)]);
  await orders.updateStatus(v.ownerId, returned.id, "delivered");
  await orders.updateStatus(v.ownerId, returned.id, "returned", { reason: "Estaba caliente" });

  const all = await cash.getLedger(v.ownerId, session.id);
  assert.equal(all.total, 5);
  assert.deepEqual(all.entries.map((entry) => entry.type).sort(), ["expense", "opening", "payment", "payment", "return"]);
  assert.deepEqual(all.totals, { in: 16000, out: 3300 });

  const card = all.entries.find((entry) => entry.label === "Cobro · Crédito");
  assert.equal(card.cash, false);
  assert.equal(card.detail, "Mesa 3 · 4421");
  const expense = all.entries.find((entry) => entry.type === "expense");
  assert.equal(expense.label, "Egreso · Insumos / compras");
  assert.equal(expense.detail, "Hielo");
  assert.ok(expense.movementId);
  assert.equal(all.entries.find((entry) => entry.type === "return").detail, "Pedido #2 · Estaba caliente");

  const cashOnly = await cash.getLedger(v.ownerId, session.id, { cashOnly: true });
  assert.equal(cashOnly.total, 4);
  assert.deepEqual(cashOnly.totals, { in: 6000, out: 3300 });

  const payments = await cash.getLedger(v.ownerId, session.id, { type: "payment" });
  assert.equal(payments.total, 2);
  await rejects(cash.getLedger(v.ownerId, session.id, { type: "nope" }), 400);

  const empty = await cash.getLedger(v.ownerId, session.id, { page: 2 });
  assert.equal(empty.entries.length, 0);

  // 17.500 vendidos − 2.500 devueltos − 10.000 con tarjeta = 5.000 en efectivo.
  const live = await openOf(v);
  assert.equal(live.summary.expectedCash, 1000 + 5000 - 800);

  const closed = await cash.closeSession(v.ownerId, session.id, { cashCounted: 5200 }, PANEL);
  const after = await cash.getLedger(v.ownerId, session.id);
  assert.equal(after.entries[0].type, "closing");
  assert.equal(after.entries[0].amount, 5200);
  assert.ok(after.entries.every((entry) => entry.movementId === null), "con la caja cerrada no se anula nada");
  assert.equal(closed.summary.expenseAmount, 800);
  await rejects(cash.voidMovement(v.ownerId, expense.movementId, {}, PANEL), 409);
});

test("historial de cajas cerradas: filtros y totales del servidor", async () => {
  const v = await venue();
  await cash.listRegisters(v.ownerId);
  const bar = await cash.createRegister(v.ownerId, { name: "Barra" });
  const close = async ({ registerId, cashierName, counted, expense = 0 }) => {
    const session = await cash.openSession(v.ownerId, { registerId, cashierName, openingAmount: 1000 }, PANEL);
    if (expense) await cash.addMovement(v.ownerId, session.id, { type: "expense", amount: expense }, PANEL);
    return cash.closeSession(v.ownerId, session.id, { cashCounted: counted }, PANEL);
  };
  await close({ cashierName: "Ana", counted: 1000 });
  await close({ cashierName: "Ana", counted: 700 });
  await close({ registerId: bar.id, cashierName: "Luis", counted: 900, expense: 300 });

  const all = await cash.listClosedSessions(v.ownerId);
  assert.equal(all.total, 3);
  assert.equal(all.totals.difference, -100);
  assert.equal(all.totals.exactCount, 1);
  assert.equal(all.totals.shortCount, 1);
  assert.equal(all.totals.shortAmount, -300);
  assert.equal(all.totals.overCount, 1);
  assert.equal(all.totals.overAmount, 200);
  assert.equal(all.totals.expenseAmount, 300);
  assert.deepEqual(all.filters.cashiers, ["Ana", "Luis"]);
  assert.deepEqual(all.filters.registers.map((register) => register.name), ["Caja principal", "Barra"]);

  const ana = await cash.listClosedSessions(v.ownerId, { cashier: "Ana" });
  assert.equal(ana.total, 2);
  assert.equal(ana.totals.difference, -300);
  assert.equal((await cash.listClosedSessions(v.ownerId, { registerId: bar.id })).total, 1);
  assert.equal((await cash.listClosedSessions(v.ownerId, { result: "short" })).sessions[0].cashierName, "Ana");
  assert.equal((await cash.listClosedSessions(v.ownerId, { result: "over", cashier: "Ana" })).total, 0);
  assert.equal((await cash.listClosedSessions(v.ownerId, { from: "2000-01-01", to: "2000-01-31" })).total, 0);
  assert.equal((await cash.listClosedSessions(v.ownerId, { from: "2000-01-01" })).total, 3);
  await rejects(cash.listClosedSessions(v.ownerId, { result: "nope" }), 400);

  const paged = await cash.listClosedSessions(v.ownerId, { page: 2, pageSize: 2 });
  assert.equal(paged.sessions.length, 1);
  assert.equal(paged.total, 3, "los totales son de todo el filtro, no de la página");
});
