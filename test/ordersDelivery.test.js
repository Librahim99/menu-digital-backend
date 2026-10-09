const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-delivery-codes-0123456789";

// ── Código de entrega ─────────────────────────────────────────────────────
const secrets = require("../src/orders/delivery/secrets");

test("código: 6 dígitos, con ceros a la izquierda y distribuidos", () => {
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    const code = secrets.generateCode();
    assert.match(code, /^\d{6}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 250, "no se repite como un contador fijo");
});

test("código: se guarda hasheado y cifrado, nunca en claro", () => {
  const code = "042517";
  const hash = secrets.hashCode(10, code);
  const encrypted = secrets.encryptCode(10, code);
  assert.ok(!hash.includes(code) && !encrypted.includes(code));
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(secrets.decryptCode(10, encrypted), code);
  // El cifrado está atado al pedido: la copia de otro pedido no se descifra.
  assert.equal(secrets.decryptCode(11, encrypted), null);
  assert.equal(secrets.decryptCode(10, "basura"), null);
});

test("código: verificación correcta, incorrecta y atada al pedido", () => {
  const hash = secrets.hashCode(7, "123456");
  assert.equal(secrets.codeMatches(7, "123456", hash), true);
  assert.equal(secrets.codeMatches(7, "123457", hash), false);
  assert.equal(secrets.codeMatches(8, "123456", hash), false, "el mismo código en otro pedido no sirve");
  assert.equal(secrets.codeMatches(7, "123456", null), false);
  assert.equal(secrets.codeMatches(7, "123456", "zz"), false);
});

test("código: lo tipeado se normaliza y lo inválido se rechaza", () => {
  assert.equal(secrets.normalizeCode("123 456"), "123456");
  assert.equal(secrets.normalizeCode("123-456"), "123456");
  assert.equal(secrets.normalizeCode(" 000001 "), "000001");
  for (const bad of ["12345", "1234567", "abcdef", "", null, undefined, {}, "12 34 5a"]) {
    assert.equal(secrets.normalizeCode(bad), null, String(bad));
  }
});

// ── Base en memoria para los servicios ────────────────────────────────────
// Reproduce solo las consultas que hace el módulo; cada una se reconoce por su
// SQL normalizado. Permite probar las reglas de negocio sin una base real.
const makeDb = ({ orders = [], couriers = [] } = {}) => {
  const state = {
    orders: orders.map((order) => ({ ...order })),
    couriers: couriers.map((courier) => ({ ...courier })),
    assignments: [],
    events: [],
    nextId: 100,
  };
  const copy = (row) => (row ? { ...row } : row);
  const activeFor = (orderId) => state.assignments.find((a) => String(a.order_id) === String(orderId) && ["assigned", "picked_up"].includes(a.status));
  const byId = (id) => state.assignments.find((a) => String(a.id) === String(id));

  const run = async (text, params = []) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT * FROM orders WHERE owner_id = $1 AND id = $2 FOR UPDATE")) {
      return { rows: state.orders.filter((o) => o.owner_id === params[0] && String(o.id) === String(params[1])) };
    }
    if (q.startsWith("SELECT * FROM couriers WHERE owner_id = $1 AND id = $2")) {
      const mustBeActive = q.includes("AND active AND");
      return {
        rows: state.couriers.filter((c) => c.owner_id === params[0] && String(c.id) === String(params[1])
          && !c.deleted_at && (!mustBeActive || c.active)),
      };
    }
    if (q.startsWith("SELECT * FROM delivery_assignments WHERE order_id = $1 AND status = ANY($2)")) {
      const a = activeFor(params[0]);
      return { rows: a ? [copy(a)] : [] };
    }
    if (q.startsWith("SELECT * FROM delivery_assignments WHERE order_id = $1 AND courier_id = $2 AND owner_id = $3")) {
      const a = activeFor(params[0]);
      return { rows: a && String(a.courier_id) === String(params[1]) && a.owner_id === params[2] ? [copy(a)] : [] };
    }
    if (q.startsWith("SELECT * FROM delivery_assignments WHERE order_id = $1 AND courier_id = $2 AND status = 'delivered'")) {
      const rows = state.assignments.filter((a) => String(a.order_id) === String(params[0])
        && String(a.courier_id) === String(params[1]) && a.status === "delivered");
      return { rows: rows.slice(-1).map(copy) };
    }
    if (q.startsWith("INSERT INTO delivery_assignments")) {
      // Índice único parcial: una sola asignación activa por pedido.
      if (activeFor(params[1])) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      const row = {
        id: (state.nextId += 1), owner_id: params[0], order_id: params[1], courier_id: params[2], courier_name: params[3],
        status: params[4], assigned_via: params[5], assigned_by: params[6], assigned_at: new Date(), picked_up_at: params[7],
        delivered_at: null, released_at: null, release_reason: null, code_hash: params[8], code_encrypted: params[9],
        code_issued_at: params[10], code_used_at: null, code_failed_attempts: 0, code_locked_until: null, delivered_by: null,
      };
      state.assignments.push(row);
      return { rows: [copy(row)] };
    }
    if (q.startsWith("UPDATE delivery_assignments SET status = 'released'")) {
      Object.assign(byId(params[0]), { status: "released", released_at: new Date(), release_reason: params[1] });
      return { rows: [] };
    }
    if (q.startsWith("UPDATE delivery_assignments SET status = 'picked_up'")) {
      const a = byId(params[0]);
      if (a.status !== "assigned") return { rows: [] };
      Object.assign(a, { status: "picked_up", picked_up_at: new Date(), code_hash: params[1], code_encrypted: params[2], code_issued_at: new Date() });
      return { rows: [copy(a)] };
    }
    if (q.startsWith("UPDATE delivery_assignments SET code_failed_attempts")) {
      const a = byId(params[0]);
      a.code_failed_attempts = params[1];
      if (params[2]) a.code_locked_until = new Date(Date.now() + params[3] * 1000);
      return { rows: [] };
    }
    if (q.startsWith("UPDATE delivery_assignments SET status = 'delivered'")) {
      const a = byId(params[0]);
      if (a.status !== "picked_up") return { rows: [] };
      Object.assign(a, { status: "delivered", delivered_at: new Date(), code_used_at: new Date(), delivered_by: params[1], code_encrypted: null });
      return { rows: [copy(a)] };
    }
    if (q.startsWith("UPDATE orders SET dispatched_at = now()")) {
      state.orders.find((o) => String(o.id) === String(params[0])).dispatched_at = new Date();
      return { rows: [] };
    }
    if (q.startsWith("UPDATE orders SET dispatched_at = NULL")) {
      state.orders.find((o) => String(o.id) === String(params[0])).dispatched_at = null;
      return { rows: [] };
    }
    if (q.startsWith("INSERT INTO delivery_events")) {
      state.events.push({
        orderId: params[1], assignmentId: params[2], type: params[3], actorType: params[4], actorName: params[6],
        from: params[7], to: params[8], reason: params[9],
      });
      return { rows: [] };
    }
    if (q.startsWith("SELECT count(*)::int AS total FROM delivery_assignments WHERE courier_id = $1")) {
      return { rows: [{ total: state.assignments.filter((a) => String(a.courier_id) === String(params[0]) && ["assigned", "picked_up"].includes(a.status)).length }] };
    }
    if (q.startsWith("SELECT a.*, o.number AS order_number FROM delivery_assignments a") && q.includes("a.owner_id = $1")) {
      const rows = state.assignments
        .filter((a) => a.owner_id === params[0] && a.status === "assigned")
        .map((a) => ({ ...a, order_number: state.orders.find((o) => String(o.id) === String(a.order_id)).number }));
      return { rows };
    }
    if (q.startsWith("SELECT a.*, o.number AS order_number FROM delivery_assignments a")) {
      const rows = state.assignments
        .filter((a) => String(a.courier_id) === String(params[0]) && ["assigned", "picked_up"].includes(a.status))
        .map((a) => ({ ...a, order_number: state.orders.find((o) => String(o.id) === String(a.order_id)).number }));
      return { rows };
    }
    throw new Error(`Consulta no prevista en el test: ${q}`);
  };
  return { state, run };
};

