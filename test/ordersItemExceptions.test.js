const test = require("node:test");
const assert = require("node:assert/strict");

// Manejo de pedidos que no siguen su curso natural: quitar un producto (falta
// de stock), restaurarlo y entregar en partes.

const OWNER = "o1";
const ACTOR = { type: "panel", id: OWNER, name: "Panel" };

const line = (id, over = {}) => ({
  id: String(id), order_id: "7", item_id: `item-${id}`, title: `Producto ${id}`, category_id: null, category_name: null,
  section_id: null, option_name: null, unit_price: "1000.00", quantity: 1, notes: null, position: Number(id), ticket_id: null,
  status: "active", status_reason: null, cancelled_at: null, delivered_at: null, ...over,
});

const baseOrder = (over = {}) => ({
  id: "7", owner_id: OWNER, shift_id: 1, number: 3, source: "panel", status: "confirmed", service_type: "table",
  table_number: 4, payment_mode: "none", payment_status: "NOT_REQUIRED", subtotal: "0", discount_amount: "0", total: "0",
  ready_at: null, dispatched_at: null, ...over,
});

// Mini base en memoria con lo que consultan orderItemService, orderDTO y las comandas.
const setup = (t, { order = baseOrder(), items, tickets = [], payment = null } = {}) => {
  const sql = require("../src/orders/db/sql");
  const ticketService = require("../src/orders/services/ticketService");
  const realtime = require("../src/orders/delivery/realtime");
  const state = { order, items, tickets, payment, events: [], statusEvents: [], seq: 100 };
  const amountOf = () => state.items.filter((i) => i.status !== "cancelled").reduce((sum, i) => sum + Number(i.unit_price) * i.quantity, 0);
  state.order.subtotal = state.order.total = String(amountOf());
  const byId = (id) => state.items.find((i) => String(i.id) === String(id));

  const run = async (text, params = []) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT * FROM orders WHERE owner_id = $1 AND id = $2")) {
      return { rows: params[0] === state.order.owner_id && String(params[1]) === state.order.id ? [state.order] : [] };
    }
    if (q.startsWith("SELECT * FROM order_items WHERE order_id = $1")) return { rows: state.items };
    if (q.startsWith("UPDATE order_items SET status = 'cancelled'")) {
      Object.assign(byId(params[0]), { status: "cancelled", cancelled_at: new Date(), status_reason: params[1] });
      return { rows: [] };
    }
    if (q.startsWith("UPDATE order_items SET quantity = quantity - $2")) { byId(params[0]).quantity -= params[1]; return { rows: [] }; }
    if (q.startsWith("INSERT INTO order_items (")) {
      const copy = { ...byId(params[0]), id: String(++state.seq), quantity: params[1], status: "cancelled", cancelled_at: new Date(), status_reason: params[2], delivered_at: null };
      state.items.push(copy);
      return { rows: [{ id: copy.id }] };
    }
    if (q.startsWith("UPDATE order_items SET status = 'active'")) {
      Object.assign(byId(params[0]), { status: "active", cancelled_at: null, status_reason: null });
      return { rows: [] };
    }
    if (q.startsWith("UPDATE order_items SET delivered_at = now()")) { byId(params[0]).delivered_at = new Date(); return { rows: [] }; }
    if (q.startsWith("UPDATE order_items SET delivered_at = NULL")) { byId(params[0]).delivered_at = null; return { rows: [] }; }
    if (q.startsWith("INSERT INTO order_item_events")) {
      state.events.push({ itemId: params[2], type: params[3], quantity: params[4], amount: params[5], reason: params[6], actorType: params[7] });
      return { rows: [] };
    }
    if (q.startsWith("UPDATE order_tickets SET status = 'cancelled'")) {
      for (const ticket of state.tickets) {
        const active = state.items.some((i) => String(i.ticket_id) === String(ticket.id) && i.status !== "cancelled");
        if (!active && ticket.status !== "cancelled") ticket.status = "cancelled";
      }
      return { rows: [] };
    }
    if (q.startsWith("UPDATE orders SET subtotal = lines.amount")) {
      const amount = amountOf();
      state.order = { ...state.order, subtotal: String(amount), total: String(Math.max(amount - Number(state.order.discount_amount), 0)) };
      return { rows: [state.order] };
    }
    if (q.startsWith("UPDATE orders SET status = $3")) {
      state.order = { ...state.order, status: params[2], delivered_at: new Date() };
      return { rows: [state.order] };
    }
    if (q.startsWith("INSERT INTO order_status_events")) { state.statusEvents.push({ from: params[2], to: params[3] }); return { rows: [] }; }
    if (q.startsWith("SELECT i.*, t.sector_id AS ticket_sector_id")) {
      return {
        rows: state.items.map((i) => {
          const ticket = state.tickets.find((x) => String(x.id) === String(i.ticket_id));
          return { ...i, ticket_sector_id: ticket?.sector_id, ticket_sector_name: ticket?.sector_name, ticket_status: ticket?.status, ticket_done_at: null };
        }),
      };
    }
    if (q.startsWith("SELECT p.order_id, p.amount, p.refunded_amount")) return { rows: state.payment ? [state.payment] : [] };
    throw new Error(`Consulta no prevista en el test: ${q}`);
  };

  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: run }));
  t.mock.method(sql, "query", run);
  const emitted = [];
  t.mock.method(realtime, "emit", (event) => { emitted.push(event); });
  const issueTickets = t.mock.method(ticketService, "issueTickets", async () => {});

  const paths = ["orderService", "orderItemService"].map((n) => require.resolve(`../src/orders/services/${n}`));
  paths.forEach((p) => { delete require.cache[p]; });
  t.after(() => paths.forEach((p) => { delete require.cache[p]; }));
  return { service: require(paths[1]), state, emitted, issueTickets };
};

