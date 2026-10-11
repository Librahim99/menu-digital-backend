const test = require("node:test");
const assert = require("node:assert/strict");
const { orderAlert, reservationAlert } = require("../src/services/ownerAlerts");
const { createHub } = require("../src/reservations/realtime");


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
