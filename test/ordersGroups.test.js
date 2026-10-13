const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startOrdersDb, fakeCatalog } = require("../test-support/ordersDb");

// Pedidos grupales (etapa 2): abrir y sumarse a la sesión de una mesa, carrito
// común con autor por producto, envío sin duplicados por el flujo de comandas
// de siempre y volcado a la cuenta. SQL de verdad en memoria.

const PIZZA = "a".repeat(24);
const BEER = "b".repeat(24);
const FLAN = "c".repeat(24);
const GONE = "d".repeat(24);
const PRODUCTS = {
  [PIZZA]: { title: "Pizza", price: 10000, options: { Grande: 14000 } },
  [BEER]: { title: "Cerveza", price: 2500 },
  [FLAN]: { title: "Flan", price: 3000 },
  [GONE]: { title: "Locro", price: 5000, available: false },
};
const CUSTOMER = { type: "customer", name: null };

let db;
let groups;
let bill;
let orders;
let tables;
let settings;
let waiters;
let sectors;
let seq = 0;

test.before(async () => {
  db = await startOrdersDb(null, { catalog: fakeCatalog({ products: PRODUCTS }) });
  groups = db.load("services/groupService");
  bill = db.load("services/billService");
  orders = db.load("services/orderService");
  tables = db.load("services/tableSessionService");
  settings = db.load("services/settingsService");
  waiters = db.load("services/waiterService");
  sectors = db.load("services/sectorService");
});
test.after(() => db.close());

const venue = async () => {
  seq += 1;
  const owner = { _id: `owner-group-${seq}`, slug: `local-${seq}` };
  return { owner, ownerId: owner._id, settings: await settings.getOrCreateSettings(owner._id) };
};

const line = (itemId, over = {}) => ({ itemId, option: null, quantity: 1, notes: null, shared: false, ...over });
const rejects = (promise, status, code) => assert.rejects(promise, (error) => {
  assert.equal(error.status, status, error.message);
  if (code) assert.equal(error.code, code);
  return true;
});

// Mesa 7 con Ana (la abrió desde el QR) y Beto (se sumó con el código).
const party = async () => {
  const v = await venue();
  const opened = await groups.openGroup(v.ownerId, 7, { creator: CUSTOMER, hostName: "Ana" });
  const joined = await groups.joinGroup(v.ownerId, { code: opened.group.code, name: "Beto" });
  const ana = await groups.authenticateMember(opened.memberToken);
  const beto = await groups.authenticateMember(joined.memberToken);
  return { ...v, groupId: opened.group.id, code: opened.group.code, joinToken: opened.group.joinToken, ana, beto };
};

const send = (p, over = {}) => groups.submitGroup({
  owner: p.owner, settings: p.settings, groupId: p.groupId, source: "customer",
  actor: { type: "customer", name: "Ana · Mesa 7" }, clientRequestId: crypto.randomUUID(), ...over,
});