test("falta de stock: se quita el producto, el total se recalcula y el resto sigue", async (t) => {
  const { service, state, emitted } = setup(t, { items: [line(1), line(2, { unit_price: "2500.00", quantity: 2 })] });
  const order = await service.removeItem(OWNER, 7, 2, { reason: "Sin stock", actor: ACTOR });

  assert.equal(order.total, 1000);
  assert.equal(order.subtotal, 1000);
  assert.deepEqual(order.items.map((i) => i.id), [1]);
  assert.equal(order.removedItems.length, 1);
  assert.equal(order.removedItems[0].reason, "Sin stock");
  assert.equal(order.removedItems[0].quantity, 2);
  assert.equal(order.status, "confirmed", "el pedido sigue su curso");
  assert.deepEqual(state.events, [{ itemId: "2", type: "removed", quantity: 2, amount: 5000, reason: "Sin stock", actorType: "panel" }]);
  assert.equal(emitted[0].customer, true, "el seguimiento del cliente se entera");
});

test("quitar parte de la cantidad parte la línea en dos", async (t) => {
  const { service, state } = setup(t, { items: [line(1, { quantity: 3 })] });
  const order = await service.removeItem(OWNER, 7, 1, { quantity: 1, reason: "Sin stock", actor: ACTOR });

  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.removedItems[0].quantity, 1);
  assert.equal(order.total, 2000);
  assert.equal(state.items.length, 2);
  assert.equal(state.events[0].amount, 1000);
});

test("no se quita lo último que queda: eso es cancelar el pedido", async (t) => {
  const { service, state } = setup(t, { items: [line(1), line(2, { status: "cancelled" })] });
  await assert.rejects(service.removeItem(OWNER, 7, 1, { actor: ACTOR }), (e) => e.status === 409 && e.code === "LAST_ITEM");
  assert.equal(state.items[0].status, "active");
  assert.equal(state.events.length, 0);
});