const baseOrder = (overrides = {}) => ({
  id: 1, owner_id: "o1", number: 5, status: "ready", service_type: "delivery", delivery_address: "Calle 123", dispatched_at: null, ...overrides,
});
const baseCourier = (overrides = {}) => ({
  id: 10, owner_id: "o1", name: "Ana", active: true, available: true, deleted_at: null, ...overrides,
});
const session = (courierId = 10, name = "Ana", extra = {}) => ({ ownerId: "o1", courierId, name, available: true, ...extra });
const settingsRow = (options = {}) => ({ owner_id: "o1", options: { deliveryEnabled: true, deliveryAssignMode: "open", ...options } });

// Carga deliveryService con una base falsa y registra los avisos de tiempo real.
const load = (t, data) => {
  const sql = require("../src/orders/db/sql");
  const db = makeDb(data);
  t.mock.method(sql, "query", db.run);
  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: db.run }));

  const realtime = require("../src/orders/delivery/realtime");
  const emitted = [];
  t.mock.method(realtime, "emit", (event) => { emitted.push(event); });

  const orderService = require("../src/orders/services/orderService");
  const statusChanges = [];
  t.mock.method(orderService, "applyStatusChange", async (client, ownerId, order, status, extra) => {
    statusChanges.push({ orderId: order.id, status, actor: extra?.actor, reason: extra?.reason });
    order.status = status;
    return { ...order, status };
  });

  const paths = ["delivery/deliveryService", "delivery/courierService"].map((p) => require.resolve(`../src/orders/${p}`));
  for (const p of paths) delete require.cache[p];
  t.after(() => { for (const p of paths) delete require.cache[p]; });
  const service = require(paths[0]);
  const courierService = require(paths[1]);
  return { ...db, service, courierService, emitted, statusChanges };
};

const rejects = (promise, status, code) =>
  assert.rejects(promise, (error) => error.status === status && (code === undefined || error.code === code), `${status} ${code ?? ""}`);

