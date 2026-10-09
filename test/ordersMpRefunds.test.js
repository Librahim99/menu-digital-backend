const test = require("node:test");
const assert = require("node:assert/strict");

const OWNER_ID = "owner-1";
const ACTOR = { id: "owner-1", name: "Lucas" };

const basePayment = () => ({
  id: 41, owner_id: OWNER_ID, order_id: 10, connection_id: 9, mp_payment_id: "555",
  amount: "3000.00", refunded_amount: "0.00", status: "APPROVED",
});

// Mini base en memoria para lo que consulta el servicio de devoluciones.
const setup = (t, { payment = basePayment(), connectionMpUser = "777", sellerMpUser = "777" } = {}) => {
  process.env.ORDERS_CREDENTIALS_KEY = "k".repeat(40);
  t.after(() => { delete process.env.ORDERS_CREDENTIALS_KEY; });
  const sql = require("../src/orders/db/sql");
  const state = { payment, refunds: [], orderStatus: null, seq: 0 };

  const run = async (text, params) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT * FROM order_online_payments")) {
      const p = state.payment;
      return { rows: p && p.owner_id === params[0] && p.order_id === params[1] ? [p] : [] };
    }
    if (q.startsWith("SELECT 1 FROM order_refunds WHERE online_payment_id")) {
      return { rows: state.refunds.filter((r) => r.status === "PENDING") };
    }
    if (q.startsWith("INSERT INTO order_refunds")) {
      const refund = {
        id: ++state.seq, owner_id: params[0], order_id: params[1], online_payment_id: params[2], amount: String(params[3]),
        is_partial: params[4], reason: params[5], idempotency_key: params[6], requested_by_id: params[7],
        requested_by_name: params[8], status: "PENDING", failure_detail: null, requested_at: new Date(), completed_at: null,
      };
      state.refunds.push(refund);
      return { rows: [refund] };
    }
    if (q.startsWith("SELECT * FROM order_refunds WHERE owner_id = $1 AND online_payment_id")) {
      return { rows: [...state.refunds].reverse() };
    }
    if (q.startsWith("SELECT * FROM order_refunds WHERE id = $1")) {
      return { rows: state.refunds.filter((r) => r.id === params[0] && r.owner_id === params[1] && r.order_id === params[2]) };
    }
    if (q.startsWith("SELECT * FROM order_refunds WHERE online_payment_id")) return { rows: state.refunds };
    if (q.startsWith("SELECT mp_user_id FROM order_mp_connections")) return { rows: [{ mp_user_id: connectionMpUser }] };
    if (q.startsWith("UPDATE order_refunds SET mp_refund_id")) {
      state.refunds.find((r) => r.id === params[0]).mp_refund_id = params[1];
      return { rows: [] };
    }
    if (q.startsWith("UPDATE order_refunds SET status = 'COMPLETED'")) {
      const r = state.refunds.find((x) => x.id === params[0]);
      if (r && r.status !== "COMPLETED") { r.status = "COMPLETED"; r.completed_at = new Date(); }
      return { rows: [] };
    }
    if (q.startsWith("UPDATE order_refunds SET status = 'FAILED'")) {
      const r = state.refunds.find((x) => x.id === params[0]);
      if (r && r.status === "PENDING") { r.status = "FAILED"; r.failure_detail = params[1]; }
      return { rows: [] };
    }
    if (q.startsWith("UPDATE order_online_payments SET refunded_amount")) {
      state.payment = { ...state.payment, refunded_amount: String(params[1]), status: params[2] };
      return { rows: [] };
    }
    if (q.startsWith("UPDATE orders SET payment_status")) { state.orderPaymentStatus = params[2]; return { rows: [] }; }
    throw new Error(`Consulta no prevista en el test: ${q}`);
  };
  t.mock.method(sql, "query", run);
  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: run }));

  const paths = ["refundService", "connectionService"].map((n) => require.resolve(`../src/orders/payments/${n}`));
  paths.forEach((p) => { delete require.cache[p]; });
  t.after(() => paths.forEach((p) => { delete require.cache[p]; }));
  const service = require(paths[0]);
  const connections = require(paths[1]);
  const mpApi = require("../src/orders/payments/mpApi");
  const orderService = require("../src/orders/services/orderService");

  t.mock.method(connections, "getAccessToken", async () => ({ connectionId: 9, mpUserId: sellerMpUser, liveMode: true, accessToken: "APP_USR-local" }));
  const createRefund = t.mock.method(mpApi, "createRefund", async () => ({ id: "r-1", amount: 3000, status: "approved" }));
  // MP refleja la devolución recién hecha.
  const getPayment = t.mock.method(mpApi, "getPayment", async () => ({
    transaction_amount_refunded: state.refundedOnMp ?? 3000,
    refunds: [{ id: "r-1", status: "approved", amount: 3000 }],
  }));
  const updateStatus = t.mock.method(orderService, "updateStatus", async (...args) => { state.orderStatus = args[2]; return {}; });
  return { service, state, mpApi, createRefund, getPayment, updateStatus };
};

