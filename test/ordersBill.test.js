const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startOrdersDb, fakeCatalog } = require("../test-support/ordersDb");

// Cuenta inteligente (etapa 1): comensales, reparto de productos, modos de
// división, pagos parciales, permisos, historial y consistencia de totales.
// Corre contra SQL de verdad en memoria, con las migraciones reales.

const PIZZA = "a".repeat(24);
const BEER = "b".repeat(24);
const FLAN = "c".repeat(24);
const PRODUCTS = {
  [PIZZA]: { title: "Pizza", price: 10000 },
  [BEER]: { title: "Cerveza", price: 2500 },
  [FLAN]: { title: "Flan", price: 3000 },
};
const PANEL = { actor: { type: "panel", id: "panel", name: "Panel" }, waiterId: null };

let db;
let bill;
let orders;
let tables;
let items;
let settings;
let waiters;
let cash;
let seq = 0;

test.before(async () => {
  db = await startOrdersDb(null, { catalog: fakeCatalog({ products: PRODUCTS }) });
  bill = db.load("services/billService");
  orders = db.load("services/orderService");
  tables = db.load("services/tableSessionService");
  items = db.load("services/orderItemService");
  settings = db.load("services/settingsService");
  waiters = db.load("services/waiterService");
  cash = db.load("services/cashService");
});
test.after(() => db.close());

// Un local nuevo por test: nada se pisa entre casos.
const venue = async () => {
  seq += 1;
  const owner = { _id: `owner-bill-${seq}`, slug: `local-${seq}` };
  return { owner, ownerId: owner._id, settings: await settings.getOrCreateSettings(owner._id) };
};

const line = (itemId, quantity = 1) => ({ itemId, option: null, quantity, notes: null });

const order = async (v, lines, over = {}) => (await orders.createOrder({
  owner: v.owner, settings: v.settings, source: "panel", lines, serviceType: "table", tableNumber: 4,
  actor: PANEL.actor, ...over,
})).order;

// Mesa 4 con una pizza, dos cervezas y un flan: $18.000.
const table = async () => {
  const v = await venue();
  const first = await order(v, [line(PIZZA), line(BEER, 2), line(FLAN)]);
  return { ...v, sessionId: first.tableSessionId, order: first, item: Object.fromEntries(first.items.map((i) => [i.title, i.id])) };
};

const waiterOf = async (v, name) => {
  const waiter = await waiters.createWaiter(v.ownerId, { name });
  return { actor: { type: "waiter", id: waiter.id, name }, waiterId: waiter.id };
};

const guestsOf = (result) => Object.fromEntries(result.bill.guests.map((guest) => [guest.name, guest]));
const rejects = (promise, status, code) => assert.rejects(promise, (error) => {
  assert.equal(error.status, status, error.message);
  if (code) assert.equal(error.code, code);
  return true;
});

test("la cuenta junta todos los pedidos de la mesa, aunque se hayan cargado de un solo lado", async () => {
  const t = await table();
  await order(t, [line(BEER, 1)]);
  const current = await bill.getBill(t.ownerId, t.sessionId);
  assert.equal(current.total, 20500);
  assert.equal(current.pending, 20500);
  assert.equal(current.mode, "none");
  assert.equal(current.status, "open");
  assert.equal(current.items.length, 4);
  assert.equal(current.tableNumber, 4);
});