// ── Asignación abierta ────────────────────────────────────────────────────
test("abierta: dos repartidores toman el mismo pedido, solo uno lo consigue", async (t) => {
  const { service, state } = load(t, {
    orders: [baseOrder({ status: "confirmed" })],
    couriers: [baseCourier(), baseCourier({ id: 11, name: "Beto" })],
  });
  const settings = settingsRow();
  const results = await Promise.allSettled([
    service.claimOrder(session(10), 1, { settings }),
    service.claimOrder(session(11, "Beto"), 1, { settings }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const lost = results.find((r) => r.status === "rejected");
  assert.equal(lost.reason.code, "ALREADY_TAKEN");
  assert.equal(state.assignments.filter((a) => ["assigned", "picked_up"].includes(a.status)).length, 1);
});

test("abierta: reintentar el mismo repartidor no duplica la asignación", async (t) => {
  const { service, state } = load(t, { orders: [baseOrder()], couriers: [baseCourier()] });
  await service.claimOrder(session(), 1, { settings: settingsRow() });
  await service.claimOrder(session(), 1, { settings: settingsRow() });
  assert.equal(state.assignments.length, 1);
  assert.equal(state.events.filter((e) => e.type === "assigned").length, 1);
});

test("abierta: vinculado no es disponible, y en modo manual no se puede tomar", async (t) => {
  const { service } = load(t, { orders: [baseOrder()], couriers: [baseCourier({ available: false })] });
  await rejects(service.claimOrder(session(), 1, { settings: settingsRow() }), 409, "COURIER_UNAVAILABLE");
  await rejects(service.claimOrder(session(), 1, { settings: settingsRow({ deliveryAssignMode: "manual" }) }), 409, "OPEN_MODE_OFF");
  await rejects(service.claimOrder(session(), 1, { settings: settingsRow({ deliveryEnabled: false }) }), 409, "DELIVERY_DISABLED");
});

test("solo entran pedidos de delivery del propio local y no cancelados ni sin confirmar", async (t) => {
  const { service } = load(t, {
    orders: [baseOrder({ id: 1, service_type: "takeaway" }), baseOrder({ id: 2, status: "pending" }), baseOrder({ id: 3, owner_id: "otro" })],
    couriers: [baseCourier()],
  });
  await rejects(service.claimOrder(session(), 1, { settings: settingsRow() }), 409, "NOT_DELIVERY");
  await rejects(service.claimOrder(session(), 2, { settings: settingsRow() }), 409, "NOT_ASSIGNABLE");
  await rejects(service.claimOrder(session(), 3, { settings: settingsRow() }), 404);
});

// ── Asignación manual y reasignación ──────────────────────────────────────
test("manual: el administrador asigna y queda auditado", async (t) => {
  const { service, state, emitted } = load(t, { orders: [baseOrder({ status: "confirmed" })], couriers: [baseCourier()] });
  const settings = settingsRow({ deliveryAssignMode: "manual" });
  const assignment = await service.assignOrder("o1", 1, { courierId: 10, settings });
  assert.equal(assignment.status, "assigned");
  assert.deepEqual(state.events.map((e) => e.type), ["assigned"]);
  assert.equal(state.events[0].actorType, "panel");
  assert.ok(emitted.some((e) => e.event === "assigned" && e.courierIds.includes(10)));
  // Repetir la misma asignación es idempotente.
  await service.assignOrder("o1", 1, { courierId: 10, settings });
  assert.equal(state.assignments.length, 1);
});

test("manual: no se asigna a un repartidor no disponible salvo que se fuerce", async (t) => {
  const { service } = load(t, { orders: [baseOrder()], couriers: [baseCourier({ available: false })] });
  const settings = settingsRow();
  await rejects(service.assignOrder("o1", 1, { courierId: 10, settings }), 409, "COURIER_UNAVAILABLE");
  const forced = await service.assignOrder("o1", 1, { courierId: 10, force: true, settings });
  assert.equal(forced.status, "assigned");
});

test("reasignar conserva el historial y deja una sola asignación activa", async (t) => {
  const { service, state } = load(t, { orders: [baseOrder()], couriers: [baseCourier(), baseCourier({ id: 11, name: "Beto" })] });
  const settings = settingsRow();
  await service.assignOrder("o1", 1, { courierId: 10, settings });
  await service.assignOrder("o1", 1, { courierId: 11, settings });
  assert.equal(state.assignments.length, 2);
  assert.deepEqual(state.assignments.map((a) => a.status), ["released", "assigned"]);
  assert.equal(state.assignments[0].release_reason, "reassigned");
  const event = state.events.find((e) => e.type === "reassigned");
  assert.equal(event.from, 10);
  assert.equal(event.to, 11);
});

test("reasignar un pedido que ya salió exige motivo y conserva el código", async (t) => {
  const { service, state } = load(t, { orders: [baseOrder()], couriers: [baseCourier(), baseCourier({ id: 11, name: "Beto" })] });
  const settings = settingsRow();
  await service.assignOrder("o1", 1, { courierId: 10, settings });
  await service.pickupOrder(session(), 1, { settings });
  const hash = state.assignments[0].code_hash;
  await rejects(service.assignOrder("o1", 1, { courierId: 11, settings }), 400, "REASON_REQUIRED");
  await service.assignOrder("o1", 1, { courierId: 11, reason: "Se le pinchó la moto", settings });
  const current = state.assignments.find((a) => a.status === "picked_up");
  assert.equal(current.courier_id, 11);
  assert.equal(current.code_hash, hash, "el código es del pedido, no del repartidor");
  assert.equal(state.events.at(-1).reason, "Se le pinchó la moto");
});

// ── Retiro ────────────────────────────────────────────────────────────────
test("retirar: un pedido en preparación no se puede retirar", async (t) => {
  const { service, state } = load(t, { orders: [baseOrder({ status: "confirmed" })], couriers: [baseCourier()] });
  const settings = settingsRow({ deliveryAssignMode: "manual" });
  await service.assignOrder("o1", 1, { courierId: 10, settings });
  await rejects(service.pickupOrder(session(), 1, { settings }), 409, "NOT_READY");
  assert.equal(state.assignments[0].status, "assigned");
  assert.equal(state.assignments[0].code_hash, null);
});

test("retirar: solo el repartidor asignado, y de su propio local", async (t) => {
  const { service } = load(t, { orders: [baseOrder()], couriers: [baseCourier(), baseCourier({ id: 11, name: "Beto" })] });
  const settings = settingsRow();
  await service.assignOrder("o1", 1, { courierId: 10, settings });
  await rejects(service.pickupOrder(session(11, "Beto"), 1, { settings }), 404, "NOT_YOUR_ORDER");
  await rejects(service.pickupOrder({ ...session(), ownerId: "otro" }, 1, { settings }), 404);
});

test("retirar: genera el código una sola vez, hasheado, y registra la salida", async (t) => {
  const { service, state, emitted } = load(t, { orders: [baseOrder()], couriers: [baseCourier()] });
  const settings = settingsRow();
  await service.assignOrder("o1", 1, { courierId: 10, settings });
  const first = await service.pickupOrder(session(), 1, { settings });
  assert.equal(first.repeated, false);
  const a = state.assignments[0];
  assert.equal(a.status, "picked_up");
  assert.match(a.code_hash, /^[a-f0-9]{64}$/);
  const plain = secrets.decryptCode(1, a.code_encrypted);
  assert.match(plain, /^\d{6}$/);
  assert.ok(!JSON.stringify(a).includes(plain), "el código en claro no está guardado en ningún campo");
  assert.ok(state.orders[0].dispatched_at, "la salida queda registrada");
  assert.ok(emitted.some((e) => e.event === "picked_up" && e.customer === true));

  // Reintento (doble toque, mala conexión): no cambia el código.
  const second = await service.pickupOrder(session(), 1, { settings });
  assert.equal(second.repeated, true);
  assert.equal(state.assignments[0].code_hash, a.code_hash);
  assert.equal(state.events.filter((e) => e.type === "picked_up").length, 1);
});

// ── Entrega con código ────────────────────────────────────────────────────
const pickedUp = async (t, options = {}) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier(), baseCourier({ id: 11, name: "Beto" })] });
  const settings = settingsRow(options);
  await ctx.service.assignOrder("o1", 1, { courierId: 10, settings });
  await ctx.service.pickupOrder(session(), 1, { settings });
  ctx.code = secrets.decryptCode(1, ctx.state.assignments[0].code_encrypted);
  ctx.settings = settings;
  return ctx;
};