test("quitar: cantidad inválida, producto ajeno o ya entregado", async (t) => {
  const { service } = setup(t, { items: [line(1, { quantity: 2 }), line(2, { delivered_at: new Date() })] });
  await assert.rejects(service.removeItem(OWNER, 7, 1, { quantity: 3 }), (e) => e.status === 400);
  await assert.rejects(service.removeItem(OWNER, 7, 99), (e) => e.status === 404);
  await assert.rejects(service.removeItem(OWNER, 7, 2), (e) => e.status === 409 && e.code === "ITEM_DELIVERED");
  await assert.rejects(service.removeItem("otro-local", 7, 1), (e) => e.status === 404);
});

test("solo pedidos en curso y que no hayan salido del local", async (t) => {
  for (const status of ["delivered", "cancelled", "returned"]) {
    const { service } = setup(t, { order: baseOrder({ status }), items: [line(1), line(2)] });
    await assert.rejects(service.removeItem(OWNER, 7, 1), (e) => e.status === 409 && e.code === "ORDER_NOT_ACTIVE", status);
  }
  const ready = new Date("2026-10-09T20:00:00Z");
  const onTheWay = setup(t, {
    order: baseOrder({ status: "ready", service_type: "delivery", ready_at: ready, dispatched_at: new Date("2026-10-09T20:10:00Z") }),
    items: [line(1), line(2)],
  });
  await assert.rejects(onTheWay.service.removeItem(OWNER, 7, 1), (e) => e.code === "ORDER_DISPATCHED");
});

test("quitar dos veces el mismo producto no repite nada", async (t) => {
  const { service, state } = setup(t, { items: [line(1), line(2)] });
  await service.removeItem(OWNER, 7, 2, { actor: ACTOR });
  const again = await service.removeItem(OWNER, 7, 2, { actor: ACTOR });
  assert.equal(state.events.length, 1);
  assert.equal(again.removedItems.length, 1);
});

test("comandas: la del sector que se quedó sin productos se anula, la otra sigue", async (t) => {
  const tickets = [
    { id: "50", sector_id: 1, sector_name: "Cocina", status: "preparing" },
    { id: "51", sector_id: 2, sector_name: "Barra", status: "new" },
  ];
  const { service, state } = setup(t, { tickets, items: [line(1, { ticket_id: "50" }), line(2, { ticket_id: "51" }), line(3, { ticket_id: "50" })] });
  let order = await service.removeItem(OWNER, 7, 1, { actor: ACTOR });
  assert.equal(state.tickets[0].status, "preparing", "a Cocina le queda otro producto");
  order = await service.removeItem(OWNER, 7, 2, { actor: ACTOR });
  assert.equal(state.tickets[1].status, "cancelled");
  assert.deepEqual(order.tickets.map((x) => x.status), ["preparing", "cancelled"]);
});

test("pedido pagado online: al quitar un producto queda el importe exacto a devolver", async (t) => {
  const payment = { order_id: "7", amount: "6000.00", refunded_amount: "0.00", pending_amount: "0" };
  const { service, state } = setup(t, {
    order: baseOrder({ status: "pending", service_type: "delivery", payment_mode: "mercadopago", payment_status: "APPROVED" }),
    items: [line(1), line(2, { unit_price: "2500.00", quantity: 2 })],
    payment,
  });
  let order = await service.removeItem(OWNER, 7, 2, { reason: "Sin stock", actor: ACTOR });
  assert.equal(order.total, 1000);
  assert.equal(order.refundDue, 5000);

  // Ya devuelto (o con la devolución en curso): no se vuelve a pedir.
  state.payment = { ...payment, refunded_amount: "5000.00" };
  order = await service.removeItem(OWNER, 7, 2, { actor: ACTOR });
  assert.equal(order.refundDue, 0);
  state.payment = { ...payment, pending_amount: "5000.00" };
  order = await service.removeItem(OWNER, 7, 2, { actor: ACTOR });
  assert.equal(order.refundDue, 0);
});

test("un pedido sin pago online no consulta pagos ni pide devolución", async (t) => {
  const { service } = setup(t, { items: [line(1), line(2)], payment: { order_id: "7", amount: "9999", refunded_amount: "0", pending_amount: "0" } });
  const order = await service.removeItem(OWNER, 7, 2, { actor: ACTOR });
  assert.equal(order.refundDue, 0);
});