test("abrir el pedido grupal de la mesa: da código, QR y deja al que lo abre como integrante", async () => {
  const v = await venue();
  const opened = await groups.openGroup(v.ownerId, 7, { creator: CUSTOMER, hostName: "  Ana  " });
  assert.equal(opened.created, true);
  assert.match(opened.group.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.match(opened.group.joinToken, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(opened.group.tableNumber, 7);
  assert.deepEqual(opened.group.members.map((m) => [m.name, m.me]), [["Ana", true]]);
  assert.ok(opened.memberToken);

  // El token del integrante no se guarda en claro.
  const { rows } = await db.query("SELECT token_hash FROM group_members WHERE group_session_id = $1", [opened.group.id]);
  assert.notEqual(rows[0].token_hash, opened.memberToken);

  // Otro comensal de la misma mesa que también toca "pedir en grupo" cae en el mismo.
  const again = await groups.openGroup(v.ownerId, 7, { creator: CUSTOMER, hostName: "Beto" });
  assert.equal(again.created, false);
  assert.equal(again.group.id, opened.group.id);
  assert.deepEqual(again.group.members.map((m) => m.name), ["Ana", "Beto"]);

  // Otra mesa: otro grupo, otro código.
  const other = await groups.openGroup(v.ownerId, 8, { creator: CUSTOMER, hostName: "Caro" });
  assert.notEqual(other.group.id, opened.group.id);
  assert.notEqual(other.group.code, opened.group.code);
});

test("concurrencia: toda la mesa abre el grupo a la vez y queda uno solo", async () => {
  const v = await venue();
  const results = await Promise.all(["Ana", "Beto", "Caro", "Dani"].map((name) =>
    groups.openGroup(v.ownerId, 3, { creator: CUSTOMER, hostName: name })));
  assert.equal(new Set(results.map((result) => result.group.id)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  const { rows } = await db.query("SELECT count(*)::int AS total FROM group_sessions WHERE owner_id = $1", [v.ownerId]);
  assert.equal(rows[0].total, 1);
  assert.equal((await groups.getGroup(v.ownerId, results[0].group.id)).members.length, 4);
});

test("sumarse: con el código tipeado, con el QR / enlace, y los casos que no", async () => {
  const p = await party();
  const typed = await groups.joinGroup(p.ownerId, { code: ` ${p.code.slice(0, 3).toLowerCase()}-${p.code.slice(3).toLowerCase()} `, name: "Caro" });
  assert.equal(typed.group.id, p.groupId);
  const scanned = await groups.joinGroup(p.ownerId, { joinToken: p.joinToken, name: "Dani" });
  assert.deepEqual(scanned.group.members.map((m) => m.name), ["Ana", "Beto", "Caro", "Dani"]);
  assert.equal(scanned.group.members.find((m) => m.me).name, "Dani");

  await rejects(groups.joinGroup(p.ownerId, { code: "ZZZZZZ", name: "X" }), 404, "GROUP_NOT_FOUND");
  await rejects(groups.joinGroup(p.ownerId, { code: "corto", name: "X" }), 404, "GROUP_NOT_FOUND");
  await rejects(groups.joinGroup(p.ownerId, { joinToken: "x".repeat(32), name: "X" }), 404, "GROUP_NOT_FOUND");
  await rejects(groups.joinGroup(p.ownerId, { name: "X" }), 404, "GROUP_NOT_FOUND");
  await rejects(groups.joinGroup(p.ownerId, { code: p.code, name: "  " }), 400);
  await rejects(groups.joinGroup(p.ownerId, { code: p.code, name: "ana" }), 409, "NAME_TAKEN");

  // El código de un local no sirve en otro.
  const other = await venue();
  await rejects(groups.joinGroup(other.ownerId, { code: p.code, name: "X" }), 404, "GROUP_NOT_FOUND");

  // Cerrado, ya no se puede entrar (y no dice si existió).
  await groups.closeGroup(p.ownerId, p.groupId);
  await rejects(groups.joinGroup(p.ownerId, { code: p.code, name: "Eva" }), 404, "GROUP_NOT_FOUND");
});

test("un grupo tiene tope de integrantes", async () => {
  const v = await venue();
  const opened = await groups.openGroup(v.ownerId, 1, { creator: { type: "panel", name: "Panel" } });
  assert.equal(opened.memberToken, undefined, "el personal lo abre sin ser integrante");
  for (let i = 1; i <= 30; i += 1) await groups.joinGroup(v.ownerId, { code: opened.group.code, name: `P${i}` });
  await rejects(groups.joinGroup(v.ownerId, { code: opened.group.code, name: "Uno más" }), 409, "GROUP_FULL");
});

test("carrito: cada integrante agrega productos con variante y aclaración, propios o para compartir", async () => {
  const p = await party();
  await groups.addCartItems(p.owner, p.ana, [
    line(PIZZA, { option: "Grande", shared: true, notes: "mitad sin cebolla" }),
    line(BEER, { quantity: 2 }),
  ]);
  const view = await groups.addCartItems(p.owner, p.beto, [line(FLAN)]);

  assert.deepEqual(view.cart.map((item) => [item.authorName, item.title, item.option, item.quantity, item.unitPrice, item.shared, item.mine]), [
    ["Ana", "Pizza", "Grande", 1, 14000, true, false],
    ["Ana", "Cerveza", null, 2, 2500, false, false],
    ["Beto", "Flan", null, 1, 3000, false, true],
  ]);
  assert.equal(view.cart[0].notes, "mitad sin cebolla");
  assert.equal(view.cartTotal, 22000);

  // El precio y el título salen del menú, no del celular; lo que no se puede pedir no entra.
  await rejects(groups.addCartItems(p.owner, p.beto, [line("e".repeat(24))]), 400);
  await rejects(groups.addCartItems(p.owner, p.beto, [line(GONE)]), 400);
  await rejects(groups.addCartItems(p.owner, p.beto, [line(PIZZA, { option: "Gigante" })]), 400);
  assert.equal((await groups.getGroup(p.ownerId, p.groupId)).cart.length, 3);
});

test("carrito: reintentar un agregado no lo carga dos veces", async () => {
  const p = await party();
  const clientItemId = crypto.randomUUID();
  await Promise.all([1, 2, 3].map(() => groups.addCartItems(p.owner, p.ana, [line(BEER, { clientItemId })])));
  await groups.addCartItems(p.owner, p.ana, [line(BEER, { clientItemId })]);
  assert.equal((await groups.getGroup(p.ownerId, p.groupId)).cart.length, 1);
});

test("carrito: cada uno cambia lo suyo; lo de otro no; el personal puede sacar cualquiera", async () => {
  const p = await party();
  const view = await groups.addCartItems(p.owner, p.ana, [line(BEER), line(FLAN)]);
  const [beer, flan] = view.cart.map((item) => item.id);

  const updated = await groups.updateCartItem(p.ana, beer, { quantity: 3, notes: "bien fría", shared: true });
  assert.deepEqual([updated.cart[0].quantity, updated.cart[0].notes, updated.cart[0].shared], [3, "bien fría", true]);

  await rejects(groups.updateCartItem(p.beto, beer, { quantity: 9 }), 403, "NOT_YOUR_ITEM");
  await rejects(groups.removeCartItem(p.ownerId, p.groupId, beer, { member: p.beto }), 403, "NOT_YOUR_ITEM");
  await rejects(groups.updateCartItem(p.ana, beer, { quantity: 0 }), 400);
  await rejects(groups.updateCartItem(p.ana, beer, { quantity: 21 }), 400);
  await rejects(groups.updateCartItem(p.ana, beer, { shared: "si" }), 400);

  // Un integrante de otra mesa no llega a este carrito ni con el id del producto.
  const other = await party();
  await rejects(groups.updateCartItem(other.ana, beer, { quantity: 2 }), 404, "GROUP_ITEM_GONE");

  await groups.removeCartItem(p.ownerId, p.groupId, flan, { member: p.ana });
  const afterStaff = await groups.removeCartItem(p.ownerId, p.groupId, beer);
  assert.equal(afterStaff.cart.length, 0);
  await rejects(groups.removeCartItem(p.ownerId, p.groupId, beer), 404, "GROUP_ITEM_GONE");
  const { rows } = await db.query("SELECT count(*)::int AS total FROM group_cart_items WHERE group_session_id = $1", [p.groupId]);
  assert.equal(rows[0].total, 2, "se dan de baja, no se borran");
});

test("carrito lleno: no supera las líneas que admite un pedido", async () => {
  const p = await party();
  await groups.addCartItems(p.owner, p.ana, Array.from({ length: 40 }, () => line(BEER)));
  await rejects(groups.addCartItems(p.owner, p.beto, [line(FLAN)]), 409, "GROUP_CART_FULL");
});

test("enviar: sale UN pedido de la mesa con el autor de cada producto", async () => {
  const p = await party();
  await groups.addCartItems(p.owner, p.ana, [line(PIZZA, { shared: true }), line(BEER, { quantity: 2, notes: "sin vaso" })]);
  await groups.addCartItems(p.owner, p.beto, [line(FLAN)]);

  const { order, duplicate, group } = await send(p);
  assert.equal(duplicate, false);
  assert.equal(order.source, "customer");
  assert.equal(order.status, "pending", "entra como cualquier pedido del comensal: lo confirma el local");
  assert.equal(order.serviceType, "table");
  assert.equal(order.tableNumber, 7);
  assert.equal(order.total, 18000);
  assert.equal(order.groupSessionId, p.groupId);
  assert.deepEqual(order.items.map((item) => [item.title, item.quantity, item.authorName, item.shared, item.notes]), [
    ["Pizza", 1, "Ana", true, null],
    ["Cerveza", 2, "Ana", false, "sin vaso"],
    ["Flan", 1, "Beto", false, null],
  ]);

  // El carrito quedó vacío y el pedido figura como enviado.
  assert.equal(group.cart.length, 0);
  assert.deepEqual(group.orders.map((sent) => [sent.number, sent.status, sent.total, sent.items.length]), [[order.number, "pending", 18000, 3]]);
  assert.equal(group.orders[0].items[2].authorName, "Beto");

  // Es un pedido más de la sesión de la mesa.
  const session = await tables.getSession(p.ownerId, order.tableSessionId);
  assert.equal(session.tableNumber, 7);
  assert.equal(session.totalAmount, 18000);
  assert.deepEqual(session.orders.map((o) => o.id), [order.id]);
  assert.equal(db.emitted.some((event) => event.event === "order_created" && event.orderId === order.id), true);
});

test("enviar: se vuelca solo a la cuenta (cada integrante con lo suyo, lo compartido entre todos)", async () => {
  const p = await party();
  await groups.addCartItems(p.owner, p.ana, [line(PIZZA, { shared: true }), line(BEER, { quantity: 2 })]);
  await groups.addCartItems(p.owner, p.beto, [line(FLAN)]);
  const { order } = await send(p);

  const current = await bill.getBill(p.ownerId, order.tableSessionId);
  assert.equal(current.mode, "items");
  assert.deepEqual(current.guests.map((guest) => [guest.name, guest.fromGroup, guest.owed]), [
    ["Ana", true, 10000], ["Beto", true, 8000],
  ]);
  assert.equal(current.unassigned, 0);
  assert.equal(current.total, 18000);
  assert.deepEqual(current.items.map((item) => [item.title, item.authorName, item.shared, item.shares.length]), [
    ["Pizza", "Ana", true, 2], ["Cerveza", "Ana", false, 1], ["Flan", "Beto", false, 1],
  ]);
  assert.deepEqual(current.events.map((event) => event.type), ["group_order", "split_changed"]);

  // Y se cobra como cualquier cuenta, a mano.
  const ana = current.guests[0].id;
  const paid = await bill.recordPayment(p.ownerId, order.tableSessionId, { amount: 10000, methodKind: "transfer", guestId: ana }, {
    actor: { type: "panel", name: "Panel" }, waiterId: null,
  });
  assert.equal(paid.bill.guests[0].balance, 0);
  assert.equal(paid.bill.pending, 8000);
});

test("duplicados: dos personas tocan Enviar a la vez y sale un solo pedido", async () => {
  const p = await party();
  await groups.addCartItems(p.owner, p.ana, [line(PIZZA), line(BEER)]);
  const results = await Promise.allSettled([send(p), send(p), send(p)]);
  const sent = results.filter((result) => result.status === "fulfilled");
  assert.equal(sent.length, 1);
  for (const failed of results.filter((result) => result.status === "rejected")) {
    assert.ok(["GROUP_CART_CHANGED", "GROUP_CART_EMPTY"].includes(failed.reason.code), failed.reason.message);
  }
  const { rows } = await db.query(
    `SELECT (SELECT count(*)::int FROM orders WHERE owner_id = $1) AS orders,
            (SELECT count(*)::int FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.owner_id = $1) AS lines,
            (SELECT count(*)::int FROM table_sessions WHERE owner_id = $1) AS sessions,
            (SELECT count(*)::int FROM bill_guests WHERE owner_id = $1) AS guests`,
    [p.ownerId]
  );
  assert.deepEqual(rows[0], { orders: 1, lines: 2, sessions: 1, guests: 1 }, "el envío rechazado no deja nada a medias");
});

test("duplicados: reintentar el mismo envío (corte de red) devuelve el pedido que ya salió", async () => {
  const p = await party();
  await groups.addCartItems(p.owner, p.ana, [line(PIZZA)]);
  const clientRequestId = crypto.randomUUID();
  const first = await send(p, { clientRequestId });
  const retry = await send(p, { clientRequestId });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.order.id, first.order.id);
  assert.equal(retry.order.items.length, 1);

  // Sin nada nuevo en el carrito, otro envío no crea un pedido vacío.
  await rejects(send(p), 409, "GROUP_CART_EMPTY");
  const { rows } = await db.query("SELECT count(*)::int AS total FROM orders WHERE owner_id = $1", [p.ownerId]);
  assert.equal(rows[0].total, 1);
});

test("concurrencia: enviar mientras otro cambia el carrito nunca manda algo distinto a lo que quedó", async () => {
  const p = await party();
  const view = await groups.addCartItems(p.owner, p.ana, [line(BEER), line(FLAN)]);
  const [beer, flan] = view.cart.map((item) => item.id);
  const [sent] = await Promise.allSettled([
    send(p),
    groups.updateCartItem(p.ana, beer, { quantity: 4 }),
    groups.removeCartItem(p.ownerId, p.groupId, flan, { member: p.ana }),
    groups.addCartItems(p.owner, p.beto, [line(PIZZA)]),
  ]);
  const { rows: carted } = await db.query(
    "SELECT id, quantity, order_id, removed_at FROM group_cart_items WHERE group_session_id = $1 ORDER BY id", [p.groupId]
  );
  if (sent.status === "fulfilled") {
    // Lo que salió en el pedido es exactamente lo que quedó marcado como enviado.
    const inOrder = carted.filter((row) => row.order_id !== null);
    assert.deepEqual(sent.value.order.items.map((item) => item.quantity), inOrder.map((row) => row.quantity));
    assert.ok(inOrder.every((row) => row.removed_at === null));
  } else {
    assert.equal(sent.reason.code, "GROUP_CART_CHANGED");
    assert.ok(carted.every((row) => row.order_id === null), "si se rechazó, nada quedó marcado como enviado");
    const { rows } = await db.query("SELECT count(*)::int AS total FROM orders WHERE owner_id = $1", [p.ownerId]);
    assert.equal(rows[0].total, 0);
  }
});

test("el carrito cambió justo antes de confirmar el envío: el pedido entero se deshace", async () => {
  const p = await party();
  const view = await groups.addCartItems(p.owner, p.ana, [line(BEER)]);
  // Simula el cambio que entra entre que se arma el pedido y se confirma: Ana
  // cambia la cantidad cuando el envío ya leyó el carrito.
  const original = orders.createOrder;
  orders.createOrder = async (input) => {
    await groups.updateCartItem(p.ana, view.cart[0].id, { quantity: 5 });
    return original(input);
  };
  try {
    await rejects(send(p), 409, "GROUP_CART_CHANGED");
  } finally {
    orders.createOrder = original;
  }
  const { rows } = await db.query("SELECT count(*)::int AS total FROM orders WHERE owner_id = $1", [p.ownerId]);
  assert.equal(rows[0].total, 0);
  const again = await send(p);
  assert.equal(again.order.items[0].quantity, 5);
});

test("un producto que dejó de estar disponible frena el envío sin perder el carrito", async () => {
  const p = await party();
  await groups.addCartItems(p.owner, p.ana, [line(BEER), line(FLAN)]);
  PRODUCTS[FLAN].available = false;
  try {
    await rejects(send(p), 400);
  } finally {
    PRODUCTS[FLAN].available = true;
  }
  assert.equal((await groups.getGroup(p.ownerId, p.groupId)).cart.length, 2);
});

test("integración con el operador y la cocina: lo envía el mozo, entra confirmado y sale la comanda", async () => {
  const p = await party();
  await sectors.createSector(p.ownerId, { name: "Cocina" });
  const waiter = await waiters.createWaiter(p.ownerId, { name: "Juan" });
  await groups.addCartItems(p.owner, p.ana, [line(PIZZA)]);
  await groups.addCartItems(p.owner, p.beto, [line(FLAN)]);

  const { order } = await send(p, {
    source: "waiter", waiter: { id: waiter.id, name: "Juan" }, actor: { type: "waiter", id: waiter.id, name: "Juan" }, notes: "Todo junto",
  });
  assert.equal(order.source, "waiter");
  assert.equal(order.status, "confirmed");
  assert.equal(order.waiterName, "Juan");
  assert.equal(order.notes, "Todo junto");
  assert.deepEqual(order.tickets.map((ticket) => [ticket.sectorName, ticket.status]), [["Cocina", "new"]], "una sola comanda, como cualquier pedido");
  assert.ok(order.items.every((item) => item.sectorName === "Cocina"));
  assert.equal((await tables.getSession(p.ownerId, order.tableSessionId)).waiterName, "Juan", "la mesa queda a cargo del operador");

  // El pedido grupal del comensal espera confirmación: recién ahí va a cocina.
  await groups.addCartItems(p.owner, p.ana, [line(BEER)]);
  const second = (await send(p)).order;
  assert.deepEqual(second.tickets, []);
  const confirmed = await orders.updateStatus(p.ownerId, second.id, "confirmed");
  assert.equal(confirmed.tickets.length, 1);
});

test("varias rondas: cada envío es otro pedido de la misma mesa y la cuenta los junta", async () => {
  const p = await party();
  await groups.addCartItems(p.owner, p.ana, [line(BEER)]);
  const first = (await send(p)).order;
  // El operador también carga algo directo a esa mesa.
  await orders.createOrder({
    owner: p.owner, settings: p.settings, source: "panel", lines: [line(FLAN)], serviceType: "table", tableNumber: 7,
  });
  // Se suma Caro y pide en la segunda ronda, con algo para compartir.
  const caro = await groups.authenticateMember((await groups.joinGroup(p.ownerId, { joinToken: p.joinToken, name: "Caro" })).memberToken);
  await groups.addCartItems(p.owner, caro, [line(PIZZA, { shared: true })]);
  const { order: second, group } = await send(p);

  assert.equal(second.tableSessionId, first.tableSessionId);
  assert.notEqual(second.id, first.id);
  assert.equal(group.orders.length, 2);
  const current = await bill.getBill(p.ownerId, first.tableSessionId);
  assert.equal(current.total, 15500);
  assert.deepEqual(current.guests.map((guest) => [guest.name, guest.owed]), [["Ana", 5833.34], ["Beto", 3333.33], ["Caro", 3333.33]]);
  assert.equal(current.unassigned, 3000, "lo que cargó el operador queda para asignar a mano");
});

test("cerrar la mesa cierra el pedido grupal; con el grupo cerrado no se carga ni se envía", async () => {
  const p = await party();
  await groups.addCartItems(p.owner, p.ana, [line(BEER)]);
  const { order } = await send(p);
  await groups.addCartItems(p.owner, p.beto, [line(FLAN)]);
  await tables.closeSession(p.ownerId, order.tableSessionId, { force: true, actor: { type: "panel", name: "Panel" } });

  const closed = await groups.getGroup(p.ownerId, p.groupId);
  assert.equal(closed.open, false);
  assert.equal(closed.cart.length, 1, "lo que quedó sin enviar se ve, pero ya no sale");
  await rejects(groups.addCartItems(p.owner, p.ana, [line(BEER)]), 409, "GROUP_CLOSED");
  await rejects(send(p), 409, "GROUP_CLOSED");
  await rejects(groups.updateCartItem(p.beto, closed.cart[0].id, { quantity: 2 }), 409, "GROUP_CLOSED");

  // La mesa siguiente arranca con un grupo nuevo y otro código.
  const next = await groups.openGroup(p.ownerId, 7, { creator: CUSTOMER, hostName: "Otra gente" });
  assert.equal(next.created, true);
  assert.notEqual(next.group.id, p.groupId);
  assert.equal(next.group.cart.length, 0);
});

test("salir del grupo: se va con lo que no había enviado y su acceso deja de servir", async () => {
  const opened = await (async () => {
    const v = await venue();
    const first = await groups.openGroup(v.ownerId, 5, { creator: CUSTOMER, hostName: "Ana" });
    const second = await groups.joinGroup(v.ownerId, { code: first.group.code, name: "Beto" });
    return { ...v, groupId: first.group.id, anaToken: first.memberToken, betoToken: second.memberToken };
  })();
  const ana = await groups.authenticateMember(opened.anaToken);
  const beto = await groups.authenticateMember(opened.betoToken);
  await groups.addCartItems(opened.owner, ana, [line(BEER)]);
  await groups.addCartItems(opened.owner, beto, [line(FLAN)]);

  await groups.leaveGroup(beto);
  const view = await groups.getGroup(opened.ownerId, opened.groupId);
  assert.deepEqual(view.members.map((m) => m.name), ["Ana"]);
  assert.deepEqual(view.cart.map((item) => item.title), ["Cerveza"]);
  assert.equal(await groups.authenticateMember(opened.betoToken), null);
  assert.equal(await groups.authenticateMember("no es un token"), null);
  // El nombre queda libre para quien se sume después.
  assert.ok((await groups.joinGroup(opened.ownerId, { joinToken: view.joinToken, name: "Beto" })).memberToken);
});

test("el personal ve los pedidos grupales abiertos del local y solo los suyos", async () => {
  const p = await party();
  await groups.openGroup(p.ownerId, 2, { creator: { type: "waiter", name: "Juan" } });
  await groups.addCartItems(p.owner, p.ana, [line(BEER)]);
  const open = await groups.listOpenGroups(p.ownerId);
  assert.deepEqual(open.map((group) => [group.tableNumber, group.members.length, group.cart.length]), [[2, 0, 0], [7, 2, 1]]);
  assert.equal(open[1].cart[0].mine, undefined);

  const other = await venue();
  assert.deepEqual(await groups.listOpenGroups(other.ownerId), []);
  await rejects(groups.getGroup(other.ownerId, p.groupId), 404);
  await rejects(groups.closeGroup(other.ownerId, p.groupId), 404);
  await rejects(groups.removeCartItem(other.ownerId, p.groupId, open[1].cart[0].id), 404);
  await rejects(groups.submitGroup({
    owner: other.owner, settings: other.settings, groupId: p.groupId, source: "panel", actor: { type: "panel" },
  }), 404);
});

test("un grupo abandonado (viejo y sin mesa abierta) se reemplaza por uno nuevo", async () => {
  const v = await venue();
  const old = await groups.openGroup(v.ownerId, 6, { creator: CUSTOMER, hostName: "Ana" });
  await db.query("UPDATE group_sessions SET created_at = now() - interval '7 hours' WHERE id = $1", [old.group.id]);
  const fresh = await groups.openGroup(v.ownerId, 6, { creator: CUSTOMER, hostName: "Beto" });
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.group.id, old.group.id);
  assert.equal((await groups.getGroup(v.ownerId, old.group.id)).open, false);

  // Viejo pero con la mesa todavía abierta: sigue siendo el mismo.
  await groups.addCartItems(v.owner, await groups.authenticateMember(fresh.memberToken), [line(BEER)]);
  await groups.submitGroup({ owner: v.owner, settings: v.settings, groupId: fresh.group.id, source: "customer", actor: { type: "customer" } });
  await db.query("UPDATE group_sessions SET created_at = now() - interval '7 hours' WHERE id = $1", [fresh.group.id]);
  const same = await groups.openGroup(v.ownerId, 6, { creator: CUSTOMER, hostName: "Caro" });
  assert.equal(same.group.id, fresh.group.id);
});

test("los pedidos que no son grupales siguen igual (sin autor ni grupo)", async () => {
  const v = await venue();
  const { order } = await orders.createOrder({
    owner: v.owner, settings: v.settings, source: "panel", lines: [line(BEER)], serviceType: "table", tableNumber: 1,
  });
  assert.equal(order.groupSessionId, null);
  assert.equal(order.items[0].authorName, null);
  assert.equal(order.items[0].shared, false);
  assert.equal((await bill.getBill(v.ownerId, order.tableSessionId)).mode, "none");
});