test("entregar: con el código correcto el pedido pasa a entregado y el código queda inutilizado", async (t) => {
  const ctx = await pickedUp(t);
  const result = await ctx.service.confirmDelivery(session(), 1, ctx.code);
  assert.equal(result.delivered, true);
  const a = ctx.state.assignments[0];
  assert.equal(a.status, "delivered");
  assert.ok(a.delivered_at && a.code_used_at);
  assert.equal(a.code_encrypted, null, "el cliente deja de ver el código");
  assert.deepEqual(ctx.statusChanges, [{ orderId: 1, status: "delivered", actor: { type: "courier", id: 10, name: "Ana" }, reason: null }]);
  assert.ok(ctx.emitted.some((e) => e.event === "delivered" && e.customer === true));
});

test("entregar: un código ya usado no sirve de nuevo y un reintento no duplica la entrega", async (t) => {
  const ctx = await pickedUp(t);
  await ctx.service.confirmDelivery(session(), 1, ctx.code);
  const retry = await ctx.service.confirmDelivery(session(), 1, ctx.code);
  assert.equal(retry.repeated, true);
  assert.equal(ctx.statusChanges.length, 1, "el pedido se entrega una sola vez");
  assert.equal(ctx.emitted.filter((e) => e.event === "delivered").length, 1);
  // Otro repartidor no puede reutilizarlo.
  await rejects(ctx.service.confirmDelivery(session(11, "Beto"), 1, ctx.code), 404, "NOT_YOUR_ORDER");
});

test("entregar: código incorrecto no entrega, no revela nada y cuenta el intento", async (t) => {
  const ctx = await pickedUp(t);
  const wrong = ctx.code === "000000" ? "000001" : "000000";
  await assert.rejects(ctx.service.confirmDelivery(session(), 1, wrong), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "CODE_INVALID");
    assert.ok(!error.message.includes(wrong) && !error.message.includes(ctx.code));
    return true;
  });
  assert.equal(ctx.state.assignments[0].code_failed_attempts, 1);
  assert.equal(ctx.state.assignments[0].status, "picked_up");
  assert.equal(ctx.statusChanges.length, 0);
});

test("entregar: 5 errores bloquean el código, incluso el correcto, hasta que pasa el bloqueo", async (t) => {
  const ctx = await pickedUp(t);
  const wrong = ctx.code === "111111" ? "222222" : "111111";
  for (let i = 0; i < 4; i += 1) await rejects(ctx.service.confirmDelivery(session(), 1, wrong), 400, "CODE_INVALID");
  await rejects(ctx.service.confirmDelivery(session(), 1, wrong), 429, "CODE_LOCKED");
  await rejects(ctx.service.confirmDelivery(session(), 1, ctx.code), 429, "CODE_LOCKED");
  assert.equal(ctx.statusChanges.length, 0);
  assert.ok(ctx.state.events.some((e) => e.type === "code_locked"));
  // Vencido el bloqueo, el código correcto vuelve a funcionar.
  ctx.state.assignments[0].code_locked_until = new Date(Date.now() - 1000);
  assert.equal((await ctx.service.confirmDelivery(session(), 1, ctx.code)).delivered, true);
});

test("entregar: formato inválido, sin retirar o de otro repartidor se rechaza", async (t) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier()] });
  const settings = settingsRow();
  await rejects(ctx.service.confirmDelivery(session(), 1, "12"), 400, "CODE_FORMAT");
  await ctx.service.assignOrder("o1", 1, { courierId: 10, settings });
  await rejects(ctx.service.confirmDelivery(session(), 1, "123456"), 409, "NOT_PICKED_UP");
});