test("restaurar: el producto vuelve al pedido, al total y a su comanda", async (t) => {
  const { service, state, issueTickets } = setup(t, { items: [line(1), line(2, { status: "cancelled", status_reason: "Sin stock" })] });
  const order = await service.restoreItem(OWNER, 7, 2, { actor: ACTOR });
  assert.equal(order.total, 2000);
  assert.equal(order.removedItems.length, 0);
  assert.equal(state.items[1].status_reason, null);
  assert.equal(issueTickets.mock.callCount(), 1);
  assert.equal(state.events[0].type, "restored");
});

test("restaurar: en un pedido sin confirmar no se emiten comandas; con plata devuelta no se puede", async (t) => {
  const pending = setup(t, { order: baseOrder({ status: "pending" }), items: [line(1), line(2, { status: "cancelled" })] });
  await pending.service.restoreItem(OWNER, 7, 2, { actor: ACTOR });
  assert.equal(pending.issueTickets.mock.callCount(), 0);

  const refunded = setup(t, {
    order: baseOrder({ payment_mode: "mercadopago", payment_status: "PARTIALLY_REFUNDED" }),
    items: [line(1), line(2, { status: "cancelled" })],
  });
  await assert.rejects(refunded.service.restoreItem(OWNER, 7, 2, { actor: ACTOR }), (e) => e.status === 409 && e.code === "ORDER_REFUNDED");
  assert.equal(refunded.state.items[1].status, "cancelled");
});

test("entrega en partes: la bebida se entrega y el pedido sigue en curso", async (t) => {
  const { service, state } = setup(t, { items: [line(1, { title: "Gaseosa" }), line(2, { title: "Milanesa" })] });
  const order = await service.setItemDelivered(OWNER, 7, 1, true, { actor: ACTOR });
  assert.equal(order.status, "confirmed");
  assert.ok(order.items[0].deliveredAt);
  assert.equal(order.items[1].deliveredAt, null);
  assert.equal(state.statusEvents.length, 0);
  assert.equal(state.events[0].type, "delivered");
});

test("entrega en partes: con el último producto el pedido pasa solo a entregado", async (t) => {
  const { service, state } = setup(t, {
    items: [line(1, { delivered_at: new Date() }), line(2), line(3, { status: "cancelled" })],
  });
  const order = await service.setItemDelivered(OWNER, 7, 2, true, { actor: ACTOR });
  assert.equal(order.status, "delivered", "lo quitado no cuenta como pendiente");
  assert.deepEqual(state.statusEvents, [{ from: "confirmed", to: "delivered" }]);
});

test("entrega en partes: se puede deshacer y repetir no duplica el registro", async (t) => {
  const { service, state } = setup(t, { items: [line(1), line(2)] });
  await service.setItemDelivered(OWNER, 7, 1, true, { actor: ACTOR });
  await service.setItemDelivered(OWNER, 7, 1, true, { actor: ACTOR });
  assert.equal(state.events.length, 1);
  const order = await service.setItemDelivered(OWNER, 7, 1, false, { actor: ACTOR });
  assert.equal(order.items[0].deliveredAt, null);
  assert.deepEqual(state.events.map((e) => e.type), ["delivered", "undelivered"]);
});

test("entrega en partes: no aplica a delivery, a pedidos sin confirmar ni a productos quitados", async (t) => {
  const delivery = setup(t, { order: baseOrder({ service_type: "delivery" }), items: [line(1), line(2)] });
  await assert.rejects(delivery.service.setItemDelivered(OWNER, 7, 1, true), (e) => e.code === "DELIVERY_NOT_PARTIAL");
  const pending = setup(t, { order: baseOrder({ status: "pending" }), items: [line(1), line(2)] });
  await assert.rejects(pending.service.setItemDelivered(OWNER, 7, 1, true), (e) => e.status === 409 && e.code === "ORDER_NOT_ACTIVE");
  const removed = setup(t, { items: [line(1), line(2, { status: "cancelled" })] });
  await assert.rejects(removed.service.setItemDelivered(OWNER, 7, 2, true), (e) => e.code === "ITEM_REMOVED");
  await assert.rejects(removed.service.setItemDelivered(OWNER, 7, 1, "si"), (e) => e.status === 400);
});

