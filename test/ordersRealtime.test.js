const test = require("node:test");
const assert = require("node:assert/strict");

// Tiempo real de pedidos: mozos y pantallas de sector se suman al WebSocket, y
// cada operación que cambia algo avisa a quien corresponde (sin datos).

const fakeSocket = () => {
  const handlers = {};
  return {
    sent: [], closed: null,
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code) { this.closed = code; },
    on(event, fn) { handlers[event] = fn; },
    receive(message) { return handlers.message(JSON.stringify(message)); },
    drop() { handlers.close?.(); },
  };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

const buildHub = () => {
  const { createHub } = require("../src/orders/delivery/realtime");
  return createHub({
    authorizeOwner: async (token) => (token.startsWith("jwt-") ? token.slice(4) : null),
    authorizeCourier: async () => null,
    authorizeCustomer: async (slug, ref) => (ref === "good-ref" ? { ownerId: "o1" } : null),
    authorizeStaff: async (role, token) => {
      const match = new RegExp(`^${role}-(\\w+)$`).exec(token);
      return match ? { ownerId: match[1] } : null;
    },
  });
};

const withHub = (t) => {
  const realtime = require("../src/orders/delivery/realtime");
  const hub = buildHub();
  realtime.setHubForTests(hub);
  t.after(() => realtime.setHubForTests(null));
  const connect = async (message) => {
    const socket = fakeSocket();
    hub.connect(socket);
    await socket.receive(message);
    await tick();
    return socket;
  };
  return { realtime, hub, connect };
};

test("websocket: mozos y sectores reciben los avisos de su local, sin datos del pedido", async (t) => {
  const { realtime, connect } = withHub(t);
  const waiter = await connect({ type: "auth", role: "waiter", token: "waiter-o1" });
  const station = await connect({ type: "auth", role: "station", token: "station-o1" });
  const foreign = await connect({ type: "auth", role: "waiter", token: "waiter-o2" });
  const owner = await connect({ type: "auth", token: "jwt-o1" });
  assert.equal(waiter.sent[0].role, "waiter");
  assert.equal(station.sent[0].role, "station");
  for (const s of [waiter, station, foreign, owner]) s.sent.length = 0;

  realtime.emit({ ownerId: "o1", event: "order_created", orderId: 7, orderNumber: 3, staff: true });
  assert.deepEqual(waiter.sent, [{ type: "orders", event: "order_created" }], "solo «volvé a consultar»");
  assert.deepEqual(station.sent, [{ type: "orders", event: "order_created" }]);
  assert.equal(owner.sent[0].orderId, 7);
  assert.equal(foreign.sent.length, 0, "otro local no recibe nada");
});

test("websocket: lo que es solo de reparto no molesta al salón; la entrega sí lo cierra", async (t) => {
  const { realtime, connect } = withHub(t);
  const waiter = await connect({ type: "auth", role: "waiter", token: "waiter-o1" });
  waiter.sent.length = 0;
  realtime.emit({ ownerId: "o1", event: "assigned", orderId: 7, courierIds: [10], openList: true });
  realtime.emit({ ownerId: "o1", event: "courier_updated", courierIds: [10] });
  assert.equal(waiter.sent.length, 0);
  realtime.emit({ ownerId: "o1", event: "delivered", orderId: 7 });
  assert.deepEqual(waiter.sent, [{ type: "orders", event: "delivered" }]);
});

test("websocket: token de dispositivo inválido corta la conexión; al desconectarse deja de recibir", async (t) => {
  const { realtime, connect } = withHub(t);
  const bad = await connect({ type: "auth", role: "station", token: "falso" });
  assert.equal(bad.closed, 1008);
  const crossed = await connect({ type: "auth", role: "station", token: "waiter-o1" });
  assert.equal(crossed.closed, 1008, "un token de mozo no sirve para una pantalla de sector");

  const waiter = await connect({ type: "auth", role: "waiter", token: "waiter-o1" });
  waiter.sent.length = 0;
  waiter.drop();
  realtime.emit({ ownerId: "o1", event: "table", staff: true });
  assert.equal(waiter.sent.length, 0);
});