test("entregar sigue funcionando con Delivery apagado si el pedido ya estaba en la calle", async (t) => {
  const ctx = await pickedUp(t);
  ctx.state.orders[0].status = "ready";
  const off = settingsRow({ deliveryEnabled: false });
  void off;
  assert.equal((await ctx.service.confirmDelivery(session(), 1, ctx.code)).delivered, true);
});

// ── Entrega por el administrador ──────────────────────────────────────────
test("admin: con 'solo el repartidor' no puede entregar, salvo la excepción con motivo", async (t) => {
  const ctx = await pickedUp(t);
  await rejects(ctx.service.adminDeliver("o1", 1, { reason: "x".repeat(10), settings: ctx.settings }), 403, "ADMIN_DELIVERY_NOT_ALLOWED");

  const override = settingsRow({ deliveryAdminOverride: true });
  await rejects(ctx.service.adminDeliver("o1", 1, { reason: "", settings: override }), 400, "REASON_REQUIRED");
  await rejects(ctx.service.adminDeliver("o1", 1, { reason: "ok", settings: override }), 400, "REASON_REQUIRED");
  await ctx.service.adminDeliver("o1", 1, { reason: "El cliente no tenía batería", settings: override });
  const event = ctx.state.events.find((e) => e.type === "admin_delivered");
  assert.equal(event.reason, "El cliente no tenía batería");
  assert.equal(event.actorType, "panel");
  assert.equal(ctx.state.assignments[0].delivered_by, "admin");
});

test("admin: con 'repartidor y administrador' puede entregar y igual queda registrado", async (t) => {
  const ctx = await pickedUp(t, { deliveryConfirmBy: "courier_admin" });
  await ctx.service.adminDeliver("o1", 1, { reason: null, settings: ctx.settings });
  assert.equal(ctx.state.assignments[0].status, "delivered");
  assert.ok(ctx.state.events.some((e) => e.type === "admin_delivered"));
});

test("admin: con Delivery apagado resuelve lo que quedó en la calle, con motivo", async (t) => {
  const ctx = await pickedUp(t);
  const off = settingsRow({ deliveryEnabled: false });
  await rejects(ctx.service.adminDeliver("o1", 1, { reason: null, settings: off }), 400, "REASON_REQUIRED");
  await ctx.service.adminDeliver("o1", 1, { reason: "Se apagó Delivery", settings: off });
  assert.equal(ctx.state.assignments[0].status, "delivered");
});

test("admin: sin retirar no se puede marcar entregado", async (t) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier()] });
  const settings = settingsRow({ deliveryConfirmBy: "courier_admin" });
  await ctx.service.assignOrder("o1", 1, { courierId: 10, settings });
  await rejects(ctx.service.adminDeliver("o1", 1, { reason: "x", settings }), 409, "NOT_PICKED_UP");
});

// ── Guardas del panel general ─────────────────────────────────────────────
test("el panel general no entrega un pedido que está con un repartidor", async (t) => {
  const ctx = await pickedUp(t);
  await rejects(ctx.service.guardStatusChange(ctx.run ? { query: ctx.run } : null, "o1", ctx.state.orders[0], "delivered"), 409, "DELIVERY_REQUIRES_COURIER");
  await rejects(ctx.service.guardStatusChange({ query: ctx.run }, "o1", ctx.state.orders[0], "confirmed"), 409, "DELIVERY_IN_TRANSIT");
});

test("anular un pedido libera al repartidor, lo saca de 'en camino' y lo audita", async (t) => {
  const ctx = await pickedUp(t);
  const events = await ctx.service.guardStatusChange({ query: ctx.run }, "o1", ctx.state.orders[0], "cancelled");
  assert.equal(ctx.state.assignments[0].status, "released");
  assert.equal(ctx.state.assignments[0].release_reason, "order_cancelled");
  assert.equal(ctx.state.orders[0].dispatched_at, null);
  assert.equal(events[0].event, "released");
  assert.deepEqual(events[0].courierIds, [10]);
});

test("sin repartidor asignado el panel general sigue igual que siempre", async (t) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier()] });
  assert.deepEqual(await ctx.service.guardStatusChange({ query: ctx.run }, "o1", ctx.state.orders[0], "delivered"), []);
  await ctx.service.assertNoCourierAssigned({ query: ctx.run }, 1);
});

test("marcar 'salió' a mano se rechaza si hay repartidor asignado", async (t) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier()] });
  await ctx.service.assignOrder("o1", 1, { courierId: 10, settings: settingsRow() });
  await rejects(ctx.service.assertNoCourierAssigned({ query: ctx.run }, 1), 409, "DELIVERY_ASSIGNED");
});

// ── Desactivar repartidores ───────────────────────────────────────────────
test("no se desactiva a un repartidor con entregas sin resolver", async (t) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier(), baseCourier({ id: 11, name: "Beto" })] });
  await ctx.service.assignOrder("o1", 1, { courierId: 10, settings: settingsRow() });
  const sql = require("../src/orders/db/sql");
  const original = sql.query;
  void original;
  // courierService.updateCourier lee el repartidor con query y escribe con client.query.
  await rejects(ctx.courierService.updateCourier("o1", 10, { active: false }), 409, "COURIER_HAS_ACTIVE_DELIVERIES");
  await rejects(ctx.courierService.deleteCourier("o1", 10), 409, "COURIER_HAS_ACTIVE_DELIVERIES");
  assert.equal(ctx.state.assignments[0].status, "assigned");
});