test("DTO: sin la migración (sin columna status) todas las líneas siguen activas", async () => {
  const { withItems } = require("../src/orders/services/orderDTO");
  const old = line(1);
  delete old.status;
  delete old.delivered_at;
  const runner = { query: async () => ({ rows: [old] }) };
  const [order] = await withItems([baseOrder()], runner);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].deliveredAt, null);
  assert.deepEqual(order.removedItems, []);
  assert.equal(order.refundDue, 0);
});

test("pantalla del sector: los productos quitados van aparte de lo que hay que preparar", async (t) => {
  const sql = require("../src/orders/db/sql");
  t.mock.method(sql, "query", async (text) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT t.*, o.number AS order_number") && q.includes("IN ('new', 'preparing')")) {
      return { rows: [{ id: "50", order_id: "7", sector_id: "1", sector_name: "Cocina", status: "new", order_number: 3, order_status: "confirmed" }] };
    }
    if (q.startsWith("SELECT ticket_id, title")) {
      return {
        rows: [
          { ticket_id: "50", title: "Milanesa", option_name: null, quantity: 1, notes: null, line_status: "active" },
          { ticket_id: "50", title: "Papas", option_name: null, quantity: 2, notes: null, line_status: "cancelled" },
          { ticket_id: "50", title: "Flan", option_name: null, quantity: 1, notes: null, line_status: null },
        ],
      };
    }
    return { rows: [] };
  });
  const path = require.resolve("../src/orders/services/ticketService");
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  const { tickets } = await require(path).listSectorTickets(OWNER, 1);
  assert.deepEqual(tickets[0].items.map((i) => i.title), ["Milanesa", "Flan"]);
  assert.deepEqual(tickets[0].removedItems, [{ title: "Papas", option: null, quantity: 2, notes: null }]);
});

test("seguimiento del cliente: informa qué se quitó y el total actualizado, sin datos de más", async (t) => {
  const sql = require("../src/orders/db/sql");
  const row = {
    status: "APPROVED", expires_at: new Date(), amount: "6000.00", order_number: 12, order_status: "confirmed", order_total: "1000.00",
    draft: { serviceType: "delivery", customer: { phone: "1122334455" } },
    removed_items: [{ title: "Pizza", option: "Grande", quantity: 2 }],
  };
  let current = row;
  t.mock.method(sql, "query", async () => ({ rows: [current] }));
  const path = require.resolve("../src/orders/payments/checkoutService");
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  const checkout = require(path);
  const owner = { _id: "owner-1" };

  const dto = await checkout.getCheckoutStatus({ owner, ref: "a".repeat(48) });
  assert.deepEqual(dto.removedItems, [{ title: "Pizza", option: "Grande", quantity: 2 }]);
  assert.equal(dto.orderTotal, 1000);
  assert.equal(dto.total, 6000, "lo que pagó no cambia");
  assert.ok(!JSON.stringify(dto).includes("1122334455"));

  current = { ...row, removed_items: null };
  const clean = await checkout.getCheckoutStatus({ owner, ref: "a".repeat(48) });
  assert.equal("removedItems" in clean, false);
  assert.equal("orderTotal" in clean, false);
});

test("migración 008: aditiva e idempotente", () => {
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "..", "src", "orders", "db", "migrations", "008_manejo_pedidos.sql");
  const sql = fs.readFileSync(file, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS delivered_at timestamptz/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS order_item_events/);
  assert.doesNotMatch(sql, /\bDROP (TABLE|COLUMN)\b|\bDELETE FROM\b|\bRENAME\b/i);
});
