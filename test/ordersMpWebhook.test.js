const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const SECRET = "whsec-de-prueba";
const REF = "a".repeat(48);
const OWNER = { _id: "owner-1", slug: "mi-local" };
const DRAFT = {
  serviceType: "delivery",
  customer: { name: "Ana", phone: "11", address: "Calle 1", deliveryNotes: null },
  notes: null,
  total: 3000,
  lines: [{ itemId: "i1", title: "Pizza", option: null, unitPrice: 1500, quantity: 2, notes: null, position: 0 }],
};
const baseRow = () => ({
  id: 41, owner_id: "owner-1", order_id: null, client_request_id: "5f0b2c1e-3a4d-4b6f-8c7d-9e0f1a2b3c4d",
  external_reference: REF, amount: "3000.00", status: "PENDING", mp_payment_id: null, last_event_at: null, draft: DRAFT,
});
const mpPayment = (over = {}) => ({
  id: 555, status: "approved", status_detail: "accredited", external_reference: REF, collector_id: 777,
  transaction_amount: 3000, transaction_amount_refunded: 0, currency_id: "ARS",
  date_approved: "2026-10-08T12:00:00.000Z", date_last_updated: "2026-10-08T12:00:01.000Z", ...over,
});

const withEnv = (t) => {
  const previous = process.env.ORDERS_CREDENTIALS_KEY;
  process.env.ORDERS_CREDENTIALS_KEY = "k".repeat(40);
  t.after(() => {
    if (previous === undefined) delete process.env.ORDERS_CREDENTIALS_KEY;
    else process.env.ORDERS_CREDENTIALS_KEY = previous;
  });
};

// Mini base en memoria para las consultas que hace el webhook.
const setup = (t, { row = baseRow(), connection = { owner_id: "owner-1", mp_user_id: "777" }, payment = mpPayment() } = {}) => {
  withEnv(t);
  const sql = require("../src/orders/db/sql");
  const catalog = require("../src/orders/services/menuCatalog");
  const state = { row, events: new Map(), ordersUpdates: [], eventOutcome: null };

  const run = async (text, params) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("INSERT INTO order_mp_webhook_events")) {
      if (state.events.has(params[0])) return { rows: [] };
      const event = { id: state.events.size + 1, processed_at: null };
      state.events.set(params[0], event);
      return { rows: [{ id: event.id }] };
    }
    if (q.startsWith("SELECT id, processed_at FROM order_mp_webhook_events")) return { rows: [state.events.get(params[0])] };
    if (q.includes("SET outcome = 'error'")) { state.eventOutcome = "error"; return { rows: [] }; }
    if (q.startsWith("UPDATE order_mp_webhook_events SET outcome")) {
      state.eventOutcome = params[1];
      for (const event of state.events.values()) if (event.id === params[0]) event.processed_at = new Date();
      return { rows: [] };
    }
    if (q.startsWith("SELECT owner_id, mp_user_id FROM order_mp_connections")) {
      return { rows: connection && String(params[0]) === connection.mp_user_id ? [connection] : [] };
    }
    if (q.startsWith("SELECT * FROM order_online_payments")) {
      return { rows: state.row && params[0] === state.row.external_reference && params[1] === state.row.owner_id ? [state.row] : [] };
    }
    if (q.startsWith("UPDATE order_online_payments SET mp_payment_id")) {
      state.row = { ...state.row, mp_payment_id: params[1], status: params[2], mp_status: params[3], refunded_amount: params[5], last_event_at: params[7] };
      return { rows: [state.row] };
    }
    if (q.startsWith("UPDATE order_online_payments SET order_id")) {
      state.row = { ...state.row, order_id: params[1] };
      return { rows: [] };
    }
    if (q.startsWith("SELECT * FROM order_refunds")) return { rows: state.refunds ?? [] };
    if (q.startsWith("UPDATE order_refunds SET status = 'COMPLETED'")) {
      state.refunds = (state.refunds ?? []).map((r) => (r.id === params[0] ? { ...r, status: "COMPLETED" } : r));
      return { rows: [] };
    }
    if (q.startsWith("UPDATE orders SET payment_status")) {
      state.ordersUpdates.push({ orderId: params[1], status: params[2] });
      return { rows: [] };
    }
    throw new Error(`Consulta no prevista en el test: ${q}`);
  };
  t.mock.method(sql, "query", run);
  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: run }));
  t.mock.method(catalog, "findOwnerById", async () => OWNER);

  const paths = ["webhookService", "connectionService", "refundService"].map((n) => require.resolve(`../src/orders/payments/${n}`));
  paths.forEach((p) => { delete require.cache[p]; });
  t.after(() => paths.forEach((p) => { delete require.cache[p]; }));
  const service = require(paths[0]);
  const connections = require(paths[1]);
  const mpApi = require("../src/orders/payments/mpApi");
  const orderService = require("../src/orders/services/orderService");
  const settingsService = require("../src/orders/services/settingsService");

  t.mock.method(connections, "getAccessToken", async () => ({ connectionId: 9, mpUserId: "777", liveMode: true, accessToken: "APP_USR-local" }));
  const getPayment = t.mock.method(mpApi, "getPayment", async () => state.payment ?? payment);
  const createOrder = t.mock.method(orderService, "createOrder", async () => ({ order: { id: 77 }, duplicate: false }));
  t.mock.method(settingsService, "getOrCreateSettings", async () => ({}));
  return { service, state, getPayment, createOrder, mpApi, connections };
};