test("desactivar con reassignTo pasa las entregas a otro repartidor sin perder el historial", async (t) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier(), baseCourier({ id: 11, name: "Beto" })] });
  const settings = settingsRow();
  await ctx.service.assignOrder("o1", 1, { courierId: 10, settings });
  await ctx.service.pickupOrder(session(), 1, { settings });
  const hash = ctx.state.assignments[0].code_hash;
  const moved = await ctx.service.reassignAll({ query: ctx.run }, "o1", { fromCourier: ctx.state.couriers[0], toCourierId: 11 });
  assert.equal(moved.length, 1);
  assert.deepEqual(ctx.state.assignments.map((a) => a.status), ["released", "picked_up"]);
  assert.equal(ctx.state.assignments[1].courier_id, 11);
  assert.equal(ctx.state.assignments[1].code_hash, hash);
  await rejects(ctx.service.reassignAll({ query: ctx.run }, "o1", { fromCourier: ctx.state.couriers[0], toCourierId: 10 }), 400);
});

// ── Mensajes y vinculación ────────────────────────────────────────────────
test("el repartidor no ve datos de pago ni del destinatario de pedidos que no son suyos", async (t) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier()] });
  const sql = require("../src/orders/db/sql");
  const order = { ...baseOrder(), customer_name: "Juan", customer_phone: "1122", total: "5000", payment_status: "APPROVED", notes: "n" };
  sql.query.mock.mockImplementation(async (text) => {
    const q = text.replace(/\s+/g, " ");
    if (q.includes("FROM delivery_assignments a JOIN orders o") && q.includes("status = ANY")) {
      return { rows: [{ id: 1, order_id: 1, courier_id: 10, status: "assigned", assigned_at: new Date(), order_row: order }] };
    }
    if (q.includes("FROM orders o") && q.includes("NOT EXISTS")) return { rows: [{ ...order, id: 2 }] };
    if (q.includes("FROM order_items")) return { rows: [{ order_id: 1, title: "Pizza", option_name: null, quantity: 2, notes: null }, { order_id: 2, title: "Pizza", option_name: null, quantity: 1, notes: null }] };
    return { rows: [] };
  });
  const panel = await ctx.service.courierPanel(session(), { settings: settingsRow() });
  const serialized = JSON.stringify(panel);
  assert.ok(!serialized.includes("5000") && !serialized.includes("APPROVED") && !serialized.includes("payment"));
  assert.equal(panel.assigned[0].customerName, "Juan", "del propio pedido sí");
  assert.equal(panel.open[0].customerName, undefined, "de un pedido disponible no");
  assert.equal(panel.open[0].customerPhone, undefined);
  assert.equal(panel.open[0].itemsCount, 1);
});

test("el repartidor no disponible no ve la lista compartida", async (t) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier()] });
  const sql = require("../src/orders/db/sql");
  sql.query.mock.mockImplementation(async (text) => {
    const q = text.replace(/\s+/g, " ");
    if (q.includes("NOT EXISTS")) return { rows: [{ ...baseOrder(), id: 2 }] };
    return { rows: [] };
  });
  const panel = await ctx.service.courierPanel(session(10, "Ana", { available: false }), { settings: settingsRow() });
  assert.deepEqual(panel.open, []);
  assert.equal(panel.openCount, 1);
});

