const test = require("node:test");
const assert = require("node:assert/strict");
const PaymentTransaction = require("../src/models/PaymentTransaction");
const User = require("../src/models/User");
const { listPayments, paymentToDTO } = require("../src/controllers/adminPaymentController");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("paymentToDTO expone solo los datos operativos necesarios", () => {
  const dto = paymentToDTO({
    _id: "64f000000000000000000301",
    paymentID: "123456789",
    preferenceId: "pref-1",
    operation: "renewal",
    planId: "pro",
    months: 3,
    amount: 149995,
    refundedAmount: 0,
    currency: "ARS",
    status: "approved",
    statusDetail: "accredited",
    liveMode: true,
    lastWebhookAt: new Date("2026-08-28T12:00:00.000Z"),
    entitlementStatus: "applied",
    entitlementReason: null,
    checkoutValidation: "strict",
    checkoutValidationReason: null,
    createdAt: new Date("2026-08-28T12:00:00.000Z"),
    checkoutID: { _id: "64f000000000000000000302", status: "payment_received" },
    userID: {
      _id: "64f000000000000000000123",
      username: "cliente-prueba",
      slug: "cliente-prueba",
      contactInfo: { businessName: "Bar de prueba" },
    },
    pendingRegistrationID: null,
    externalReference: "no-debe-salir",
    merchantOrderID: "no-debe-salir",
  });

  assert.equal(dto.customer.businessName, "Bar de prueba");
  assert.deepEqual(dto.checkout, {
    id: "64f000000000000000000302",
    status: "payment_received",
  });
  assert.equal(dto.externalReference, undefined);
  assert.equal(dto.merchantOrderID, undefined);
});

test("listPayments rechaza un userID inválido antes de consultar pagos", async (t) => {
  t.mock.method(PaymentTransaction, "find", () => {
    throw new Error("No debe consultar pagos con un ID inválido");
  });

  const res = response();
  await listPayments({ query: { userID: "cliente-invalido" } }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "ID de cliente inválido" });
});

test("listPayments pagina, filtra y devuelve el resumen financiero", async (t) => {
  let listFilter;
  let attentionFilter;
  let skipped;
  let limited;
  const payment = {
    _id: "64f000000000000000000301",
    paymentID: "123456789",
    operation: "upgrade",
    planId: "basic",
    months: 1,
    amount: 29999,
    currency: "ARS",
    status: "approved",
    statusDetail: "accredited",
    liveMode: true,
    lastWebhookAt: new Date("2026-08-28T12:00:00.000Z"),
    entitlementStatus: "applied",
    checkoutValidation: "strict",
    userID: null,
    pendingRegistrationID: null,
    checkoutID: null,
    createdAt: new Date("2026-08-28T12:00:00.000Z"),
  };
  const query = {
    select() { return this; },
    populate() { return this; },
    sort() { return this; },
    skip(value) { skipped = value; return this; },
    limit(value) { limited = value; return this; },
    async lean() { return [payment]; },
  };

  t.mock.method(PaymentTransaction, "find", (filter) => {
    listFilter = filter;
    return query;
  });
  t.mock.method(PaymentTransaction, "countDocuments", async (filter) => {
    if (filter.status === "approved") return 3;
    if (filter.entitlementStatus === "applied") return 2;
    if (filter.$or) {
      attentionFilter = filter;
      return 1;
    }
    if (filter.status?.$in?.includes("pending")) return 1;
    if (filter.status?.$in?.includes("rejected")) return 1;
    if (filter.status?.$in?.includes("refunded")) return 0;
    return 4;
  });
  t.mock.method(PaymentTransaction, "aggregate", async () => [{ amount: 59998 }]);

  const res = response();
  await listPayments(
    { query: { status: "approved", operation: "upgrade", page: "2", limit: "10" } },
    res
  );

  assert.deepEqual(listFilter, { status: "approved", operation: "upgrade" });
  assert.equal(skipped, 10);
  assert.equal(limited, 10);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.payments[0].paymentID, "123456789");
  assert.equal(res.body.summary.appliedAmount, 59998);
  assert.deepEqual(attentionFilter.$or[0], {
    status: "approved",
    entitlementStatus: { $ne: "applied" },
  });
  assert.equal(res.body.pagination.page, 2);
  assert.equal(res.body.pagination.limit, 10);
});

test("listPayments convierte userID a ObjectId para el resumen por cliente", async (t) => {
  const userID = "64f000000000000000000123";
  let aggregateFilter;
  const query = {
    select() { return this; },
    populate() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() { return []; },
  };

  t.mock.method(User, "exists", async () => ({ _id: userID }));
  t.mock.method(PaymentTransaction, "find", () => query);
  t.mock.method(PaymentTransaction, "countDocuments", async () => 0);
  t.mock.method(PaymentTransaction, "aggregate", async (pipeline) => {
    aggregateFilter = pipeline[0].$match;
    return [];
  });

  const res = response();
  await listPayments({ query: { userID } }, res);

  assert.equal(String(aggregateFilter.userID), userID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pagination.total, 0);
});