test("comensales: con nombre, de a varios, renombrar y quitar", async () => {
  const t = await table();
  await bill.addGuests(t.ownerId, t.sessionId, { name: "  Ana  " }, PANEL);
  let result = await bill.addGuests(t.ownerId, t.sessionId, { count: 3 }, PANEL);
  assert.deepEqual(result.bill.guests.map((guest) => guest.name), ["Ana", "Persona 1", "Persona 2", "Persona 3"]);

  const persona2 = guestsOf(result)["Persona 2"].id;
  result = await bill.renameGuest(t.ownerId, t.sessionId, persona2, { name: "Beto" }, PANEL);
  assert.ok(guestsOf(result).Beto);
  result = await bill.removeGuest(t.ownerId, t.sessionId, guestsOf(result)["Persona 3"].id, PANEL);
  assert.deepEqual(result.bill.guests.map((guest) => guest.name), ["Ana", "Persona 1", "Beto"]);

  // "Persona N" no repite los nombres que ya están.
  result = await bill.addGuests(t.ownerId, t.sessionId, { count: 2 }, PANEL);
  assert.deepEqual(result.bill.guests.map((guest) => guest.name).slice(3), ["Persona 2", "Persona 3"]);

  await rejects(bill.addGuests(t.ownerId, t.sessionId, { name: "" }, PANEL), 400);
  await rejects(bill.addGuests(t.ownerId, t.sessionId, { count: 0 }, PANEL), 400);
  await rejects(bill.addGuests(t.ownerId, t.sessionId, { count: 30 }, PANEL), 409);
  await rejects(bill.renameGuest(t.ownerId, t.sessionId, 999999, { name: "X" }, PANEL), 404);
});

test("por productos: entero a uno, fraccionado entre varios, partes desiguales y sin asignar", async () => {
  const t = await table();
  let result = await bill.addGuests(t.ownerId, t.sessionId, { count: 3 }, PANEL);
  const [a, b, c] = result.bill.guests.map((guest) => guest.id);

  result = await bill.setItemShares(t.ownerId, t.sessionId, t.item.Pizza, { shares: [{ guestId: a }, { guestId: b }, { guestId: c }] }, PANEL);
  assert.equal(result.bill.mode, "items", "asignar un producto pasa la mesa a división por productos");
  result = await bill.setItemShares(t.ownerId, t.sessionId, t.item.Cerveza, { shares: [{ guestId: a, weight: 2 }, { guestId: b, weight: 1 }] }, PANEL);
  result = await bill.setItemShares(t.ownerId, t.sessionId, t.item.Flan, { shares: [{ guestId: c }] }, PANEL);

  assert.deepEqual(result.bill.guests.map((guest) => guest.owed), [6666.67, 5000, 6333.33]);
  assert.equal(result.bill.unassigned, 0);
  assert.equal(result.bill.guests.reduce((sum, guest) => sum + Math.round(guest.owed * 100), 0), 1800000);

  // Reasignar reemplaza el reparto; lista vacía lo deja sin asignar.
  result = await bill.setItemShares(t.ownerId, t.sessionId, t.item.Flan, { shares: [] }, PANEL);
  assert.equal(result.bill.unassigned, 3000);
  assert.equal(guestsOf(result)["Persona 3"].owed, 3333.33);
});

test("reparto inválido: comensal de otra mesa, producto de otra mesa, repetidos y partes fuera de rango", async () => {
  const t = await table();
  const other = await table();
  const mine = (await bill.addGuests(t.ownerId, t.sessionId, { name: "Ana" }, PANEL)).bill.guests[0].id;
  const theirs = (await bill.addGuests(other.ownerId, other.sessionId, { name: "Zoe" }, PANEL)).bill.guests[0].id;

  await rejects(bill.setItemShares(t.ownerId, t.sessionId, t.item.Pizza, { shares: [{ guestId: theirs }] }, PANEL), 404);
  await rejects(bill.setItemShares(t.ownerId, t.sessionId, other.item.Pizza, { shares: [{ guestId: mine }] }, PANEL), 404);
  await rejects(bill.setItemShares(t.ownerId, t.sessionId, t.item.Pizza, { shares: [{ guestId: mine }, { guestId: mine }] }, PANEL), 400);
  await rejects(bill.setItemShares(t.ownerId, t.sessionId, t.item.Pizza, { shares: [{ guestId: mine, weight: 0 }] }, PANEL), 400);
  await rejects(bill.setItemShares(t.ownerId, t.sessionId, t.item.Pizza, { shares: [{ guestId: mine, weight: 101 }] }, PANEL), 400);
  await rejects(bill.setItemShares(t.ownerId, t.sessionId, t.item.Pizza, { shares: "todos" }, PANEL), 400);
  assert.equal((await bill.getBill(t.ownerId, t.sessionId)).items[0].shares.length, 0, "un reparto rechazado no guarda nada");
});