test("devolución total: se pide a MP con el token del local, se confirma y se actualizan pago y pedido", async (t) => {
  const { service, state, createRefund } = setup(t);
  const result = await service.requestRefund({ ownerId: OWNER_ID, orderId: 10, reason: "  Sin stock ", actor: ACTOR });

  assert.equal(result.outcome, "completed");
  const [token, paymentId, amount, key] = createRefund.mock.calls[0].arguments;
  assert.equal(token, "APP_USR-local");
  assert.equal(paymentId, "555");
  assert.equal(amount, null, "devolución total: sin importe");
  assert.match(key, /^[0-9a-f-]{36}$/);

  assert.equal(state.refunds[0].status, "COMPLETED");
  assert.equal(state.refunds[0].requested_by_id, "owner-1");
  assert.equal(state.refunds[0].requested_by_name, "Lucas");
  assert.equal(state.refunds[0].reason, "Sin stock");
  assert.equal(state.payment.status, "REFUNDED");
  assert.equal(state.orderPaymentStatus, "REFUNDED");
  assert.equal(result.payment.canRefund, false);
});

test("devolución parcial: manda el importe y deja el pago PARTIALLY_REFUNDED", async (t) => {
  const { service, state, createRefund } = setup(t);
  state.refundedOnMp = 1000;
  const result = await service.requestRefund({ ownerId: OWNER_ID, orderId: 10, amount: "1000", actor: ACTOR });
  assert.equal(createRefund.mock.calls[0].arguments[2], 1000);
  assert.equal(result.outcome, "completed");
  assert.equal(state.payment.status, "PARTIALLY_REFUNDED");
  assert.equal(result.payment.refundable, 2000);
  assert.equal(result.payment.canRefund, true);
});

test("importe mayor al pendiente de devolver se rechaza sin llamar a MP", async (t) => {
  const { service, createRefund } = setup(t);
  await assert.rejects(service.requestRefund({ ownerId: OWNER_ID, orderId: 10, amount: 3000.01, actor: ACTOR }), (e) => e.status === 400 && e.code === "AMOUNT_EXCEEDS");
  await assert.rejects(service.requestRefund({ ownerId: OWNER_ID, orderId: 10, amount: -5, actor: ACTOR }), (e) => e.status === 400);
  await assert.rejects(service.requestRefund({ ownerId: OWNER_ID, orderId: 10, amount: "abc", actor: ACTOR }), (e) => e.status === 400);
  assert.equal(createRefund.mock.callCount(), 0);
});

test("solo se devuelve un pago aprobado del propio local", async (t) => {
  const pending = setup(t, { payment: { ...basePayment(), status: "PENDING" } });
  await assert.rejects(pending.service.requestRefund({ ownerId: OWNER_ID, orderId: 10, actor: ACTOR }), (e) => e.code === "NOT_REFUNDABLE");

  const other = setup(t);
  await assert.rejects(other.service.requestRefund({ ownerId: "owner-2", orderId: 10, actor: ACTOR }), (e) => e.status === 404);
  assert.equal(other.createRefund.mock.callCount(), 0);

  const done = setup(t, { payment: { ...basePayment(), status: "PARTIALLY_REFUNDED", refunded_amount: "3000.00" } });
  await assert.rejects(done.service.requestRefund({ ownerId: OWNER_ID, orderId: 10, actor: ACTOR }), (e) => e.code === "NOT_REFUNDABLE");
});

test("si la cuenta de MP conectada ya no es la que cobró, no se devuelve", async (t) => {
  const { service, createRefund, state } = setup(t, { connectionMpUser: "777", sellerMpUser: "888" });
  await assert.rejects(service.requestRefund({ ownerId: OWNER_ID, orderId: 10, actor: ACTOR }), (e) => e.code === "MP_ACCOUNT_CHANGED");
  assert.equal(createRefund.mock.callCount(), 0);
  assert.equal(state.refunds[0].status, "PENDING", "queda registrada y reintentable al reconectar la cuenta correcta");
});

test("error definitivo de MP (sin saldo / fuera de plazo): FAILED, sin cancelar el pedido", async (t) => {
  const { service, state, mpApi, createRefund, updateStatus } = setup(t);
  createRefund.mock.mockImplementation(async () => { throw new mpApi.MpApiError(400, "bad_request"); });
  const result = await service.requestRefund({ ownerId: OWNER_ID, orderId: 10, cancelOrder: true, actor: ACTOR });
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /saldo/);
  assert.equal(state.refunds[0].status, "FAILED");
  assert.equal(state.payment.status, "APPROVED", "el pago no cambia");
  assert.equal(updateStatus.mock.callCount(), 0);
  // Falló: se puede pedir otra (ya no hay una en curso).
  createRefund.mock.mockImplementation(async () => ({ id: "r-1", amount: 3000, status: "approved" }));
  assert.equal((await service.requestRefund({ ownerId: OWNER_ID, orderId: 10, actor: ACTOR })).outcome, "completed");
});