test("websocket: el cliente que espera su pago recibe el aviso por su referencia", async (t) => {
  const { realtime, connect } = withHub(t);
  const customer = await connect({ type: "watch", slug: "mi-local", ref: "good-ref" });
  customer.sent.length = 0;
  realtime.emitToCustomer("o1", "good-ref", "payment");
  realtime.emitToCustomer("o1", "otra-ref", "payment");
  realtime.emitToCustomer("o2", "good-ref", "payment");
  assert.deepEqual(customer.sent, [{ type: "order", event: "payment" }]);
});

test("websocket: un hub anterior (sin sala de staff) o sin hub nunca rompe la operación", () => {
  const realtime = require("../src/orders/delivery/realtime");
  realtime.setHubForTests({ toOwner() {} });
  assert.doesNotThrow(() => realtime.emit({ ownerId: "o1", event: "table", staff: true }));
  assert.doesNotThrow(() => realtime.emitToCustomer("o1", "ref", "payment"));
  realtime.setHubForTests(null);
  assert.doesNotThrow(() => realtime.emitToCustomer("o1", "ref", "payment"));
});

// ── Cada operación avisa ──────────────────────────────────────────────────
const spyEmit = (t) => {
  const realtime = require("../src/orders/delivery/realtime");
  const events = [];
  t.mock.method(realtime, "emit", (event) => { events.push(event); });
  return events;
};

const reload = (t, name) => {
  const path = require.resolve(`../src/orders/services/${name}`);
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  return require(path);
};

test("comandas: cuando un sector avanza o imprime, el panel y los otros equipos se enteran", async (t) => {
  const sql = require("../src/orders/db/sql");
  const ticket = { id: 50, owner_id: "o1", sector_id: 1, status: "new" };
  const run = async (text) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT * FROM order_tickets")) return { rows: [ticket] };
    return { rows: [] };
  };
  t.mock.method(sql, "query", run);
  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: run }));
  const events = spyEmit(t);
  const service = reload(t, "ticketService");

  await service.updateTicketStatus("o1", 1, 50, "preparing");
  await service.markPrinted("o1", 1, 50);
  assert.deepEqual(events, [
    { ownerId: "o1", event: "ticket", staff: true },
    { ownerId: "o1", event: "ticket", staff: true },
  ]);
});

test("mesas: cambiar comensales avisa al panel y a los mozos", async (t) => {
  const sql = require("../src/orders/db/sql");
  t.mock.method(sql, "query", async (text) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.includes("FROM table_sessions")) return { rows: [{ id: 9, owner_id: "o1", table_number: 4, waiter_id: null, closed_at: null }] };
    return { rows: [] };
  });
  const events = spyEmit(t);
  const service = reload(t, "tableSessionService");
  await service.setGuests("o1", 9, 3);
  assert.deepEqual(events, [{ ownerId: "o1", event: "table", staff: true }]);
});

test("asignar operador a un pedido avisa al salón", async (t) => {
  const sql = require("../src/orders/db/sql");
  const dto = require("../src/orders/services/orderDTO");
  const order = { id: 7, owner_id: "o1", shift_id: 1, number: 3, status: "confirmed", service_type: "table", table_number: 4, total: "1000" };
  t.mock.method(sql, "query", async () => ({ rows: [order] }));
  t.mock.method(dto, "withItems", async (rows) => rows.map((row) => dto.toOrderDTO(row)));
  const events = spyEmit(t);
  const service = reload(t, "orderService");
  await service.assignWaiter("o1", 7, { id: 4, name: "Marta" });
  assert.deepEqual(events, [{ ownerId: "o1", event: "order_waiter", orderId: 7, staff: true }]);
});