test("partes iguales e importes personalizados", async () => {
  const t = await table();
  let result = await bill.addGuests(t.ownerId, t.sessionId, { count: 4 }, PANEL);
  const ids = result.bill.guests.map((guest) => guest.id);

  result = await bill.setSplit(t.ownerId, t.sessionId, { mode: "equal" }, PANEL);
  assert.deepEqual(result.bill.guests.map((guest) => guest.owed), [4500, 4500, 4500, 4500]);

  result = await bill.setSplit(t.ownerId, t.sessionId, {
    mode: "custom", amounts: [{ guestId: ids[0], amount: 10000 }, { guestId: ids[1], amount: "2500.50" }],
  }, PANEL);
  assert.deepEqual(result.bill.guests.map((guest) => guest.owed), [10000, 2500.5, 0, 0]);
  assert.equal(result.bill.unassigned, 5499.5);

  // Más que el total: se rechaza y no queda nada a medio guardar.
  await rejects(bill.setSplit(t.ownerId, t.sessionId, { mode: "custom", amounts: [{ guestId: ids[2], amount: 6000 }] }, PANEL), 409, "AMOUNTS_EXCEED_TOTAL");
  assert.equal(guestsOf(await bill.setSplit(t.ownerId, t.sessionId, { mode: "custom" }, PANEL))["Persona 3"].owed, 0);

  await rejects(bill.setSplit(t.ownerId, t.sessionId, { mode: "mitades" }, PANEL), 400);
  await rejects(bill.setSplit(t.ownerId, t.sessionId, { mode: "equal", amounts: [] }, PANEL), 400);
  await rejects(bill.setSplit(t.ownerId, t.sessionId, { mode: "custom", amounts: [{ guestId: ids[0], amount: -5 }] }, PANEL), 400);
});

test("pagos parciales: medio de pago, quién pagó, cuánto debe cada uno y cuánto queda", async () => {
  const t = await table();
  let result = await bill.addGuests(t.ownerId, t.sessionId, { count: 3 }, PANEL);
  const [a, b] = result.bill.guests.map((guest) => guest.id);
  await bill.setSplit(t.ownerId, t.sessionId, { mode: "equal" }, PANEL);

  result = await bill.recordPayment(t.ownerId, t.sessionId, { amount: 6000, methodKind: "cash", guestId: a }, PANEL);
  assert.equal(result.duplicate, false);
  assert.equal(result.payment.methodName, "Efectivo");
  assert.equal(result.payment.payerName, "Persona 1", "sin aclarar quién pagó, es el comensal");
  result = await bill.recordPayment(t.ownerId, t.sessionId, {
    amount: "2500.50", methodKind: "transfer", guestId: b, payerName: "La tía de Beto", reference: "op 4471",
  }, PANEL);
  assert.equal(result.payment.payerName, "La tía de Beto");
  result = await bill.recordPayment(t.ownerId, t.sessionId, { amount: 1000, methodKind: "debit", payerName: "Alguien de la mesa" }, PANEL);

  assert.equal(result.bill.paid, 9500.5);
  assert.equal(result.bill.pending, 8499.5);
  assert.equal(result.bill.status, "partial");
  assert.equal(result.bill.paidUnattributed, 1000);
  assert.deepEqual(result.bill.guests.map((guest) => [guest.owed, guest.paid, guest.balance]), [
    [6000, 6000, 0], [6000, 2500.5, 3499.5], [6000, 0, 6000],
  ]);
  assert.equal(result.bill.payments.length, 3);
  assert.equal(result.bill.payments[0].actorName, "Panel");

  // La mesa muestra lo cobrado.
  assert.equal((await tables.getSession(t.ownerId, t.sessionId)).paidAmount, 9500.5);

  // Se cobra el resto: cuenta saldada, y no acepta más.
  result = await bill.recordPayment(t.ownerId, t.sessionId, { amount: 8499.5, methodKind: "credit" }, PANEL);
  assert.equal(result.bill.status, "paid");
  assert.equal(result.bill.pending, 0);
  await rejects(bill.recordPayment(t.ownerId, t.sessionId, { amount: 1, methodKind: "cash" }, PANEL), 409, "OVERPAYMENT");
});

