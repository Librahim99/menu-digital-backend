const test = require("node:test");
const assert = require("node:assert/strict");

// ── "Salió el pedido" (delivery) ──────────────────────────────────────────
const loadOrderService = (t, order) => {
  const sql = require("../src/orders/db/sql");
  const dto = require("../src/orders/services/orderDTO");
  const state = { order, updates: 0 };
  const run = async (text) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT * FROM orders WHERE owner_id")) return { rows: [state.order] };
    if (q.startsWith("UPDATE orders SET dispatched_at")) {
      state.updates += 1;
      state.order = { ...state.order, dispatched_at: new Date() };
      return { rows: [state.order] };
    }
    return { rows: [] };
  };
  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: run }));
  t.mock.method(dto, "withItems", async (rows) => rows.map((row) => dto.toOrderDTO(row)));
  const path = require.resolve("../src/orders/services/orderService");
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  return { service: require(path), state };
};

const readyDelivery = () => ({
  id: 7, shift_id: 1, number: 3, owner_id: "o1", status: "ready", service_type: "delivery",
  ready_at: new Date("2026-01-01T20:00:00Z"), dispatched_at: null, total: "3000",
});

test("delivery listo: se marca que salió sin cambiar el estado", async (t) => {
  const { service, state } = loadOrderService(t, readyDelivery());
  const order = await service.markDispatched("o1", 7);
  assert.equal(state.updates, 1);
  assert.equal(order.status, "ready", "sigue en 'ready': no es un estado nuevo");
  assert.ok(order.dispatchedAt);
});

test("marcarlo dos veces no pisa la hora de salida", async (t) => {
  const { service, state } = loadOrderService(t, readyDelivery());
  await service.markDispatched("o1", 7);
  await service.markDispatched("o1", 7);
  assert.equal(state.updates, 1);
});

test("solo delivery y solo si está listo", async (t) => {
  const takeaway = loadOrderService(t, { ...readyDelivery(), service_type: "takeaway" });
  await assert.rejects(takeaway.service.markDispatched("o1", 7), (e) => e.status === 409 && e.code === "NOT_DELIVERY");
  const preparing = loadOrderService(t, { ...readyDelivery(), status: "confirmed" });
  await assert.rejects(preparing.service.markDispatched("o1", 7), (e) => e.status === 409 && e.code === "NOT_READY");
  assert.equal(takeaway.state.updates + preparing.state.updates, 0);
});

test("una salida anterior a volver a quedar listo ya no cuenta como 'en camino'", (t) => {
  const { dispatchedAtOf } = require("../src/orders/services/orderDTO");
  const ready = new Date("2026-10-09T20:30:00Z");
  assert.equal(dispatchedAtOf({ status: "ready", ready_at: ready, dispatched_at: new Date("2026-10-09T20:10:00Z") }), null);
  assert.ok(dispatchedAtOf({ status: "ready", ready_at: ready, dispatched_at: new Date("2026-10-09T20:40:00Z") }));
  assert.equal(dispatchedAtOf({ status: "delivered", ready_at: ready, dispatched_at: new Date("2026-10-09T20:40:00Z") }), null);
  assert.equal(dispatchedAtOf({ status: "ready", ready_at: ready, dispatched_at: null }), null);
  assert.equal(dispatchedAtOf({ status: "ready", ready_at: ready }), null, "sin la migración la columna no existe");
});

test("migración 005: aditiva e idempotente", () => {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "src", "orders", "db", "migrations");
  const sql = fs.readFileSync(path.join(dir, "005_pedido_en_camino.sql"), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS dispatched_at timestamptz/);
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|\bRENAME\b|status/i);
});

// ── El mozo solo toma pedidos de mesa ─────────────────────────────────────
const callWaiterCreate = async (t, body) => {
  const orderService = require("../src/orders/services/orderService");
  const create = t.mock.method(orderService, "createOrder", async () => ({ order: { id: 1 }, duplicate: false }));
  const path = require.resolve("../src/orders/controllers/waiterController");
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  const { createOrder } = require(path);
  t.mock.method(console, "error", () => {});
  const res = { statusCode: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
  const req = {
    orderSettings: { table_count: 10 }, owner: { _id: "o1" }, body,
    waiterSession: { waiterId: 4, name: "Marta", sessionId: 9 },
  };
  await createOrder(req, res);
  return { res, create };
};

const ITEMS = [{ itemId: "507f1f77bcf86cd799439011", quantity: 1 }];

test("mozo: un pedido de mesa se toma normalmente", async (t) => {
  const { res, create } = await callWaiterCreate(t, { serviceType: "table", tableNumber: 3, items: ITEMS });
  assert.equal(res.statusCode, 201);
  const args = create.mock.calls[0].arguments[0];
  assert.equal(args.serviceType, "table");
  assert.equal(args.tableNumber, 3);
  assert.equal(args.source, "waiter");
});

test("mozo: sin serviceType (app vieja) con mesa sigue funcionando", async (t) => {
  const { res } = await callWaiterCreate(t, { tableNumber: 2, items: ITEMS });
  assert.equal(res.statusCode, 201);
});

test("mozo: barra, take away y delivery se rechazan", async (t) => {
  for (const serviceType of ["counter", "takeaway", "delivery"]) {
    const { res, create } = await callWaiterCreate(t, { serviceType, tableNumber: 3, items: ITEMS, customerName: "Ana", deliveryAddress: "Calle 1" });
    assert.equal(res.statusCode, 403, serviceType);
    assert.equal(res.payload.code, "WAITER_TABLE_ONLY");
    assert.equal(create.mock.callCount(), 0, `${serviceType}: no se crea nada`);
  }
});

test("mozo: sin mesa no se crea el pedido (no se convierte en barra)", async (t) => {
  const { res, create } = await callWaiterCreate(t, { items: ITEMS });
  assert.equal(res.statusCode, 400);
  assert.equal(create.mock.callCount(), 0);
});
