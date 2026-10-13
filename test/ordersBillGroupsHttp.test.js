const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { startOrdersDb, fakeCatalog, stubModule } = require("../test-support/ordersDb");

// Endpoints de la cuenta y de los pedidos grupales, de punta a punta: rutas
// reales de /api/orders sobre un servidor HTTP, con SQL de verdad en memoria.
// Lo único de mentira es lo que viene de Mongo (el local, el menú y el JWT del panel).

const PIZZA = "a".repeat(24);
const BEER = "b".repeat(24);
const PRODUCTS = { [PIZZA]: { title: "Pizza", price: 10000 }, [BEER]: { title: "Cerveza", price: 2500 } };
const OWNERS = [];

let db;
let server;
let base;
let settingsService;
let waiterService;
let orderService;
let seq = 0;

test.before(async () => {
  db = await startOrdersDb(null, { catalog: fakeCatalog({ owners: OWNERS, products: PRODUCTS }) });
  // Sesión del panel: en lugar del JWT, el test dice qué local es (o ninguno).
  stubModule(path.join(__dirname, "..", "src", "middleware", "auth.js"), {
    protect: (req, res, next) => {
      const owner = OWNERS.find((o) => o._id === req.headers["x-test-owner"]);
      if (!owner) return res.status(401).json({ message: "No autorizado" });
      req.user = { ...owner, subscription: owner.pro === false ? "free" : "pro" };
      next();
    },
  });
  settingsService = db.load("services/settingsService");
  waiterService = db.load("services/waiterService");
  orderService = db.load("services/orderService");

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/api/orders", db.load("routes"));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/orders`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

const call = async (method, url, { body, headers = {} } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const venue = async (over = {}) => {
  seq += 1;
  const owner = { _id: `owner-http-${seq}`, slug: `local-http-${seq}`, active: true, ...over };
  OWNERS.push(owner);
  const settings = await settingsService.getOrCreateSettings(owner._id);
  return { owner, ownerId: owner._id, slug: owner.slug, settings, panel: { "x-test-owner": owner._id } };
};

// Operador con su dispositivo vinculado (el mismo canje de código que usa el QR).
const waiterDevice = async (v, name) => {
  const waiter = await waiterService.createWaiter(v.ownerId, { name });
  const { code } = await waiterService.issuePairingCode(v.ownerId, waiter.id);
  const paired = await call("POST", "/waiter/pair", { body: { code } });
  assert.equal(paired.status, 201);
  return { id: waiter.id, auth: { Authorization: `Waiter ${paired.body.token}` } };
};

const member = (token) => ({ Authorization: `Group ${token}` });

test("cuenta desde la app del operador: dividir, cobrar en partes y cerrar la mesa", async () => {
  const v = await venue();
  const juan = await waiterDevice(v, "Juan");
  const created = await call("POST", "/waiter/orders", {
    headers: juan.auth,
    body: { tableNumber: 4, items: [{ itemId: PIZZA, quantity: 1 }, { itemId: BEER, quantity: 2 }], clientRequestId: crypto.randomUUID() },
  });
  assert.equal(created.status, 201);
  const sessionId = created.body.order.tableSessionId;
  const url = `/waiter/tables/${sessionId}/bill`;

  let res = await call("GET", url, { headers: juan.auth });
  assert.equal(res.status, 200);
  assert.equal(res.body.bill.total, 15000);

  res = await call("POST", `${url}/guests`, { headers: juan.auth, body: { count: 2 } });
  assert.equal(res.status, 201);
  const [a, b] = res.body.bill.guests.map((guest) => guest.id);

  res = await call("PUT", `${url}/split`, { headers: juan.auth, body: { mode: "equal" } });
  assert.deepEqual(res.body.bill.guests.map((guest) => guest.owed), [7500, 7500]);

  const pizza = res.body.bill.items.find((item) => item.title === "Pizza").id;
  res = await call("PUT", `${url}/items/${pizza}/shares`, { headers: juan.auth, body: { shares: [{ guestId: a, weight: 3 }, { guestId: b }] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.bill.items.find((item) => item.id === pizza).shares.map((share) => share.amount), [7500, 2500]);

  res = await call("PATCH", `${url}/guests/${a}`, { headers: juan.auth, body: { name: "Ana" } });
  assert.equal(res.body.bill.guests[0].name, "Ana");

  const idempotencyKey = crypto.randomUUID();
  const payment = { amount: 7500, methodKind: "debit", guestId: a, idempotencyKey };
  res = await call("POST", `${url}/payments`, { headers: juan.auth, body: payment });
  assert.equal(res.status, 201);
  assert.equal(res.body.payment.methodName, "Débito");
  assert.equal(res.body.payment.actorName, "Juan");
  res = await call("POST", `${url}/payments`, { headers: juan.auth, body: payment });
  assert.equal(res.status, 200, "el reintento no es un pago nuevo");
  assert.equal(res.body.duplicate, true);
  assert.equal(res.body.bill.paid, 7500);

  // Falta cobrar: cerrar la mesa avisa (igual que con pedidos sin entregar).
  await orderService.updateStatus(v.ownerId, created.body.order.id, "delivered");
  res = await call("POST", `/waiter/tables/${sessionId}/close`, { headers: juan.auth, body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "BILL_PENDING");

  res = await call("POST", `${url}/payments`, { headers: juan.auth, body: { amount: 9000, methodKind: "cash", guestId: b } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "OVERPAYMENT");
  res = await call("POST", `${url}/payments`, { headers: juan.auth, body: { amount: 7500, methodKind: "cash", guestId: b } });
  assert.equal(res.body.bill.status, "paid");

  const wrong = res.body.payment.id;
  res = await call("POST", `${url}/payments/${wrong}/void`, { headers: juan.auth, body: { reason: "Era con tarjeta" } });
  assert.equal(res.body.bill.pending, 7500);
  res = await call("POST", `${url}/payments`, { headers: juan.auth, body: { amount: 7500, methodKind: "credit", guestId: b } });
  assert.equal(res.body.bill.pending, 0);

  res = await call("POST", `/waiter/tables/${sessionId}/close`, { headers: juan.auth, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.paidAmount, 15000);
  assert.equal(res.body.session.splitMode, "equal");

  // Cerrada: se consulta (también en el historial del operador), no se cambia.
  res = await call("GET", url, { headers: juan.auth });
  assert.equal(res.body.bill.closed, true);
  res = await call("POST", `${url}/guests`, { headers: juan.auth, body: { name: "Tarde" } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "TABLE_CLOSED");
});

test("permisos de la cuenta: sin acceso, operador de otra mesa, otro local y panel", async () => {
  const v = await venue();
  const juan = await waiterDevice(v, "Juan");
  const pedro = await waiterDevice(v, "Pedro");
  const created = await call("POST", "/waiter/orders", {
    headers: juan.auth, body: { tableNumber: 1, items: [{ itemId: PIZZA, quantity: 1 }], clientRequestId: crypto.randomUUID() },
  });
  const sessionId = created.body.order.tableSessionId;
  const url = `/waiter/tables/${sessionId}/bill`;
  const payment = { amount: 100, methodKind: "cash" };

  assert.equal((await call("GET", url)).status, 401);
  assert.equal((await call("GET", url, { headers: { Authorization: `Waiter ${"x".repeat(43)}` } })).status, 401);
  assert.equal((await call("POST", `${url}/payments`, { body: payment })).status, 401);
  // El token de un integrante de un pedido grupal no sirve como operador (ni al revés).
  assert.equal((await call("GET", url, { headers: member("x".repeat(43)) })).status, 401);
  assert.equal((await call("GET", "/group/me", { headers: juan.auth })).status, 401);

  assert.equal((await call("GET", url, { headers: pedro.auth })).status, 403);
  assert.equal((await call("POST", `${url}/payments`, { headers: pedro.auth, body: payment })).status, 403);
  assert.equal((await call("PUT", `${url}/split`, { headers: pedro.auth, body: { mode: "equal" } })).status, 403);

  // Otro local: su operador y su panel no llegan a esta mesa.
  const other = await venue();
  const ajeno = await waiterDevice(other, "Ajeno");
  assert.equal((await call("GET", url, { headers: ajeno.auth })).status, 404);
  assert.equal((await call("GET", `/table-sessions/${sessionId}/bill`, { headers: other.panel })).status, 404);
  assert.equal((await call("POST", `/table-sessions/${sessionId}/bill/payments`, { headers: other.panel, body: payment })).status, 404);

  // El panel del local: sin sesión no; con sesión, cualquier mesa.
  assert.equal((await call("GET", `/table-sessions/${sessionId}/bill`)).status, 401);
  const viaPanel = await call("POST", `/table-sessions/${sessionId}/bill/payments`, { headers: v.panel, body: payment });
  assert.equal(viaPanel.status, 201);
  assert.equal(viaPanel.body.payment.actorType, "panel");
  assert.equal((await call("GET", `/table-sessions/${sessionId}/bill`, { headers: v.panel })).body.bill.paid, 100);

  // Sin plan Pro no hay gestión de pedidos (ni cuenta).
  const free = await venue({ pro: false });
  assert.equal((await call("GET", `/table-sessions/${sessionId}/bill`, { headers: free.panel })).status, 403);

  // Un operador dado de baja pierde el acceso en el momento.
  await waiterService.deleteWaiter(v.ownerId, juan.id);
  assert.equal((await call("GET", url, { headers: juan.auth })).status, 401);
});

test("validaciones de los endpoints de la cuenta", async () => {
  const v = await venue();
  const { order } = await orderService.createOrder({
    owner: v.owner, settings: v.settings, source: "panel", serviceType: "table", tableNumber: 2,
    lines: [{ itemId: PIZZA, option: null, quantity: 1, notes: null }],
  });
  const url = `/table-sessions/${order.tableSessionId}/bill`;
  const bad = async (method, path, body) => (await call(method, `${url}${path}`, { headers: v.panel, body })).status;

  assert.equal(await bad("POST", "/guests", {}), 400);
  assert.equal(await bad("POST", "/guests", { name: "x".repeat(41) }), 400);
  assert.equal(await bad("POST", "/guests", { count: 31 }), 400);
  assert.equal(await bad("PUT", "/split", { mode: "raro" }), 400);
  assert.equal(await bad("PUT", "/items/abc/shares", { shares: [] }), 400);
  assert.equal(await bad("PUT", "/items/999999/shares", { shares: [] }), 404);
  assert.equal(await bad("POST", "/payments", { amount: "mucho", methodKind: "cash" }), 400);
  assert.equal(await bad("POST", "/payments", { amount: 100, methodKind: "bitcoin" }), 400);
  assert.equal(await bad("POST", "/payments/999999/void", {}), 404);
  assert.equal(await bad("DELETE", "/guests/999999"), 404);
  assert.equal((await call("GET", "/table-sessions/0/bill", { headers: v.panel })).status, 400);
});

test("pedido grupal de punta a punta: QR de la mesa, sumarse con código y enlace, cargar, enviar y cobrar", async () => {
  const v = await venue();
  const tablesOf = await settingsService.listTables(v.ownerId);
  const table7 = tablesOf.find((t) => t.number === 7).qrToken;
  const publicUrl = `/public/${v.slug}/group`;

  // Ana escaneó el QR de la mesa 7 y abre el pedido grupal.
  let res = await call("POST", publicUrl, { body: { token: table7, name: "Ana" } });
  assert.equal(res.status, 201);
  const ana = member(res.body.memberToken);
  const { code, joinToken, id: groupId } = res.body.group;
  assert.equal(res.body.group.tableNumber, 7);

  // Beto tipea el código; Caro abre el enlace / QR del grupo.
  res = await call("POST", `${publicUrl}/join`, { body: { code: code.toLowerCase(), name: "Beto" } });
  assert.equal(res.status, 201);
  const beto = member(res.body.memberToken);
  res = await call("POST", `${publicUrl}/join`, { body: { joinToken, name: "Caro" } });
  const caro = member(res.body.memberToken);
  assert.deepEqual(res.body.group.members.map((m) => m.name), ["Ana", "Beto", "Caro"]);

  // Cada uno carga lo suyo desde su celular.
  res = await call("POST", "/group/items", { headers: ana, body: { items: [{ itemId: PIZZA, quantity: 1, shared: true, clientItemId: crypto.randomUUID() }] } });
  assert.equal(res.status, 201);
  res = await call("POST", "/group/items", { headers: beto, body: { items: [{ itemId: BEER, quantity: 1, notes: "sin hielo" }] } });
  const betoBeer = res.body.group.cart.find((item) => item.mine).id;
  res = await call("PATCH", `/group/items/${betoBeer}`, { headers: beto, body: { quantity: 2 } });
  assert.equal(res.body.group.cart.find((item) => item.id === betoBeer).quantity, 2);
  // Caro no puede tocar lo de Beto.
  assert.equal((await call("PATCH", `/group/items/${betoBeer}`, { headers: caro, body: { quantity: 9 } })).status, 403);
  assert.equal((await call("DELETE", `/group/items/${betoBeer}`, { headers: caro })).status, 403);
  res = await call("POST", "/group/items", { headers: caro, body: { items: [{ itemId: BEER, quantity: 1 }] } });
  const caroBeer = res.body.group.cart.find((item) => item.mine).id;
  res = await call("DELETE", `/group/items/${caroBeer}`, { headers: caro });
  assert.equal(res.body.group.cart.length, 2);

  res = await call("GET", "/group/me", { headers: caro });
  assert.equal(res.status, 200);
  assert.equal(res.body.member.name, "Caro");
  assert.equal(res.body.ordering, true);
  assert.equal(res.body.group.cartTotal, 15000);

  // Ana y Beto tocan Enviar al mismo tiempo: un solo pedido.
  const sends = await Promise.all([
    call("POST", "/group/send", { headers: ana, body: { clientRequestId: crypto.randomUUID() } }),
    call("POST", "/group/send", { headers: beto, body: { clientRequestId: crypto.randomUUID() } }),
  ]);
  assert.deepEqual(sends.map((s) => s.status).sort(), [201, 409]);
  const sent = sends.find((s) => s.status === 201).body;
  assert.equal(sent.order.total, 15000);
  assert.equal(sent.order.tableNumber, 7);
  assert.equal(sent.group.cart.length, 0);
  assert.equal("items" in sent.order, false, "al comensal solo se le confirma el envío");

  // El panel lo ve como un pedido más, con el autor de cada producto.
  res = await call("GET", "/board", { headers: v.panel });
  assert.equal(res.body.orders.length, 1);
  const order = res.body.orders[0];
  assert.equal(order.status, "pending");
  assert.deepEqual(order.items.map((item) => [item.title, item.authorName, item.shared]), [["Pizza", "Ana", true], ["Cerveza", "Beto", false]]);

  // Y en Mesas está la cuenta ya repartida, lista para cobrar a mano.
  res = await call("GET", `/table-sessions/${order.tableSessionId}/bill`, { headers: v.panel });
  assert.deepEqual(res.body.bill.guests.map((guest) => [guest.name, guest.owed]), [["Ana", 3333.34], ["Beto", 8333.33], ["Caro", 3333.33]]);
  res = await call("POST", `/table-sessions/${order.tableSessionId}/bill/payments`, {
    headers: v.panel, body: { amount: 8333.33, methodKind: "transfer", guestId: res.body.bill.guests[1].id },
  });
  assert.equal(res.body.bill.guests[1].balance, 0);

  // El personal ve el grupo abierto.
  res = await call("GET", "/groups", { headers: v.panel });
  assert.deepEqual(res.body.groups.map((g) => [g.id, g.tableNumber, g.orders.length]), [[groupId, 7, 1]]);

  // Caro se va: su acceso deja de servir.
  assert.equal((await call("POST", "/group/leave", { headers: caro })).status, 204);
  assert.equal((await call("GET", "/group/me", { headers: caro })).status, 401);
});

test("pedido grupal: quién puede abrirlo o sumarse, y qué se valida", async () => {
  const v = await venue();
  const url = `/public/${v.slug}/group`;
  const general = v.settings.general_qr_token;

  // Sin QR del local no se abre; con el QR general hay que decir la mesa.
  assert.equal((await call("POST", url, { body: { name: "Ana" } })).status, 403);
  assert.equal((await call("POST", url, { body: { token: "x".repeat(24), name: "Ana" } })).status, 403);
  assert.equal((await call("POST", url, { body: { token: general, name: "Ana" } })).status, 400);
  assert.equal((await call("POST", url, { body: { token: general, tableNumber: 999, name: "Ana" } })).status, 400);
  assert.equal((await call("POST", url, { body: { token: general, tableNumber: 3 } })).status, 400);
  assert.equal((await call("POST", `/public/no-existe/group`, { body: { token: general, tableNumber: 3, name: "Ana" } })).status, 404);

  let res = await call("POST", url, { body: { token: general, tableNumber: 3, name: "Ana" } });
  assert.equal(res.status, 201);
  const ana = member(res.body.memberToken);
  const { code } = res.body.group;

  assert.equal((await call("POST", `${url}/join`, { body: { code: "AAAAAA", name: "Beto" } })).status, 404);
  assert.equal((await call("POST", `${url}/join`, { body: { code, name: "ANA" } })).status, 409);
  assert.equal((await call("POST", `${url}/join`, { body: { code } })).status, 400);

  assert.equal((await call("GET", "/group/me")).status, 401);
  assert.equal((await call("GET", "/group/me", { headers: member("x".repeat(43)) })).status, 401);
  assert.equal((await call("POST", "/group/items", { headers: ana, body: { items: [] } })).status, 400);
  assert.equal((await call("POST", "/group/items", { headers: ana, body: { items: [{ itemId: "no-es-un-id", quantity: 1 }] } })).status, 400);
  assert.equal((await call("POST", "/group/items", { headers: ana, body: { items: [{ itemId: PIZZA, quantity: 99 }] } })).status, 400);
  assert.equal((await call("POST", "/group/items", { headers: ana, body: { items: [{ itemId: PIZZA, quantity: 1, shared: "si" }] } })).status, 400);
  assert.equal((await call("POST", "/group/items", { headers: ana, body: { items: [{ itemId: "f".repeat(24), quantity: 1 }] } })).status, 400);
  res = await call("POST", "/group/send", { headers: ana, body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "GROUP_CART_EMPTY");
});

test("local sin pedidos directos del comensal: el grupo arma el carrito y lo envía el operador", async () => {
  const v = await venue();
  await settingsService.updateSettings(v.ownerId, { customerOrdering: false });
  const juan = await waiterDevice(v, "Juan");

  // El operador abre el pedido grupal de la mesa 5 y muestra el QR / código.
  let res = await call("POST", "/waiter/groups", { headers: juan.auth, body: { tableNumber: 5 } });
  assert.equal(res.status, 201);
  const { id: groupId, code, joinToken } = res.body.group;
  assert.ok(joinToken);
  assert.equal((await call("POST", "/waiter/groups", { headers: juan.auth, body: { tableNumber: 5 } })).status, 200, "abrirlo de nuevo devuelve el mismo");
  assert.equal((await call("POST", "/waiter/groups", { headers: juan.auth, body: { tableNumber: 9999 } })).status, 400);

  res = await call("POST", `/public/${v.slug}/group/join`, { body: { code, name: "Ana" } });
  const ana = member(res.body.memberToken);
  await call("POST", "/group/items", { headers: ana, body: { items: [{ itemId: PIZZA, quantity: 1 }, { itemId: BEER, quantity: 3 }] } });
  assert.equal((await call("GET", "/group/me", { headers: ana })).body.ordering, false);

  res = await call("POST", "/group/send", { headers: ana, body: { clientRequestId: crypto.randomUUID() } });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "CUSTOMER_ORDERING_OFF");

  // El operador ve el carrito, saca algo que no hay y lo envía.
  res = await call("GET", "/waiter/groups", { headers: juan.auth });
  const cart = res.body.groups.find((g) => g.id === groupId).cart;
  assert.deepEqual(cart.map((item) => [item.authorName, item.title, item.quantity]), [["Ana", "Pizza", 1], ["Ana", "Cerveza", 3]]);
  res = await call("DELETE", `/waiter/groups/${groupId}/items/${cart[1].id}`, { headers: juan.auth });
  assert.equal(res.body.group.cart.length, 1);

  const clientRequestId = crypto.randomUUID();
  res = await call("POST", `/waiter/groups/${groupId}/send`, { headers: juan.auth, body: { clientRequestId, notes: "Mesa del fondo" } });
  assert.equal(res.status, 201);
  assert.equal(res.body.order.status, "confirmed");
  assert.equal(res.body.order.source, "waiter");
  assert.equal(res.body.order.waiterName, "Juan");
  assert.equal(res.body.order.items[0].authorName, "Ana");
  const retry = await call("POST", `/waiter/groups/${groupId}/send`, { headers: juan.auth, body: { clientRequestId } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.order.id, res.body.order.id);

  // La mesa quedó entre las suyas, con la cuenta armada.
  res = await call("GET", "/waiter/tables", { headers: juan.auth });
  assert.equal(res.body.sessions[0].tableNumber, 5);
  res = await call("GET", `/waiter/tables/${res.body.sessions[0].id}/bill`, { headers: juan.auth });
  assert.deepEqual(res.body.bill.guests.map((guest) => [guest.name, guest.owed]), [["Ana", 10000]]);

  // Cierra el pedido grupal: los comensales ya no pueden cargar.
  res = await call("POST", `/waiter/groups/${groupId}/close`, { headers: juan.auth });
  assert.equal(res.body.group.open, false);
  res = await call("POST", "/group/items", { headers: ana, body: { items: [{ itemId: BEER, quantity: 1 }] } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "GROUP_CLOSED");
  assert.equal((await call("GET", "/group/me", { headers: ana })).body.group.open, false);

  // Otro local no ve ni toca este grupo.
  const other = await venue();
  assert.deepEqual((await call("GET", "/groups", { headers: other.panel })).body.groups, []);
  assert.equal((await call("POST", `/groups/${groupId}/send`, { headers: other.panel, body: {} })).status, 404);
  assert.equal((await call("POST", `/groups/${groupId}/close`, { headers: other.panel })).status, 404);
  assert.equal((await call("GET", "/waiter/groups")).status, 401);
});