test("pagos inválidos: importe, medio, comensal ajeno y de más", async () => {
  const t = await table();
  const other = await table();
  const theirs = (await bill.addGuests(other.ownerId, other.sessionId, { name: "Zoe" }, PANEL)).bill.guests[0].id;

  for (const amount of [0, -100, "abc", null, undefined]) {
    await rejects(bill.recordPayment(t.ownerId, t.sessionId, { amount, methodKind: "cash" }, PANEL), 400);
  }
  await rejects(bill.recordPayment(t.ownerId, t.sessionId, { amount: 100, methodKind: "mercadopago" }, PANEL), 400);
  await rejects(bill.recordPayment(t.ownerId, t.sessionId, { amount: 100 }, PANEL), 400);
  await rejects(bill.recordPayment(t.ownerId, t.sessionId, { amount: 100, methodKind: "cash", guestId: theirs }, PANEL), 404);
  await rejects(bill.recordPayment(t.ownerId, t.sessionId, { amount: 18000.01, methodKind: "cash" }, PANEL), 409, "OVERPAYMENT");
  await rejects(bill.recordPayment(t.ownerId, t.sessionId, { amount: 100, methodKind: "cash", idempotencyKey: "no-es-uuid" }, PANEL), 400);
  assert.equal((await bill.getBill(t.ownerId, t.sessionId)).payments.length, 0);
});

test("duplicados: reintentar el mismo pago no cobra dos veces", async () => {
  const t = await table();
  const key = crypto.randomUUID();
  const first = await bill.recordPayment(t.ownerId, t.sessionId, { amount: 5000, methodKind: "cash", idempotencyKey: key }, PANEL);
  const retry = await bill.recordPayment(t.ownerId, t.sessionId, { amount: 5000, methodKind: "cash", idempotencyKey: key }, PANEL);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.payment.id, first.payment.id);
  assert.equal(retry.bill.paid, 5000);

  // El mismo id no sirve para cobrar en otra mesa.
  const other = await order(t, [line(FLAN)], { tableNumber: 9 });
  await rejects(bill.recordPayment(t.ownerId, other.tableSessionId, { amount: 100, methodKind: "cash", idempotencyKey: key }, PANEL), 409);
});

test("concurrencia: el mismo pago enviado varias veces a la vez queda una sola vez", async () => {
  const t = await table();
  const key = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    bill.recordPayment(t.ownerId, t.sessionId, { amount: 4000, methodKind: "cash", idempotencyKey: key }, PANEL)));
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.equal(new Set(results.map((result) => result.payment.id)).size, 1);
  const { rows } = await db.query("SELECT count(*)::int AS total FROM payments WHERE table_session_id = $1", [t.sessionId]);
  assert.equal(rows[0].total, 1);
});