test("corte de red o 5xx: queda PENDING (no se marca completa) y se reintenta con la misma clave", async (t) => {
  const { service, state, mpApi, createRefund, updateStatus } = setup(t);
  createRefund.mock.mockImplementation(async () => { throw new mpApi.MpApiError(503, null); });
  const result = await service.requestRefund({ ownerId: OWNER_ID, orderId: 10, cancelOrder: true, actor: ACTOR });
  assert.equal(result.outcome, "pending");
  assert.equal(state.refunds[0].status, "PENDING");
  assert.equal(state.payment.status, "APPROVED");
  assert.equal(updateStatus.mock.callCount(), 0, "no se anula el pedido hasta confirmar");
  const firstKey = createRefund.mock.calls[0].arguments[3];

  // Mientras está pendiente no se puede pedir otra.
  await assert.rejects(service.requestRefund({ ownerId: OWNER_ID, orderId: 10, actor: ACTOR }), (e) => e.code === "REFUND_IN_PROGRESS");

  createRefund.mock.mockImplementation(async () => ({ id: "r-1", amount: 3000, status: "approved" }));
  const retried = await service.retryRefund({ ownerId: OWNER_ID, orderId: 10, refundId: state.refunds[0].id });
  assert.equal(retried.outcome, "completed");
  assert.equal(createRefund.mock.calls.at(-1).arguments[3], firstKey, "misma clave de idempotencia");
  assert.equal(state.refunds.length, 1, "no se duplicó");
});

test("MP acepta pero todavía no refleja la devolución: queda PENDING hasta confirmarse", async (t) => {
  const { service, state, getPayment } = setup(t);
  getPayment.mock.mockImplementation(async () => ({ transaction_amount_refunded: 0, refunds: [] }));
  const result = await service.requestRefund({ ownerId: OWNER_ID, orderId: 10, actor: ACTOR });
  assert.equal(result.outcome, "pending");
  assert.equal(state.refunds[0].status, "PENDING");
  assert.equal(state.payment.status, "APPROVED");
});

test("rechazar un pedido pagado: devuelve y recién entonces anula el pedido", async (t) => {
  const { service, updateStatus } = setup(t);
  const result = await service.requestRefund({ ownerId: OWNER_ID, orderId: 10, cancelOrder: true, reason: "Sin stock", actor: ACTOR });
  assert.equal(result.outcome, "completed");
  assert.equal(result.orderCancelled, true);
  const [owner, orderId, status, options] = updateStatus.mock.calls[0].arguments;
  assert.deepEqual([owner, orderId, status], [OWNER_ID, 10, "cancelled"]);
  assert.equal(options.reason, "Sin stock");
});

test("reintentar una devolución ajena o que ya no está pendiente se rechaza", async (t) => {
  const { service, state } = setup(t);
  await service.requestRefund({ ownerId: OWNER_ID, orderId: 10, actor: ACTOR });
  await assert.rejects(service.retryRefund({ ownerId: OWNER_ID, orderId: 10, refundId: state.refunds[0].id }), (e) => e.code === "REFUND_NOT_PENDING");
  await assert.rejects(service.retryRefund({ ownerId: "owner-2", orderId: 10, refundId: state.refunds[0].id }), (e) => e.status === 404);
  await assert.rejects(service.retryRefund({ ownerId: OWNER_ID, orderId: 10, refundId: "x" }), (e) => e.status === 404);
});

test("el webhook completa una devolución pendiente cuando MP ya la refleja", async (t) => {
  const { service, state } = setup(t);
  state.refunds.push({ id: 1, status: "PENDING", amount: "1000.00" }, { id: 2, status: "COMPLETED", amount: "500.00" });
  await service.completePendingRefunds({ id: 41, refunded_amount: "1400" });
  assert.equal(state.refunds[0].status, "PENDING", "1400 - 500 completadas < 1000");
  await service.completePendingRefunds({ id: 41, refunded_amount: "1500" });
  assert.equal(state.refunds[0].status, "COMPLETED");
});

test("detalle del pedido: resume importes sin datos internos de MP de la cuenta", async (t) => {
  const { service } = setup(t);
  assert.equal(await service.getOrderPayment(OWNER_ID, 99), null);
  const dto = await service.getOrderPayment(OWNER_ID, 10);
  assert.deepEqual(dto.payment, { status: "APPROVED", amount: 3000, refundedAmount: 0, refundable: 3000, canRefund: true });
  assert.ok(!JSON.stringify(dto).includes("APP_USR"));
});