const notify = (service, over = {}) => service.processPaymentNotification({
  mpUserId: "777", paymentId: "555", requestId: "req-1", topic: "payment", ...over,
});

test("pago aprobado: valida con la API de MP y crea el pedido una sola vez, pendiente de aceptar", async (t) => {
  const { service, state, getPayment, createOrder } = setup(t);
  assert.deepEqual(await notify(service), { outcome: "applied" });

  assert.equal(getPayment.mock.calls[0].arguments[0], "APP_USR-local", "consulta con el token del local");
  assert.equal(state.row.status, "APPROVED");
  assert.equal(state.row.mp_payment_id, "555");
  assert.equal(state.row.order_id, 77);

  assert.equal(createOrder.mock.callCount(), 1);
  const args = createOrder.mock.calls[0].arguments[0];
  assert.equal(args.source, "customer");
  assert.equal(args.serviceType, "delivery");
  assert.deepEqual(args.priced, { lines: DRAFT.lines, total: 3000 });
  assert.deepEqual(args.payment, { mode: "mercadopago", status: "APPROVED" });
  assert.equal(args.clientRequestId, baseRow().client_request_id, "idempotencia por carrito");
  assert.equal(args.customer.address, "Calle 1");
  assert.equal(state.eventOutcome, "applied");
});

test("la misma notificación repetida no procesa ni crea nada de nuevo", async (t) => {
  const { service, getPayment, createOrder } = setup(t);
  await notify(service);
  assert.deepEqual(await notify(service), { outcome: "duplicate" });
  assert.equal(getPayment.mock.callCount(), 1);
  assert.equal(createOrder.mock.callCount(), 1);
});

test("otra notificación del mismo pago (distinto request-id) no duplica el pedido", async (t) => {
  const { service, createOrder, state } = setup(t);
  await notify(service);
  assert.deepEqual(await notify(service, { requestId: "req-2" }), { outcome: "applied" });
  assert.equal(createOrder.mock.callCount(), 1);
  assert.equal(state.row.order_id, 77);
  assert.deepEqual(state.ordersUpdates.at(-1), { orderId: 77, status: "APPROVED" });
});

test("importe distinto al del carrito: no se aprueba ni se crea pedido", async (t) => {
  const { service, state, createOrder } = setup(t, { payment: mpPayment({ transaction_amount: 10 }) });
  t.mock.method(console, "error", () => {});
  assert.deepEqual(await notify(service), { outcome: "amount_mismatch" });
  assert.equal(state.row.status, "PENDING");
  assert.equal(createOrder.mock.callCount(), 0);
});

test("moneda distinta de ARS: no se aprueba", async (t) => {
  const { service, createOrder } = setup(t, { payment: mpPayment({ currency_id: "USD" }) });
  t.mock.method(console, "error", () => {});
  assert.deepEqual(await notify(service), { outcome: "amount_mismatch" });
  assert.equal(createOrder.mock.callCount(), 0);
});

test("un evento viejo que llega tarde no retrocede un pago aprobado", async (t) => {
  const { service, state } = setup(t);
  await notify(service);
  state.payment = mpPayment({ status: "pending", status_detail: "pending", date_last_updated: "2026-10-08T11:00:00.000Z" });
  assert.deepEqual(await notify(service, { requestId: "req-old" }), { outcome: "stale" });
  assert.equal(state.row.status, "APPROVED");
});

test("aunque el evento viejo traiga fecha nueva, el estado no retrocede", async (t) => {
  const { service, state } = setup(t);
  await notify(service);
  state.payment = mpPayment({ status: "in_process", date_last_updated: "2026-10-08T13:00:00.000Z" });
  await notify(service, { requestId: "req-x" });
  assert.equal(state.row.status, "APPROVED");
});