test("concurrencia: dos cobros simultáneos no pueden superar entre los dos el total", async () => {
  const t = await table();
  const results = await Promise.allSettled([
    bill.recordPayment(t.ownerId, t.sessionId, { amount: 10000, methodKind: "cash" }, PANEL),
    bill.recordPayment(t.ownerId, t.sessionId, { amount: 10000, methodKind: "debit" }, PANEL),
    bill.recordPayment(t.ownerId, t.sessionId, { amount: 10000, methodKind: "credit" }, PANEL),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results.filter((entry) => entry.status === "rejected")) assert.equal(result.reason.code, "OVERPAYMENT");
  const current = await bill.getBill(t.ownerId, t.sessionId);
  assert.equal(current.paid, 10000);
  assert.equal(current.pending, 8000);
});

test("anular un pago: no se borra, deja de contar y queda el motivo", async () => {
  const t = await table();
  const guest = (await bill.addGuests(t.ownerId, t.sessionId, { name: "Ana" }, PANEL)).bill.guests[0].id;
  const { payment } = await bill.recordPayment(t.ownerId, t.sessionId, { amount: 7000, methodKind: "cash", guestId: guest }, PANEL);

  // Con un pago a su nombre no se lo puede quitar de la cuenta.
  await rejects(bill.removeGuest(t.ownerId, t.sessionId, guest, PANEL), 409, "GUEST_HAS_PAYMENTS");

  let result = await bill.voidPayment(t.ownerId, t.sessionId, payment.id, { reason: "Se cargó en la mesa equivocada" }, PANEL);
  assert.equal(result.bill.paid, 0);
  assert.equal(result.bill.pending, 18000);
  assert.equal(result.bill.payments[0].status, "voided");
  assert.equal(result.bill.payments[0].voidReason, "Se cargó en la mesa equivocada");

  // Anularlo de nuevo no hace nada; ahora sí se puede quitar al comensal.
  result = await bill.voidPayment(t.ownerId, t.sessionId, payment.id, {}, PANEL);
  assert.equal(result.bill.events.filter((event) => event.type === "payment_voided").length, 1);
  result = await bill.removeGuest(t.ownerId, t.sessionId, guest, PANEL);
  assert.equal(result.bill.guests.length, 0);

  await rejects(bill.voidPayment(t.ownerId, t.sessionId, 999999, {}, PANEL), 404);
  await assert.rejects(db.query("DELETE FROM payments WHERE id = $1", [payment.id]), /No se permiten borrados/);
});

test("historial: cada cambio queda con quién lo hizo, del más nuevo al más viejo", async () => {
  const t = await table();
  const juan = await waiterOf(t, "Juan");
  let result = await bill.addGuests(t.ownerId, t.sessionId, { name: "Ana" }, juan);
  const guest = result.bill.guests[0].id;
  await bill.renameGuest(t.ownerId, t.sessionId, guest, { name: "Ana M." }, juan);
  await bill.setItemShares(t.ownerId, t.sessionId, t.item.Pizza, { shares: [{ guestId: guest }] }, juan);
  await bill.setSplit(t.ownerId, t.sessionId, { mode: "custom", amounts: [{ guestId: guest, amount: 9000 }] }, PANEL);
  const { payment } = await bill.recordPayment(t.ownerId, t.sessionId, { amount: 9000, methodKind: "cash", guestId: guest }, juan);
  result = await bill.voidPayment(t.ownerId, t.sessionId, payment.id, { reason: "Error" }, PANEL);

  assert.deepEqual(result.bill.events.map((event) => event.type), [
    "payment_voided", "payment_recorded", "split_changed", "amounts_set", "item_assigned", "split_changed", "guest_renamed", "guest_added",
  ]);
  const recorded = result.bill.events[1];
  assert.equal(recorded.actorType, "waiter");
  assert.equal(recorded.actorName, "Juan");
  assert.deepEqual(recorded.detail, { paymentId: payment.id, amount: 9000, method: "Efectivo", guest: "Ana M.", payer: "Ana M." });
  assert.equal(result.bill.events[0].actorName, "Panel");
  assert.deepEqual(result.bill.events[4].detail, { title: "Pizza", quantity: 1, guests: [{ name: "Ana M.", weight: 1 }] });
  await assert.rejects(db.query("DELETE FROM bill_events WHERE table_session_id = $1", [t.sessionId]), /No se permiten borrados/);
});

test("permisos: un operador solo maneja la cuenta de sus mesas (o de las que no tomó nadie)", async () => {
  const v = await venue();
  const juan = await waiterOf(v, "Juan");
  const pedro = await waiterOf(v, "Pedro");
  const mine = await order(v, [line(PIZZA)], { source: "waiter", waiter: { id: juan.waiterId, name: "Juan" }, tableNumber: 1 });
  const free = await order(v, [line(PIZZA)], { tableNumber: 2 });

  // Juan en su mesa: todo. Pedro: nada, ni verla.
  assert.equal((await bill.getBill(v.ownerId, mine.tableSessionId, juan)).total, 10000);
  await bill.addGuests(v.ownerId, mine.tableSessionId, { name: "Ana" }, juan);
  await rejects(bill.getBill(v.ownerId, mine.tableSessionId, pedro), 403);
  await rejects(bill.addGuests(v.ownerId, mine.tableSessionId, { name: "X" }, pedro), 403);
  await rejects(bill.setSplit(v.ownerId, mine.tableSessionId, { mode: "equal" }, pedro), 403);
  await rejects(bill.recordPayment(v.ownerId, mine.tableSessionId, { amount: 100, methodKind: "cash" }, pedro), 403);

  // El pago de Juan queda a su nombre.
  const paid = await bill.recordPayment(v.ownerId, mine.tableSessionId, { amount: 100, methodKind: "cash" }, juan);
  assert.equal(paid.payment.actorType, "waiter");
  const { rows } = await db.query("SELECT waiter_id, waiter_name, cash_session_id FROM payments WHERE id = $1", [paid.payment.id]);
  assert.equal(Number(rows[0].waiter_id), juan.waiterId);
  assert.equal(rows[0].waiter_name, "Juan");
  assert.ok(rows[0].cash_session_id, "el pago queda en la caja abierta");

  // Mesa sin operador: cualquiera. El panel: todas.
  assert.equal((await bill.recordPayment(v.ownerId, free.tableSessionId, { amount: 100, methodKind: "cash" }, pedro)).bill.paid, 100);
  assert.equal((await bill.getBill(v.ownerId, mine.tableSessionId, PANEL)).paid, 100);
});

test("permisos: la cuenta de otro local no existe", async () => {
  const t = await table();
  const intruder = await venue();
  await rejects(bill.getBill(intruder.ownerId, t.sessionId), 404);
  await rejects(bill.addGuests(intruder.ownerId, t.sessionId, { name: "X" }, PANEL), 404);
  await rejects(bill.recordPayment(intruder.ownerId, t.sessionId, { amount: 100, methodKind: "cash" }, PANEL), 404);
  await rejects(bill.getBill(t.ownerId, 999999), 404);
});

test("totales consistentes: la cuenta sigue a los pedidos (se agrega, se quita un producto, se anula)", async () => {
  const t = await table();
  let result = await bill.addGuests(t.ownerId, t.sessionId, { count: 2 }, PANEL);
  const [a, b] = result.bill.guests.map((guest) => guest.id);
  await bill.setItemShares(t.ownerId, t.sessionId, t.item.Pizza, { shares: [{ guestId: a }, { guestId: b }] }, PANEL);
  await bill.setItemShares(t.ownerId, t.sessionId, t.item.Cerveza, { shares: [{ guestId: a }] }, PANEL);
  await bill.setItemShares(t.ownerId, t.sessionId, t.item.Flan, { shares: [{ guestId: b }] }, PANEL);
  const check = (current, total) => {
    assert.equal(current.total, total);
    const owed = current.guests.reduce((sum, guest) => sum + Math.round(guest.owed * 100), 0);
    assert.equal(owed + Math.round(current.unassigned * 100), Math.round(total * 100), "lo repartido + lo sin asignar = total");
    assert.equal(Math.round(current.paid * 100) + Math.round(current.pending * 100), Math.round(total * 100));
  };
  check(await bill.getBill(t.ownerId, t.sessionId), 18000);

  // Pedido nuevo en la misma mesa: entra a la cuenta sin asignar.
  const second = await order(t, [line(BEER, 3)]);
  let current = await bill.getBill(t.ownerId, t.sessionId);
  check(current, 25500);
  assert.equal(current.unassigned, 7500);

  // Falta de stock: se quita una de las dos cervezas del primer pedido.
  await items.removeItem(t.ownerId, t.order.id, t.item.Cerveza, { quantity: 1, reason: "Sin stock" });
  current = await bill.getBill(t.ownerId, t.sessionId);
  check(current, 23000);
  assert.equal(current.guests[0].owed, 7500, "media pizza + la cerveza que quedó");

  // Se quita el flan entero: deja de estar en la cuenta.
  await items.removeItem(t.ownerId, t.order.id, t.item.Flan, { reason: "Se arrepintió" });
  current = await bill.getBill(t.ownerId, t.sessionId);
  check(current, 20000);
  assert.equal(current.items.some((item) => item.title === "Flan"), false);
  await rejects(bill.setItemShares(t.ownerId, t.sessionId, t.item.Flan, { shares: [{ guestId: a }] }, PANEL), 404);

  // Se anula el segundo pedido: sale de la cuenta.
  await orders.updateStatus(t.ownerId, second.id, "cancelled", { reason: "Error" });
  current = await bill.getBill(t.ownerId, t.sessionId);
  check(current, 12500);
  assert.equal(current.unassigned, 0);
  assert.equal((await tables.getSession(t.ownerId, t.sessionId)).totalAmount, 12500, "igual al total de la mesa");
});

test("se quita un producto después de cobrar: queda registrado lo cobrado de más", async () => {
  const t = await table();
  await bill.recordPayment(t.ownerId, t.sessionId, { amount: 18000, methodKind: "cash" }, PANEL);
  await items.removeItem(t.ownerId, t.order.id, t.item.Flan, { reason: "No llegó" });
  const current = await bill.getBill(t.ownerId, t.sessionId);
  assert.equal(current.total, 15000);
  assert.equal(current.pending, 0);
  assert.equal(current.overpaid, 3000);
});

test("cerrar la mesa: avisa si falta cobrar; una mesa sin pagos se cierra como siempre", async () => {
  const closer = { actor: { type: "panel", name: "Panel" } };
  const untouched = await table();
  await orders.updateStatus(untouched.ownerId, untouched.order.id, "delivered");
  const closed = await tables.closeSession(untouched.ownerId, untouched.sessionId, closer);
  assert.ok(closed.closedAt, "sin pagos registrados no cambia nada");
  assert.equal(closed.paidAmount, 0);

  const t = await table();
  await orders.updateStatus(t.ownerId, t.order.id, "delivered");
  await bill.recordPayment(t.ownerId, t.sessionId, { amount: 10000, methodKind: "cash" }, PANEL);
  await rejects(tables.closeSession(t.ownerId, t.sessionId, closer), 409, "BILL_PENDING");
  const forced = await tables.closeSession(t.ownerId, t.sessionId, { ...closer, force: true });
  assert.equal(forced.paidAmount, 10000);
  assert.equal(forced.totalAmount, 18000);

  const paid = await table();
  await orders.updateStatus(paid.ownerId, paid.order.id, "delivered");
  await bill.recordPayment(paid.ownerId, paid.sessionId, { amount: 18000, methodKind: "transfer" }, PANEL);
  assert.equal((await tables.closeSession(paid.ownerId, paid.sessionId, closer)).paidAmount, 18000);
});

test("mesa cerrada: la cuenta se puede consultar pero no cambiar", async () => {
  const t = await table();
  const guest = (await bill.addGuests(t.ownerId, t.sessionId, { name: "Ana" }, PANEL)).bill.guests[0].id;
  const { payment } = await bill.recordPayment(t.ownerId, t.sessionId, { amount: 18000, methodKind: "cash", guestId: guest }, PANEL);
  await tables.closeSession(t.ownerId, t.sessionId, { force: true, actor: { type: "panel", name: "Panel" } });

  const current = await bill.getBill(t.ownerId, t.sessionId);
  assert.equal(current.closed, true);
  assert.equal(current.status, "paid");
  for (const attempt of [
    () => bill.addGuests(t.ownerId, t.sessionId, { name: "X" }, PANEL),
    () => bill.renameGuest(t.ownerId, t.sessionId, guest, { name: "X" }, PANEL),
    () => bill.removeGuest(t.ownerId, t.sessionId, guest, PANEL),
    () => bill.setSplit(t.ownerId, t.sessionId, { mode: "equal" }, PANEL),
    () => bill.setItemShares(t.ownerId, t.sessionId, t.item.Pizza, { shares: [] }, PANEL),
    () => bill.recordPayment(t.ownerId, t.sessionId, { amount: 1, methodKind: "cash" }, PANEL),
    () => bill.voidPayment(t.ownerId, t.sessionId, payment.id, {}, PANEL),
  ]) await rejects(attempt(), 409, "TABLE_CLOSED");
});

test("caja: lo cobrado con otros medios no se espera en efectivo; sin pagos, igual que antes", async () => {
  const t = await table();
  const [before] = await cash.listOpenSessions(t.ownerId);
  assert.equal(before.summary.expectedCash, 18000, "sin pagos registrados se espera todo lo vendido");

  await bill.recordPayment(t.ownerId, t.sessionId, { amount: 5000, methodKind: "cash" }, PANEL);
  await bill.recordPayment(t.ownerId, t.sessionId, { amount: 6000, methodKind: "credit" }, PANEL);
  const voided = await bill.recordPayment(t.ownerId, t.sessionId, { amount: 2000, methodKind: "transfer" }, PANEL);
  await bill.voidPayment(t.ownerId, t.sessionId, voided.payment.id, {}, PANEL);

  const [after] = await cash.listOpenSessions(t.ownerId);
  assert.equal(after.summary.expectedCash, 12000, "18.000 vendidos − 6.000 con tarjeta");
  assert.deepEqual(after.summary.paymentsBreakdown, [
    { method: "Crédito", kind: "credit", count: 1, amount: 6000 },
    { method: "Efectivo", kind: "cash", count: 1, amount: 5000 },
  ]);
});

test("avisa en vivo al personal después de cada cambio", async () => {
  const t = await table();
  db.emitted.length = 0;
  await bill.addGuests(t.ownerId, t.sessionId, { name: "Ana" }, PANEL);
  assert.deepEqual(db.emitted, [{ ownerId: t.ownerId, event: "table", staff: true }]);
});

test("migración 009: aditiva e idempotente", async () => {
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "..", "src", "orders", "db", "migrations", "009_cuenta_dividida_pedidos_grupales.sql");
  const raw = fs.readFileSync(file, "utf8");
  const sql = raw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(sql, /\bDROP (TABLE|COLUMN)\b|\bDELETE FROM\b|\bRENAME\b/i);
  assert.doesNotMatch(sql, /CREATE TABLE (?!IF NOT EXISTS)/);
  assert.doesNotMatch(sql, /ADD COLUMN (?!IF NOT EXISTS)/);
  // Se puede volver a correr sobre una base que ya la tiene.
  const { PGlite } = require("@electric-sql/pglite");
  const scratch = new PGlite();
  const dir = path.dirname(file);
  for (const name of fs.readdirSync(dir).sort()) await scratch.exec(fs.readFileSync(path.join(dir, name), "utf8"));
  await scratch.exec(raw);
  await scratch.close();
});