test("vinculación: el código es de un solo uso, vence y solo se guarda su hash", async (t) => {
  const sql = require("../src/orders/db/sql");
  const calls = [];
  const stored = { qr: null, manual: null };
  const run = async (text, params = []) => {
    const q = text.replace(/\s+/g, " ").trim();
    calls.push({ q, params });
    if (q.startsWith("UPDATE couriers SET pairing_code_hash = $2")) { stored.qr = params[1]; stored.manual = params[3]; }
    if (q.startsWith("UPDATE couriers SET pairing_code_hash = NULL")) { stored.qr = null; stored.manual = null; }
    if (q.startsWith("SELECT * FROM couriers WHERE owner_id = $1 AND id = $2")) return { rows: [baseCourier()] };
    if (q.startsWith("SELECT * FROM couriers WHERE pairing_")) {
      const column = q.includes("pairing_manual_hash = $1") ? "manual" : "qr";
      const known = column === "manual" ? stored.manual : stored.qr;
      return { rows: known === params[0] ? [baseCourier({ pairing_code_hash: params[0] })] : [] };
    }
    return { rows: [] };
  };
  t.mock.method(sql, "query", run);
  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: run }));
  const realtime = require("../src/orders/delivery/realtime");
  t.mock.method(realtime, "emit", () => {});
  const p = require.resolve("../src/orders/delivery/courierService");
  delete require.cache[p];
  t.after(() => { delete require.cache[p]; });
  const courierService = require(p);

  const { code, manualCode, expiresAt } = await courierService.issuePairingCode("o1", 10);
  assert.match(manualCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, "código corto para tipear si la cámara no anda");
  assert.ok(code.length >= 24);
  assert.ok(new Date(expiresAt).getTime() - Date.now() <= 2 * 60_000 + 1000, "vence en minutos");
  const stored2 = calls.find((c) => c.q.startsWith("UPDATE couriers SET pairing_code_hash = $2"));
  assert.ok(!JSON.stringify(stored2.params).includes(code), "solo el hash");
  assert.ok(!JSON.stringify(stored2.params).includes(manualCode.replace("-", "")), "el código corto también se guarda hasheado");

  const paired = await courierService.pairDevice(code, { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120" });
  assert.equal(paired.courier.name, "Ana");
  assert.ok(calls.some((c) => c.q.startsWith("UPDATE couriers SET pairing_code_hash = NULL")), "se consume al canjear");
  const insert = calls.find((c) => c.q.startsWith("INSERT INTO courier_sessions"));
  assert.ok(!insert.params.includes(paired.token), "el token de sesión se guarda hasheado");
  assert.ok(calls.find((c) => c.q.includes("pairing_expires_at > now()")), "el canje valida el vencimiento");

  // Con el código corto (minúsculas y sin guion también) se vincula igual, y la invitación se consume.
  const issued = await courierService.issuePairingCode("o1", 10);
  const typed = issued.manualCode.toLowerCase().replace("-", " ");
  const viaManual = await courierService.pairDevice(typed, { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120" });
  assert.equal(viaManual.courier.name, "Ana");
  await rejects(courierService.pairDevice(issued.manualCode, {}), 401, "PAIRING_EXPIRED");
  await rejects(courierService.pairDevice(issued.code, {}), 401, "PAIRING_EXPIRED");

  await rejects(courierService.pairDevice("basura", {}), 400);
  await rejects(courierService.pairDevice("ABCD-EFG0", {}), 400);
  await courierService.revokePairingCode("o1", 10);
  assert.ok(calls.at(-1).q.startsWith("UPDATE couriers SET pairing_code_hash = NULL"), "revocable");
});

// ── Configuración ─────────────────────────────────────────────────────────
test("configuración: valores por defecto y validación de Delivery", async (t) => {
  const sql = require("../src/orders/db/sql");
  const row = { owner_id: "o1", qr_mode: "general", customer_ordering: true, customer_history: true, table_count: 5, period_mode: "shift", shift_schedule: [], options: {} };
  const saved = [];
  const run = async (text, params) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT * FROM order_settings")) return { rows: [row] };
    if (q.startsWith("UPDATE order_settings")) { saved.push(JSON.parse(params[7])); return { rows: [{ ...row, options: JSON.parse(params[7]) }] }; }
    return { rows: [] };
  };
  t.mock.method(sql, "query", run);
  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: run }));
  const p = require.resolve("../src/orders/services/settingsService");
  delete require.cache[p];
  t.after(() => { delete require.cache[p]; });
  const settings = require(p);

  assert.deepEqual(
    (({ deliveryEnabled, deliveryAssignMode, deliveryConfirmBy, deliveryAdminOverride }) => ({ deliveryEnabled, deliveryAssignMode, deliveryConfirmBy, deliveryAdminOverride }))(settings.optionsOf(row)),
    { deliveryEnabled: false, deliveryAssignMode: "manual", deliveryConfirmBy: "courier", deliveryAdminOverride: false },
    "apagado por defecto: el flujo existente no cambia",
  );
  await settings.updateSettings("o1", { options: { deliveryEnabled: true, deliveryAssignMode: "open", deliveryConfirmBy: "courier_admin", deliveryAdminOverride: true } });
  assert.equal(saved[0].deliveryAssignMode, "open");
  for (const options of [{ deliveryAssignMode: "otro" }, { deliveryConfirmBy: "cualquiera" }, { deliveryEnabled: "si" }, { deliveryAdminOverride: 1 }]) {
    await rejects(settings.updateSettings("o1", { options }), 400);
  }
  assert.equal(saved.length, 1);
});

test("apagar Delivery libera lo no retirado y deja seguir lo que ya salió", async (t) => {
  const ctx = load(t, {
    orders: [baseOrder({ id: 1 }), baseOrder({ id: 2, number: 6 })],
    couriers: [baseCourier()],
  });
  const settings = settingsRow();
  await ctx.service.assignOrder("o1", 1, { courierId: 10, settings });
  await ctx.service.assignOrder("o1", 2, { courierId: 10, settings });
  await ctx.service.pickupOrder(session(), 1, { settings });
  const released = await ctx.service.releasePendingOnDisable("o1");
  assert.equal(released, 1);
  assert.deepEqual(ctx.state.assignments.map((a) => a.status), ["picked_up", "released"]);
  assert.equal(ctx.state.assignments[1].release_reason, "delivery_disabled");
});

// ── Seguimiento del cliente ───────────────────────────────────────────────
test("seguimiento: el cliente ve el código solo mientras el pedido está en camino", async (t) => {
  const ctx = load(t, { orders: [baseOrder()], couriers: [baseCourier()] });
  const sql = require("../src/orders/db/sql");
  const encrypted = secrets.encryptCode(1, "654321");
  let row = { status: "picked_up", picked_up_at: new Date(), delivered_at: null, courier_name: "Ana", code_encrypted: encrypted, order_id: 1 };
  sql.query.mock.mockImplementation(async () => ({ rows: [row] }));
  const ref = "a".repeat(48);
  const onTheWay = await ctx.service.customerDelivery("o1", ref, { settings: settingsRow() });
  assert.equal(onTheWay.code, "654321");
  assert.equal(onTheWay.tracked, true);

  row = { ...row, status: "delivered", delivered_at: new Date(), code_encrypted: null };
  const delivered = await ctx.service.customerDelivery("o1", ref, { settings: settingsRow() });
  assert.equal(delivered.code, null);

  // Con Delivery apagado no se muestra el seguimiento del repartidor, salvo pedidos ya en la calle.
  const off = settingsRow({ deliveryEnabled: false });
  assert.deepEqual(await ctx.service.customerDelivery("o1", ref, { settings: off }), { tracked: false });
  row = { ...row, status: "picked_up", delivered_at: null, code_encrypted: encrypted };
  assert.equal((await ctx.service.customerDelivery("o1", ref, { settings: off })).code, "654321");

  await rejects(ctx.service.customerDelivery("o1", "no-es-una-referencia", { settings: off }), 404);
});

// ── WebSocket ─────────────────────────────────────────────────────────────
const fakeSocket = () => {
  const handlers = {};
  return {
    sent: [], closed: null,
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code) { this.closed = code; },
    on(event, fn) { handlers[event] = fn; },
    receive(message) { return handlers.message(JSON.stringify(message)); },
  };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