test("otro pago aprobado sobre un carrito ya pagado se marca duplicado y no pisa el primero", async (t) => {
  const { service, state, createOrder } = setup(t);
  await notify(service);
  t.mock.method(console, "error", () => {});
  state.payment = mpPayment({ id: 999 });
  assert.deepEqual(await notify(service, { paymentId: "999", requestId: "req-dup" }), { outcome: "duplicate_payment" });
  assert.equal(state.row.mp_payment_id, "555");
  assert.equal(createOrder.mock.callCount(), 1);
});

test("pago rechazado y luego un segundo intento aprobado del mismo carrito", async (t) => {
  const { service, state, createOrder } = setup(t, { payment: mpPayment({ id: 111, status: "rejected", status_detail: "cc_rejected_other_reason" }) });
  assert.deepEqual(await notify(service, { paymentId: "111" }), { outcome: "applied" });
  assert.equal(state.row.status, "REJECTED");
  assert.equal(createOrder.mock.callCount(), 0);

  state.payment = mpPayment({ id: 222 });
  assert.deepEqual(await notify(service, { paymentId: "222", requestId: "req-2" }), { outcome: "applied" });
  assert.equal(state.row.status, "APPROVED");
  assert.equal(state.row.mp_payment_id, "222");
  assert.equal(createOrder.mock.callCount(), 1);
});

test("pago pendiente o en proceso: sin pedido todavía", async (t) => {
  const { service, state, createOrder } = setup(t, { payment: mpPayment({ status: "in_process" }) });
  await notify(service);
  assert.equal(state.row.status, "PENDING");
  assert.equal(createOrder.mock.callCount(), 0);
});

test("devolución parcial y total actualizan el pago y el pedido", async (t) => {
  const { service, state } = setup(t);
  await notify(service);
  state.payment = mpPayment({ transaction_amount_refunded: 1000, date_last_updated: "2026-10-08T14:00:00.000Z" });
  await notify(service, { requestId: "r-partial" });
  assert.equal(state.row.status, "PARTIALLY_REFUNDED");
  assert.deepEqual(state.ordersUpdates.at(-1), { orderId: 77, status: "PARTIALLY_REFUNDED" });

  state.payment = mpPayment({ status: "refunded", transaction_amount_refunded: 3000, date_last_updated: "2026-10-08T15:00:00.000Z" });
  await notify(service, { requestId: "r-full" });
  assert.equal(state.row.status, "REFUNDED");
  assert.deepEqual(state.ordersUpdates.at(-1), { orderId: 77, status: "REFUNDED" });
});

test("cuenta de MP desconocida: se ignora sin consultar a MP", async (t) => {
  const { service, getPayment } = setup(t, { connection: null });
  assert.deepEqual(await notify(service), { outcome: "ignored" });
  assert.equal(getPayment.mock.callCount(), 0);
  assert.deepEqual(await notify(service, { requestId: "r2", mpUserId: undefined }), { outcome: "ignored" });
});

test("pago de otra cuenta (collector distinto) o sin referencia nuestra: se ignora", async (t) => {
  const first = setup(t, { payment: mpPayment({ collector_id: 12345 }) });
  assert.deepEqual(await notify(first.service), { outcome: "ignored" });

  const second = setup(t, { payment: mpPayment({ external_reference: "no-es-nuestra" }) });
  assert.deepEqual(await notify(second.service), { outcome: "ignored" });
});

test("un carrito de OTRO local nunca se asocia: la referencia se busca dentro del local de la cuenta", async (t) => {
  const { service, state, createOrder } = setup(t, { row: { ...baseRow(), owner_id: "owner-2" } });
  assert.deepEqual(await notify(service), { outcome: "ignored" });
  assert.equal(state.row.status, "PENDING");
  assert.equal(createOrder.mock.callCount(), 0);
});

test("falla transitoria de MP: se propaga (para que MP reintente) y el evento queda para reprocesar", async (t) => {
  const { service, mpApi, state } = setup(t);
  const get = t.mock.method(mpApi, "getPayment", async () => { throw new mpApi.MpApiError(503, null); });
  await assert.rejects(notify(service), (e) => e.status === 503);
  assert.equal(state.eventOutcome, "error");
  get.mock.mockImplementation(async () => mpPayment());
  assert.deepEqual(await notify(service), { outcome: "applied" }, "el reintento de MP sí procesa");
});

test("si falla crear el pedido, el reintento lo crea (el pago ya quedó aprobado)", async (t) => {
  const { service, state, createOrder } = setup(t);
  createOrder.mock.mockImplementationOnce(async () => { throw new Error("db caída"); });
  await assert.rejects(notify(service), /db caída/);
  assert.equal(state.row.status, "APPROVED");
  assert.equal(state.row.order_id, null);
  assert.deepEqual(await notify(service), { outcome: "applied" });
  assert.equal(state.row.order_id, 77);
});

