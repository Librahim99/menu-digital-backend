const test = require("node:test");
const assert = require("node:assert/strict");
const OwnerPushToken = require("../src/models/OwnerPushToken");
const { setMessagingForTests } = require("../src/services/adminPushService");
const { notifyOwner, orderAlert, reservationAlert } = require("../src/services/ownerPushService");
const { createHub } = require("../src/reservations/realtime");
const { registerToken } = require("../src/controllers/ownerPushController");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

const OWNER = "64f000000000000000000101";

const order = (overrides = {}) => ({
  id: 12, number: 7, source: "customer", status: "pending", serviceType: "table", tableNumber: "5",
  tableSessionId: 40, waiterName: null, total: 12500, items: [{ quantity: 2 }, { quantity: 1 }], ...overrides,
});

test("orderAlert: pedido del comensal avisa como pedido nuevo", () => {
  const alert = orderAlert(order({ serviceType: "delivery", tableNumber: null }));
  assert.equal(alert.kind, "order");
  assert.equal(alert.key, "order:12");
  assert.equal(alert.title, "🛎️ Nuevo pedido #7");
  assert.match(alert.body, /^Delivery · 3 productos · \$12\.500$/);
  assert.equal(alert.url, "/pedidos");
});

test("orderAlert: el pedido que abre una mesa avisa la mesa (comensal u operador)", () => {
  const fromCustomer = orderAlert(order(), { tableOpened: true });
  assert.equal(fromCustomer.kind, "table");
  assert.equal(fromCustomer.key, "table:40");
  assert.equal(fromCustomer.title, "🍽️ Mesa 5 abierta");
  assert.match(fromCustomer.body, /Pedido #7 por confirmar/);

  const fromWaiter = orderAlert(order({ source: "waiter", status: "confirmed", waiterName: "Ana" }), { tableOpened: true });
  assert.equal(fromWaiter.kind, "table");
  assert.match(fromWaiter.body, /Pedido #7 de Ana/);
  assert.equal(fromWaiter.url, "/pedidos/mesas");
});

test("orderAlert: no avisa lo que carga el propio local ni el operador en una mesa ya abierta", () => {
  assert.equal(orderAlert(order({ source: "panel" }), { tableOpened: true }), null);
  assert.equal(orderAlert(order({ source: "waiter" }), { tableOpened: false }), null);
  assert.equal(orderAlert(null), null);
});

test("reservationAlert: solo reservas web pendientes", () => {
  const alert = reservationAlert({ id: 3, source: "web", status: "pending", name: "Juan", partySize: 4, date: "2026-10-12", time: "21:00" });
  assert.equal(alert.kind, "reservation");
  assert.equal(alert.key, "reservation:3");
  assert.equal(alert.body, "Juan · 4 personas · 12/10 21:00");
  assert.equal(reservationAlert({ id: 4, source: "manual", status: "pending" }), null);
  assert.equal(reservationAlert({ id: 5, source: "web", status: "confirmed" }), null);
});

test("notifyOwner: sin Firebase no manda nada y no lanza", async (t) => {
  setMessagingForTests(null);
  t.after(() => setMessagingForTests(undefined));
  const summary = await notifyOwner(OWNER, { title: "x" });
  assert.equal(summary.enabled, false);
  assert.equal(summary.devices, 0);
});

test("notifyOwner: manda data-only a los dispositivos del dueño y borra los tokens muertos", async (t) => {
  const sent = [];
  setMessagingForTests({
    sendEachForMulticast: async (message) => {
      sent.push(message);
      return {
        responses: message.tokens.map((token) => (token === "dead-token-000000000000"
          ? { success: false, error: { code: "messaging/registration-token-not-registered" } }
          : { success: true })),
      };
    },
  });
  t.after(() => setMessagingForTests(undefined));
  let tokenFilter = null;
  let deleted = null;
  t.mock.method(OwnerPushToken, "find", (filter) => {
    tokenFilter = filter;
    return { distinct: async () => ["good-token-000000000000", "dead-token-000000000000"] };
  });
  t.mock.method(OwnerPushToken, "deleteMany", async (filter) => { deleted = filter; });

  const summary = await notifyOwner(OWNER, { title: "🛎️ Nuevo pedido #7", body: "Mesa 5", url: "/pedidos", tag: "order-12", kind: "order" });

  // Solo los dispositivos que activaron los avisos de Pedidos.
  assert.deepEqual(tokenFilter, { userID: OWNER, features: "orders" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].data, { title: "🛎️ Nuevo pedido #7", body: "Mesa 5", url: "/pedidos", tag: "order-12", scope: "owner" });
  assert.equal(sent[0].notification, undefined);
  assert.deepEqual(summary, { enabled: true, devices: 2, delivered: 1, failed: 1, removed: 1, error: null });
  assert.deepEqual(deleted, { token: { $in: ["dead-token-000000000000"] } });
});

test("reservas en vivo: el aviso de reserva nueva llega solo al panel del local", async () => {
  const hub = createHub({ authorizeOwner: async () => "owner1", authorizeCode: async () => null });
  const received = [];
  const handlers = {};
  const socket = {
    send: (raw) => received.push(JSON.parse(raw)),
    on: (event, handler) => { handlers[event] = handler; },
    close: () => {},
  };
  hub.connect(socket);
  handlers.message(JSON.stringify({ type: "auth", token: "jwt" }));
  await new Promise((resolve) => setImmediate(resolve));

  const alert = { kind: "reservation", key: "reservation:1", title: "📅 Nueva reserva", body: "Juan" };
  hub.publish("owner1", "ABCDEFGH", { id: 1 }, { status: "pending" }, alert);
  hub.publish("owner1", "ABCDEFGH", { id: 1 }, { status: "confirmed" });

  const reservations = received.filter((message) => message.type === "reservation");
  assert.deepEqual(reservations[0].alert, alert);
  assert.equal(reservations[1].alert, undefined);
});

test("notifyOwner: una reserva va solo a los dispositivos con Reservas activado; la prueba, a todos los activos", async (t) => {
  setMessagingForTests({ sendEachForMulticast: async ({ tokens }) => ({ responses: tokens.map(() => ({ success: true })) }) });
  t.after(() => setMessagingForTests(undefined));
  const filters = [];
  t.mock.method(OwnerPushToken, "find", (filter) => {
    filters.push(filter);
    return { distinct: async () => [] };
  });

  await notifyOwner(OWNER, { title: "📅 Nueva reserva", kind: "reservation" });
  await notifyOwner(OWNER, { title: "🔔 Aviso de prueba" });

  assert.deepEqual(filters[0], { userID: OWNER, features: "reservations" });
  assert.deepEqual(filters[1], { userID: OWNER, features: { $exists: true, $ne: [] } });
});

test("registerToken: guarda los features elegidos y sin ninguno da de baja el dispositivo", async (t) => {
  const upserts = [];
  const deletes = [];
  t.mock.method(OwnerPushToken, "findOneAndUpdate", async (filter, update) => { upserts.push(update.$set); });
  t.mock.method(OwnerPushToken, "deleteOne", async (filter) => { deletes.push(filter); });
  const req = (body) => ({ body, user: { _id: OWNER }, get: () => "UA" });
  const token = "token-de-prueba-0000000000";

  let res = response();
  await registerToken(req({ token, features: ["orders", "orders"] }), res);
  assert.equal(res.statusCode, 204);
  assert.deepEqual(upserts[0].features, ["orders"]);

  res = response();
  await registerToken(req({ token, features: [] }), res);
  assert.deepEqual(deletes[0], { token, userID: OWNER });

  res = response();
  await registerToken(req({ token, features: ["todo"] }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(upserts.length, 1);
});