const buildHub = () => {
  const { createHub } = require("../src/orders/delivery/realtime");
  return createHub({
    authorizeOwner: async (token) => (token.startsWith("jwt-") ? token.slice(4) : null),
    authorizeCourier: async (token) => {
      const match = /^courier-(\w+)-(\d+)$/.exec(token);
      return match ? { ownerId: match[1], courierId: Number(match[2]) } : null;
    },
    authorizeCustomer: async (slug, ref) => (ref === "good-ref" ? { ownerId: "o1" } : null),
  });
};

test("websocket: cada pantalla recibe solo lo que le corresponde", async () => {
  const realtime = require("../src/orders/delivery/realtime");
  const hub = buildHub();
  realtime.setHubForTests(hub);
  const connect = async (message) => {
    const socket = fakeSocket();
    hub.connect(socket);
    await socket.receive(message);
    await tick();
    return socket;
  };
  const owner = await connect({ type: "auth", token: "jwt-o1" });
  const otherOwner = await connect({ type: "auth", token: "jwt-o2" });
  const ana = await connect({ type: "auth", role: "courier", token: "courier-o1-10" });
  const beto = await connect({ type: "auth", role: "courier", token: "courier-o1-11" });
  const foreignCourier = await connect({ type: "auth", role: "courier", token: "courier-o2-10" });
  const customer = await connect({ type: "watch", slug: "mi-local", ref: "good-ref" });
  const intruder = await connect({ type: "watch", slug: "mi-local", ref: "bad-ref" });

  assert.equal(owner.sent[0].role, "owner");
  assert.equal(ana.sent[0].role, "courier");
  assert.equal(customer.sent[0].role, "customer");
  assert.equal(intruder.sent[0].code, "NOT_FOUND");

  for (const s of [owner, otherOwner, ana, beto, foreignCourier, customer]) s.sent.length = 0;
  realtime.emit({ ownerId: "o1", event: "assigned", orderId: 7, orderNumber: 3, courierIds: [10], openList: true });
  assert.equal(owner.sent[0].event, "assigned");
  assert.equal(ana.sent[0].event, "assigned", "el repartidor asignado");
  assert.equal(ana.sent[1].event, "open_changed");
  assert.equal(beto.sent.length, 1, "otro repartidor del local solo ve que cambió la lista disponible");
  assert.equal(beto.sent[0].event, "open_changed");
  assert.equal(beto.sent[0].orderId, null);
  assert.equal(otherOwner.sent.length, 0, "otro local no recibe nada");
  assert.equal(foreignCourier.sent.length, 0);
  assert.equal(customer.sent.length, 0, "el cliente solo se entera si el aviso es de su pedido");
  realtime.setHubForTests(null);
});

test("websocket: credenciales inválidas cierran la conexión y nada viaja con datos personales", async () => {
  const hub = buildHub();
  const bad = fakeSocket();
  hub.connect(bad);
  await bad.receive({ type: "auth", token: "falso" });
  await tick();
  assert.equal(bad.closed, 1008);
  const badCourier = fakeSocket();
  hub.connect(badCourier);
  await badCourier.receive({ type: "auth", role: "courier", token: "falso" });
  await tick();
  assert.equal(badCourier.closed, 1008);
  const unsupported = fakeSocket();
  hub.connect(unsupported);
  await unsupported.receive({ type: "subscribe", room: "owner:o2" });
  assert.equal(unsupported.sent[0].type, "error", "no se puede suscribir a una sala arbitraria");
});

test("websocket: emitir sin hub o con un hub roto nunca tira", () => {
  const realtime = require("../src/orders/delivery/realtime");
  realtime.setHubForTests(null);
  assert.doesNotThrow(() => realtime.emit({ ownerId: "o1", event: "assigned" }));
  realtime.setHubForTests({ toOwner() { throw new Error("boom"); } });
  assert.doesNotThrow(() => realtime.emit({ ownerId: "o1", event: "assigned" }));
  realtime.setHubForTests(null);
});

// ── Migración ─────────────────────────────────────────────────────────────
test("migración 006: aditiva, con una sola asignación activa por pedido y sin borrados", () => {
  const dir = path.join(__dirname, "..", "src", "orders", "db", "migrations");
  const sql = fs.readFileSync(path.join(dir, "006_delivery_repartidores.sql"), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  for (const table of ["couriers", "courier_sessions", "delivery_assignments", "delivery_events"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS delivery_assignments_one_active[\s\S]*?WHERE status IN \('assigned', 'picked_up'\)/);
  assert.match(sql, /'courier'\)\)/, "el repartidor figura como autor de cambios de estado");
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE TABLE|DELETE FROM/i);
  assert.doesNotMatch(sql, /code_plain|delivery_code\s+(text|char)/i, "no hay columna para el código en claro");
});

test("migración 007: agrega el código corto sin tocar la 006 (ya aplicada) y es idempotente", () => {
  const dir = path.join(__dirname, "..", "src", "orders", "db", "migrations");
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  const m007 = read("007_repartidor_codigo_manual.sql");
  assert.match(m007, /ALTER TABLE couriers ADD COLUMN IF NOT EXISTS pairing_manual_hash text/);
  assert.match(m007, /CREATE INDEX IF NOT EXISTS/);
  assert.doesNotMatch(m007, /DROP|DELETE|TRUNCATE/i);
  assert.doesNotMatch(read("006_delivery_repartidores.sql"), /pairing_manual_hash/, "la 006 queda como se aplicó");
});