test("mapStatus: tabla de estados", (t) => {
  withEnv(t);
  const { mapStatus } = require("../src/orders/payments/webhookService");
  const amount = 3000;
  assert.equal(mapStatus({ status: "approved" }, amount), "APPROVED");
  assert.equal(mapStatus({ status: "approved", transaction_amount_refunded: 1 }, amount), "PARTIALLY_REFUNDED");
  assert.equal(mapStatus({ status: "approved", transaction_amount_refunded: 3000 }, amount), "REFUNDED");
  assert.equal(mapStatus({ status: "refunded" }, amount), "REFUNDED");
  for (const s of ["rejected", "cancelled"]) assert.equal(mapStatus({ status: s }, amount), "REJECTED");
  for (const s of ["pending", "in_process", "in_mediation", "authorized"]) assert.equal(mapStatus({ status: s }, amount), "PENDING");
  assert.equal(mapStatus({ status: "charged_back" }, amount), null);
});

// ── Firma y controlador ────────────────────────────────────────────────
const sign = ({ dataId, requestId, ts = "1700000000", secret = SECRET }) => {
  const hash = crypto.createHmac("sha256", secret).update(`id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex");
  return `ts=${ts},v1=${hash}`;
};

test("firma: válida, adulterada y datos faltantes", () => {
  const { verifySignature } = require("../src/orders/payments/signature");
  const requestId = "9d1c1f06-7d3c-4c52-8d3a-2f5c7a8e9b10";
  const headers = { "x-request-id": requestId, "x-signature": sign({ dataId: "ABC123", requestId }) };
  assert.equal(verifySignature({ headers, dataId: "ABC123", secret: SECRET }).valid, true);
  assert.equal(verifySignature({ headers, dataId: "abc123", secret: SECRET }).valid, true, "data.id en minúsculas");
  assert.equal(verifySignature({ headers, dataId: "OTRO", secret: SECRET }).valid, false);
  assert.equal(verifySignature({ headers, dataId: "ABC123", secret: "otro-secreto" }).valid, false);
  assert.equal(verifySignature({ headers: {}, dataId: "ABC123", secret: SECRET }).valid, false);
  assert.equal(verifySignature({ headers, dataId: "ABC123", secret: "" }).reason, "secret_missing");
  const tampered = { ...headers, "x-signature": headers["x-signature"].replace(/.$/, (c) => (c === "0" ? "1" : "0")) };
  assert.equal(verifySignature({ headers: tampered, dataId: "ABC123", secret: SECRET }).valid, false);
});

const callController = async (t, { query, body, headers }) => {
  const previous = process.env.MP_ORDERS_WEBHOOK_SECRET;
  process.env.MP_ORDERS_WEBHOOK_SECRET = SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.MP_ORDERS_WEBHOOK_SECRET;
    else process.env.MP_ORDERS_WEBHOOK_SECRET = previous;
  });
  const webhookService = require("../src/orders/payments/webhookService");
  const processSpy = t.mock.method(webhookService, "processPaymentNotification", async () => ({ outcome: "applied" }));
  const path = require.resolve("../src/orders/payments/webhookController");
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  const { receive } = require(path);
  t.mock.method(console, "error", () => {});
  const res = { statusCode: null, json(payload) { this.payload = payload; return this; }, status(code) { this.statusCode = code; return this; } };
  await receive({ query, body, headers }, res);
  return { res, processSpy };
};

test("webhook HTTP: firma inválida => 401 y no se procesa nada", async (t) => {
  const { res, processSpy } = await callController(t, {
    query: { "data.id": "555" }, body: { type: "payment", user_id: "777" },
    headers: { "x-request-id": "r", "x-signature": "ts=1,v1=deadbeef" },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(processSpy.mock.callCount(), 0);
});

test("webhook HTTP: firma válida de un evento de pago => se procesa y responde 200", async (t) => {
  const { res, processSpy } = await callController(t, {
    query: { "data.id": "555" }, body: { type: "payment", user_id: 777 },
    headers: { "x-request-id": "req-77", "x-signature": sign({ dataId: "555", requestId: "req-77" }) },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(processSpy.mock.calls[0].arguments[0], { mpUserId: 777, paymentId: "555", requestId: "req-77", topic: "payment" });
});

test("webhook HTTP: eventos que no son de pago se ignoran con 200", async (t) => {
  const { res, processSpy } = await callController(t, {
    query: { "data.id": "555" }, body: { type: "merchant_order" },
    headers: { "x-request-id": "req-78", "x-signature": sign({ dataId: "555", requestId: "req-78" }) },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(processSpy.mock.callCount(), 0);
});
