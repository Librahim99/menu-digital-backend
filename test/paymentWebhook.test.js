const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { Payment } = require("mercadopago");
const User = require("../src/models/User");
const PendingRegistration = require("../src/models/PendingRegistration");
const PaymentCheckout = require("../src/models/PaymentCheckout");
const PaymentTransaction = require("../src/models/PaymentTransaction");
const CrmProfile = require("../src/models/CrmProfile");
const { getRegistrationStatus, mpWebhook } = require("../src/controllers/paymentController");
const { encryptPendingPassword } = require("../src/utils/pendingCredentials");
const {
  PAYMENT_CURRENCY,
  getCheckoutAmount,
} = require("../src/config/paymentPlans");

const USER_ID = "64f000000000000000000123";
const PENDING_REGISTRATION_ID = "64f000000000000000000456";
const NEW_USER_ID = "64f000000000000000000789";
const PREFERENCE_ID = "preference-123";
const CHECKOUT_ID = "64f000000000000000000999";
const TEST_MP_WEBHOOK_SECRET = "webhook-secret-de-prueba";

function request(
  paymentID = "payment-123",
  {
    signedRequestId = `request-${paymentID}`,
    receivedRequestId = signedRequestId,
  } = {}
) {
  const ts = "1704908010";
  const manifest =
    `id:${String(paymentID).toLowerCase()};` +
    `request-id:${signedRequestId};` +
    `ts:${ts};`;

  const hash = crypto
    .createHmac("sha256", TEST_MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");

  return {
    query: { "data.id": paymentID, type: "payment" },
    body: {},
    headers: {
      "x-request-id": receivedRequestId,
      "x-signature": `ts=${ts},v1=${hash}`,
    },
  };
}

function response() {
  return {
    statusCode: null,
    body: null,
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
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

function approvedPayment(overrides = {}) {
  return {
    id: "payment-123",
    status: "approved",
    status_detail: "accredited",
    external_reference: USER_ID,
    transaction_amount: 5400,
    transaction_amount_refunded: 0,
    currency_id: "ARS",
    live_mode: false,
    date_created: "2026-08-21T14:58:00.000Z",
    date_approved: "2026-08-21T15:00:00.000Z",
    date_last_updated: "2026-08-21T15:00:01.000Z",
    order: { id: 456789 },
    metadata: {
      plan_id: "basic",
      months: 3,
      type: "upgrade",
      payment_mode: "upgrade",
    },
    ...overrides,
  };
}

function applyMockUpdate(target, update, { inserted = false } = {}) {
  if (inserted && update.$setOnInsert) {
    Object.assign(target, update.$setOnInsert);
  }
  if (update.$set) {
    Object.assign(target, update.$set);
  }
  if (update.$unset) {
    Object.keys(update.$unset).forEach((key) => delete target[key]);
  }
}

function transactionMatchesFilter(transaction, filter) {
  if (!transaction) return false;
  if (filter.paymentID && transaction.paymentID !== filter.paymentID) return false;
  if (
    filter.entitlementStatus?.$ne !== undefined
    && transaction.entitlementStatus === filter.entitlementStatus.$ne
  ) {
    return false;
  }
  if (
    filter.subscriptionExpiresAtBefore?.$exists === false
    && Object.prototype.hasOwnProperty.call(
      transaction,
      "subscriptionExpiresAtBefore"
    )
  ) {
    return false;
  }
  return true;
}

function mockCommon(
  t,
  paymentData,
  {
    transactionError,
    markAppliedErrorOnce,
    initialTransaction,
  } = {}
) {
  const transactionWrites = [];
  const crmUpdates = [];
  const defaultPaymentID = String(
    typeof paymentData === "function" ? "payment-123" : paymentData.id
  );
  const transactions = new Map();
  if (initialTransaction) {
    transactions.set(defaultPaymentID, {
        entitlementStatus: "pending",
        entitlementReason: null,
        ...initialTransaction,
    });
  }
  let appliedFailureUsed = false;
  const previousSecret = process.env.MP_WEBHOOK_SECRET;
  const previousMpEnvironment = process.env.MP_ENV;
  process.env.MP_WEBHOOK_SECRET = TEST_MP_WEBHOOK_SECRET;
  process.env.MP_ENV = "test";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.MP_WEBHOOK_SECRET;
    else process.env.MP_WEBHOOK_SECRET = previousSecret;
    if (previousMpEnvironment === undefined) delete process.env.MP_ENV;
    else process.env.MP_ENV = previousMpEnvironment;
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(mongoose.connection, "transaction", async (work) => work(null));
  t.mock.method(Payment.prototype, "get", async ({ id }) => (
    typeof paymentData === "function" ? paymentData(String(id)) : paymentData
  ));
  t.mock.method(
    PaymentTransaction,
    "findOneAndUpdate",
    async (filter, update, options) => {
      const write = { filter, update, options: options || {} };
      transactionWrites.push(write);
      if (transactionError) throw transactionError;

      const isMarkApplied = update.$set?.entitlementStatus === "applied";
      if (isMarkApplied && markAppliedErrorOnce && !appliedFailureUsed) {
        appliedFailureUsed = true;
        throw markAppliedErrorOnce;
      }

      const transactionID = String(filter.paymentID);
      let transaction = transactions.get(transactionID) || null;
      let inserted = false;
      if (!transaction) {
        if (!options?.upsert) return null;
        inserted = true;
        transaction = {
          paymentID: transactionID,
          preferenceId: null,
          userID: null,
          pendingRegistrationID: null,
          entitlementStatus: "pending",
          entitlementReason: null,
        };
        transactions.set(transactionID, transaction);
      } else if (!transactionMatchesFilter(transaction, filter)) {
        return null;
      }

      applyMockUpdate(transaction, update, { inserted });
      return { ...transaction };
    }
  );
  t.mock.method(CrmProfile, "findOneAndUpdate", async (...args) => {
    crmUpdates.push(args);
    return {};
  });
  return {
    transactionWrites,
    crmUpdates,
    getTransaction: (paymentID = defaultPaymentID) => {
      const transaction = transactions.get(String(paymentID));
      return transaction ? { ...transaction } : null;
    },
  };
}

function mockExistingUser(t, previousUser, updates) {
  const userState = { ...previousUser };
  t.mock.method(User, "findById", () => ({
    select: async () => userState,
  }));
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => {
    updates.push({ id, update });
    Object.assign(userState, update.$set || update);
    return userState;
  });
  return userState;
}

function mockCheckout(t, overrides = {}) {
  const checkout = {
    _id: CHECKOUT_ID,
    preferenceId: PREFERENCE_ID,
    operation: "upgrade",
    userID: USER_ID,
    pendingRegistrationID: null,
    planId: "basic",
    months: 3,
    expectedAmount: 5400,
    currency: "ARS",
    status: "ready",
    ...overrides,
  };
  t.mock.method(PaymentCheckout, "findById", async (id) => (
    String(id) === String(checkout._id) ? checkout : null
  ));
  t.mock.method(PaymentCheckout, "findByIdAndUpdate", async (id, update) => {
    if (String(id) !== String(checkout._id)) return null;
    applyMockUpdate(checkout, update);
    return checkout;
  });
  return checkout;
}

function mockExistingRegistrationUser(
  t,
  {
    purchasedPlan,
    months = 3,
    approvedAt,
    currentPlan,
    currentExpiresAt,
  }
) {
  const previousSecret = process.env.PENDING_REGISTRATION_SECRET;
  process.env.PENDING_REGISTRATION_SECRET = "secret-de-prueba-con-mas-de-32-caracteres";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.PENDING_REGISTRATION_SECRET;
    else process.env.PENDING_REGISTRATION_SECRET = previousSecret;
  });

  const paymentContext = mockCommon(t, approvedPayment({
    external_reference: PENDING_REGISTRATION_ID,
    date_approved: approvedAt,
    metadata: {
      plan_id: purchasedPlan,
      months,
      type: "registration",
    },
  }));
  const pending = {
    _id: PENDING_REGISTRATION_ID,
    status: "pending",
    username: "usuario-existente",
    ...encryptPendingPassword("password-seguro"),
    contactInfo: { mail: "existing@example.com", businessName: "Existing" },
    months,
    preferenceId: PREFERENCE_ID,
  };
  t.mock.method(PendingRegistration, "findById", () => ({
    select: async () => pending,
  }));
  const pendingUpdates = [];
  t.mock.method(PendingRegistration, "findByIdAndUpdate", async (id, update) => {
    pendingUpdates.push({ id, update });
    applyMockUpdate(pending, update);
    return pending;
  });

  const existingUser = {
    _id: USER_ID,
    subscription: currentPlan,
    subscriptionExpiresAt: currentExpiresAt,
    matchPassword: async (password) => password === "password-seguro",
  };
  t.mock.method(User, "findOne", () => ({ select: async () => existingUser }));
  const userUpdates = [];
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => {
    userUpdates.push({ id, update });
    Object.assign(existingUser, update.$set || update);
    return existingUser;
  });
  let userCreates = 0;
  t.mock.method(User, "create", async () => {
    userCreates += 1;
    return {};
  });

  return {
    paymentContext,
    pending,
    pendingUpdates,
    existingUser,
    userUpdates,
    getUserCreates: () => userCreates,
  };
}

test("el checkout de registro vence después de 7 días", () => {
  const now = Date.parse("2026-08-21T15:00:00.000Z");

  assert.equal(
    PendingRegistration.getCheckoutExpiration(now).toISOString(),
    "2026-08-28T15:00:00.000Z"
  );
});

test("un registro pendiente conserva 3 días de margen tras vencer el checkout", () => {
  const now = Date.parse("2026-08-21T15:00:00.000Z");

  assert.equal(
    PendingRegistration.getPendingExpiration(now).toISOString(),
    "2026-08-31T15:00:00.000Z"
  );
});

test("un PendingRegistration nuevo genera un expiresAt válido por defecto", () => {
  const beforeCreation = Date.now();
  const pending = new PendingRegistration({
    username: "registro-default-expiration",
    contactInfo: {
      mail: "registro-default@example.com",
      businessName: "Registro Default",
    },
    acceptedTerms: true,
    planId: "basic",
    months: 1,
    activationTokenHash: "d".repeat(64),
  });
  const afterCreation = Date.now();

  assert.equal(pending.validateSync(), undefined);
  assert.ok(pending.expiresAt instanceof Date);
  assert.equal(Number.isNaN(pending.expiresAt.getTime()), false);
  assert.ok(
    pending.expiresAt >= PendingRegistration.getPendingExpiration(beforeCreation)
  );
  assert.ok(
    pending.expiresAt <= PendingRegistration.getPendingExpiration(afterCreation)
  );
});

test("un registro terminado se limpia después de 24 horas", () => {
  const now = Date.parse("2026-08-21T15:00:00.000Z");

  assert.equal(
    PendingRegistration.getTerminalExpiration(now).toISOString(),
    "2026-08-22T15:00:00.000Z"
  );
});

test("el estado completado entrega una sesión para el usuario creado", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "jwt-secret-de-prueba";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  t.mock.method(PendingRegistration, "findOne", () => ({
    select: async () => ({ status: "completed", userID: "user-123" }),
  }));
  t.mock.method(User, "findById", () => ({
    select: async () => ({
      _id: "user-123",
      username: "restaurante-test",
      admin: false,
      active: true,
      slug: "restaurante-test",
      subscription: "basic",
      subscriptionExpiresAt: new Date("2026-09-21T15:00:00.000Z"),
    }),
  }));

  const req = { body: { registrationToken: "a".repeat(64) } };
  const res = response();
  await getRegistrationStatus(req, res);

  assert.equal(res.statusCode, null);
  assert.equal(res.body.status, "completed");
  assert.equal(res.body.auth.username, "restaurante-test");
  assert.equal(jwt.verify(res.body.auth.token, process.env.JWT_SECRET).id, "user-123");
});

test("la consulta del alta expone el último estado guardado de MercadoPago", async (t) => {
  t.mock.method(PendingRegistration, "findOne", () => ({
    select: async () => ({
      status: "pending",
      paymentStatus: "in_process",
      paymentStatusDetail: "pending_review_manual",
    }),
  }));

  const req = { body: { registrationToken: "b".repeat(64) } };
  const res = response();
  await getRegistrationStatus(req, res);

  assert.deepEqual(res.body, {
    status: "pending",
    paymentStatus: "in_process",
    paymentStatusDetail: "pending_review_manual",
  });
});

test("la consulta del alta no acepta un registrationToken vencido", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "jwt-secret-de-prueba";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  const expiredPending = {
    status: "completed",
    userID: USER_ID,
    expiresAt: new Date("2020-01-01T00:00:00.000Z"),
  };
  let pendingFilter;
  t.mock.method(PendingRegistration, "findOne", (filter) => {
    pendingFilter = filter;
    const filtersExpiration = filter.expiresAt?.$gt instanceof Date;
    return {
      select: async () => (filtersExpiration ? null : expiredPending),
    };
  });
  let userReads = 0;
  t.mock.method(User, "findById", () => {
    userReads += 1;
    return {
      select: async () => ({
        _id: USER_ID,
        username: "registro-vencido",
        active: true,
      }),
    };
  });

  const res = response();
  await getRegistrationStatus(
    { body: { registrationToken: "c".repeat(64) } },
    res
  );

  assert.equal(res.statusCode, 404);
  assert.ok(pendingFilter.expiresAt.$gt instanceof Date);
  assert.equal(userReads, 0);
});

test("upgrade aprobado actualiza plan y vencimiento según los meses pagados", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment());
  const updates = [];
  mockExistingUser(t, { subscription: "free", subscriptionExpiresAt: null }, updates);

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.subscription, "basic");
  assert.equal(updates[0].update.subscriptionExpiresAt.toISOString(), "2026-11-21T15:00:00.000Z");
  const snapshotWrite = paymentContext.transactionWrites.find(
    ({ options }) => options.upsert
  );
  assert.deepEqual(snapshotWrite.filter, { paymentID: "payment-123" });
  assert.equal(snapshotWrite.update.$set.status, "approved");
  assert.equal(snapshotWrite.update.$set.amount, 5400);
  assert.equal(snapshotWrite.update.$set.currency, "ARS");
  assert.equal(snapshotWrite.update.$set.operation, "upgrade");
  assert.equal(snapshotWrite.update.$set.planId, "basic");
  assert.equal(snapshotWrite.update.$set.months, 3);
  assert.equal(snapshotWrite.update.$set.merchantOrderID, "456789");
  assert.equal(snapshotWrite.update.$setOnInsert.userID, USER_ID);
  assert.equal(snapshotWrite.update.$set.preferenceId, undefined);
  assert.equal(snapshotWrite.options.new, true);

  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.entitlementStatus, "applied");
  assert.equal(transaction.entitlementReason, null);
  assert.ok(transaction.entitlementAppliedAt instanceof Date);
  assert.equal(transaction.appliedPlanId, "basic");
  assert.equal(transaction.appliedMonths, 3);
  assert.equal(transaction.userID, USER_ID);
  assert.equal(transaction.pendingRegistrationID, null);
  assert.equal(transaction.preferenceId, null);
  assert.equal(transaction.subscriptionExpiresAtBefore, null);
  assert.equal(
    transaction.subscriptionExpiresAtAfter.toISOString(),
    "2026-11-21T15:00:00.000Z"
  );
  assert.equal(paymentContext.crmUpdates.length, 1);
});

test("un pago live acredita beneficios en el ambiente productivo", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({ live_mode: true }));
  process.env.MP_ENV = "production";
  const updates = [];
  mockExistingUser(t, { subscription: "free", subscriptionExpiresAt: null }, updates);

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.subscription, "basic");
  assert.equal(paymentContext.getTransaction().liveMode, true);
  assert.equal(paymentContext.getTransaction().entitlementStatus, "applied");
});

test("un checkout nuevo valida asociación, plan, período, importe y moneda", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    metadata: {
      plan_id: "basic",
      months: 3,
      type: "upgrade",
      payment_mode: "upgrade",
      checkout_id: CHECKOUT_ID,
    },
  }));
  const checkout = mockCheckout(t);
  const updates = [];
  mockExistingUser(t, { subscription: "free", subscriptionExpiresAt: null }, updates);

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updates.length, 1);
  assert.equal(checkout.status, "payment_received");
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.checkoutID, CHECKOUT_ID);
  assert.equal(transaction.preferenceId, PREFERENCE_ID);
  assert.equal(transaction.checkoutValidation, "strict");
  assert.equal(transaction.checkoutValidationReason, null);
  assert.equal(transaction.entitlementStatus, "applied");
});

test("un importe distinto al checkout original no acredita el plan", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    transaction_amount: 5399,
    metadata: {
      plan_id: "basic",
      months: 3,
      type: "upgrade",
      payment_mode: "upgrade",
      checkout_id: CHECKOUT_ID,
    },
  }));
  mockCheckout(t);
  let updates = 0;
  t.mock.method(User, "findByIdAndUpdate", async () => { updates += 1; });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updates, 0);
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.checkoutValidation, "failed");
  assert.equal(transaction.checkoutValidationReason, "checkout_amount_mismatch");
  assert.equal(transaction.entitlementStatus, "not_applied");
  assert.equal(transaction.entitlementReason, "checkout_amount_mismatch");
});

test("una moneda distinta al checkout original no acredita el plan", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    currency_id: "USD",
    metadata: {
      plan_id: "basic",
      months: 3,
      type: "upgrade",
      payment_mode: "upgrade",
      checkout_id: CHECKOUT_ID,
    },
  }));
  mockCheckout(t);
  let userReads = 0;
  t.mock.method(User, "findById", () => {
    userReads += 1;
    return { select: async () => null };
  });

  await mpWebhook(request(), response());

  assert.equal(userReads, 0);
  assert.equal(
    paymentContext.getTransaction().entitlementReason,
    "checkout_currency_mismatch"
  );
});

test("dos cobros distintos de renovación suman su período exactamente una vez", async (t) => {
  const payments = {
    "payment-renewal-a": approvedPayment({
      id: "payment-renewal-a",
      date_approved: "2099-08-21T15:00:00.000Z",
      metadata: {
        plan_id: "basic",
        months: 3,
        type: "upgrade",
        payment_mode: "renewal",
        renewal_base: "2099-10-10T15:00:00.000Z",
      },
    }),
    "payment-renewal-b": approvedPayment({
      id: "payment-renewal-b",
      date_approved: "2099-08-21T15:01:00.000Z",
      metadata: {
        plan_id: "basic",
        months: 3,
        type: "upgrade",
        payment_mode: "renewal",
        renewal_base: "2099-10-10T15:00:00.000Z",
      },
    }),
  };
  const paymentContext = mockCommon(t, (paymentID) => payments[paymentID]);
  const updates = [];
  mockExistingUser(t, {
    subscription: "basic",
    subscriptionExpiresAt: new Date("2099-10-10T15:00:00.000Z"),
  }, updates);

  await mpWebhook(request("payment-renewal-a"), response());
  await mpWebhook(request("payment-renewal-b"), response());
  await mpWebhook(request("payment-renewal-a"), response());

  assert.equal(updates.length, 2);
  assert.equal(
    updates[0].update.subscriptionExpiresAt.toISOString(),
    "2100-01-10T15:00:00.000Z"
  );
  assert.equal(
    updates[1].update.subscriptionExpiresAt.toISOString(),
    "2100-04-10T15:00:00.000Z"
  );
  assert.equal(
    paymentContext.getTransaction("payment-renewal-a").entitlementStatus,
    "applied"
  );
  assert.equal(
    paymentContext.getTransaction("payment-renewal-b").entitlementStatus,
    "applied"
  );
  assert.equal(paymentContext.crmUpdates.length, 2);
});

test("un checkout Basic antiguo no degrada un Pro vigente", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    metadata: {
      plan_id: "basic",
      months: 3,
      type: "upgrade",
      payment_mode: "upgrade",
      checkout_id: CHECKOUT_ID,
    },
  }));
  mockCheckout(t);
  const updates = [];
  mockExistingUser(t, {
    subscription: "pro",
    subscriptionExpiresAt: new Date("2099-12-01T00:00:00.000Z"),
  }, updates);

  await mpWebhook(request(), response());

  assert.equal(updates.length, 0);
  assert.equal(
    paymentContext.getTransaction().entitlementReason,
    "stale_checkout_would_downgrade"
  );
  assert.equal(paymentContext.crmUpdates.length, 0);
});

test("un upgrade no acorta un vencimiento vigente más lejano", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    transaction_amount: 5000,
    date_approved: "2099-08-21T15:00:00.000Z",
    metadata: {
      plan_id: "pro",
      months: 1,
      type: "upgrade",
      payment_mode: "upgrade",
      checkout_id: CHECKOUT_ID,
    },
  }));
  mockCheckout(t, {
    planId: "pro",
    months: 1,
    expectedAmount: 5000,
  });
  const updates = [];
  mockExistingUser(t, {
    subscription: "basic",
    subscriptionExpiresAt: new Date("2100-03-01T00:00:00.000Z"),
  }, updates);

  await mpWebhook(request(), response());

  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.subscription, "pro");
  assert.equal(
    updates[0].update.subscriptionExpiresAt.toISOString(),
    "2100-03-01T00:00:00.000Z"
  );
  assert.equal(
    paymentContext.getTransaction().subscriptionExpiresAtAfter.toISOString(),
    "2100-03-01T00:00:00.000Z"
  );
});

test("renovación anticipada suma meses desde el vencimiento vigente", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    metadata: {
      plan_id: "basic",
      months: 3,
      type: "upgrade",
      payment_mode: "renewal",
      renewal_base: "2026-10-10T15:00:00.000Z",
    },
  }));
  const updates = [];
  mockExistingUser(t, {
    subscription: "basic",
    subscriptionExpiresAt: new Date("2026-10-10T15:00:00.000Z"),
  }, updates);

  await mpWebhook(request(), response());

  assert.equal(updates[0].update.subscriptionExpiresAt.toISOString(), "2027-01-10T15:00:00.000Z");
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.operation, "renewal");
  assert.equal(
    transaction.subscriptionExpiresAtBefore.toISOString(),
    "2026-10-10T15:00:00.000Z"
  );
  assert.equal(
    transaction.subscriptionExpiresAtAfter.toISOString(),
    "2027-01-10T15:00:00.000Z"
  );
});

test("renovación vencida comienza desde la aprobación", async (t) => {
  mockCommon(t, approvedPayment({
    metadata: {
      plan_id: "pro",
      months: 1,
      type: "upgrade",
      payment_mode: "renewal",
      renewal_base: "2026-07-01T15:00:00.000Z",
    },
  }));
  const updates = [];
  mockExistingUser(t, {
    subscription: "pro",
    subscriptionExpiresAt: new Date("2026-07-01T15:00:00.000Z"),
  }, updates);

  await mpWebhook(request(), response());

  assert.equal(updates[0].update.subscriptionExpiresAt.toISOString(), "2026-09-21T15:00:00.000Z");
});

test("un reintento del mismo webhook conserva el mismo vencimiento", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    metadata: {
      plan_id: "pro",
      months: 6,
      type: "upgrade",
      payment_mode: "renewal",
      renewal_base: "2026-12-15T15:00:00.000Z",
    },
  }));
  const updates = [];
  mockExistingUser(t, {
    subscription: "pro",
    subscriptionExpiresAt: new Date("2026-12-15T15:00:00.000Z"),
  }, updates);

  await mpWebhook(request(), response());
  const transactionAfterFirstDelivery = paymentContext.getTransaction();
  await mpWebhook(request(), response());
  const transactionAfterRetry = paymentContext.getTransaction();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.subscriptionExpiresAt.toISOString(), "2027-06-15T15:00:00.000Z");
  assert.equal(paymentContext.crmUpdates.length, 1);
  const snapshotWrites = paymentContext.transactionWrites.filter(
    ({ options }) => options.upsert
  );
  assert.equal(snapshotWrites.length, 2);
  assert.deepEqual(snapshotWrites[0].filter, snapshotWrites[1].filter);
  assert.equal(transactionAfterRetry.entitlementStatus, "applied");
  assert.equal(
    transactionAfterRetry.entitlementAppliedAt.getTime(),
    transactionAfterFirstDelivery.entitlementAppliedAt.getTime()
  );
  assert.equal(
    transactionAfterRetry.subscriptionExpiresAtBefore.toISOString(),
    "2026-12-15T15:00:00.000Z"
  );
  assert.equal(
    transactionAfterRetry.subscriptionExpiresAtAfter.toISOString(),
    "2027-06-15T15:00:00.000Z"
  );
});

test("un reintento recupera una finalización fallida sin duplicar el CRM", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    metadata: {
      plan_id: "pro",
      months: 6,
      type: "upgrade",
      payment_mode: "renewal",
      renewal_base: "2026-12-15T15:00:00.000Z",
    },
  }), {
    markAppliedErrorOnce: new Error("Falla al finalizar la transacción"),
  });
  const updates = [];
  mockExistingUser(t, {
    subscription: "pro",
    subscriptionExpiresAt: new Date("2026-12-15T15:00:00.000Z"),
  }, updates);

  const firstResponse = response();
  await mpWebhook(request(), firstResponse);

  assert.equal(firstResponse.statusCode, 500);
  assert.equal(updates.length, 1);
  assert.equal(paymentContext.crmUpdates.length, 0);
  const pendingTransaction = paymentContext.getTransaction();
  assert.equal(pendingTransaction.entitlementStatus, "pending");
  assert.equal(
    pendingTransaction.subscriptionExpiresAtBefore.toISOString(),
    "2026-12-15T15:00:00.000Z"
  );
  assert.equal(
    pendingTransaction.subscriptionExpiresAtAfter.toISOString(),
    "2027-06-15T15:00:00.000Z"
  );

  const recoveryResponse = response();
  await mpWebhook(request(), recoveryResponse);

  assert.equal(recoveryResponse.statusCode, 200);
  assert.equal(updates.length, 2);
  assert.equal(
    updates[0].update.subscriptionExpiresAt.toISOString(),
    updates[1].update.subscriptionExpiresAt.toISOString()
  );
  assert.equal(paymentContext.crmUpdates.length, 1);
  const recoveredTransaction = paymentContext.getTransaction();
  assert.equal(recoveredTransaction.entitlementStatus, "applied");
  assert.equal(recoveredTransaction.entitlementReason, null);
  assert.equal(
    recoveredTransaction.subscriptionExpiresAtBefore.toISOString(),
    "2026-12-15T15:00:00.000Z"
  );
  const appliedAt = recoveredTransaction.entitlementAppliedAt.getTime();

  const duplicateResponse = response();
  await mpWebhook(request(), duplicateResponse);

  assert.equal(duplicateResponse.statusCode, 200);
  assert.equal(updates.length, 2);
  assert.equal(paymentContext.crmUpdates.length, 1);
  assert.equal(
    paymentContext.getTransaction().entitlementAppliedAt.getTime(),
    appliedAt
  );
});

test("un pago pendiente no modifica la suscripción", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    status: "pending",
    status_detail: "pending_waiting_payment",
    date_approved: null,
  }));
  let updates = 0;
  t.mock.method(User, "findByIdAndUpdate", async () => { updates += 1; });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updates, 0);
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.status, "pending");
  assert.equal(transaction.statusDetail, "pending_waiting_payment");
  assert.equal(transaction.entitlementStatus, "not_applied");
  assert.equal(transaction.entitlementReason, "payment_not_approved");
  assert.equal(transaction.userID, USER_ID);
  assert.equal(paymentContext.crmUpdates.length, 0);
});

test("un pago rechazado guarda el estado de MercadoPago sin cerrar el alta", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    id: 987654,
    status: "rejected",
    status_detail: "cc_rejected_other_reason",
    date_last_updated: "2026-08-21T15:05:00.000Z",
    external_reference: PENDING_REGISTRATION_ID,
    metadata: { plan_id: "basic", months: 1, type: "registration" },
  }));
  let persisted;
  const pending = {
    _id: PENDING_REGISTRATION_ID,
    status: "pending",
    preferenceId: PREFERENCE_ID,
  };
  t.mock.method(PendingRegistration, "findOneAndUpdate", async (filter, update) => {
    persisted = { filter, update };
    applyMockUpdate(pending, update);
    return pending;
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(persisted.filter, {
    _id: PENDING_REGISTRATION_ID,
    status: "pending",
  });
  assert.equal(persisted.update.$set.paymentID, "987654");
  assert.equal(persisted.update.$set.paymentStatus, "rejected");
  assert.equal(persisted.update.$set.paymentStatusDetail, "cc_rejected_other_reason");
  assert.equal(
    persisted.update.$set.paymentUpdatedAt.toISOString(),
    "2026-08-21T15:05:00.000Z"
  );
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.status, "rejected");
  assert.equal(transaction.statusDetail, "cc_rejected_other_reason");
  assert.equal(transaction.pendingRegistrationID, PENDING_REGISTRATION_ID);
  assert.equal(transaction.preferenceId, PREFERENCE_ID);
  assert.equal(transaction.entitlementStatus, "not_applied");
  assert.equal(transaction.entitlementReason, "payment_not_approved");
});

test("un error interno devuelve 500 para que MercadoPago reintente", async (t) => {
  const previousSecret = process.env.MP_WEBHOOK_SECRET;
  const previousMpEnvironment = process.env.MP_ENV;
  process.env.MP_WEBHOOK_SECRET = TEST_MP_WEBHOOK_SECRET;
  process.env.MP_ENV = "test";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.MP_WEBHOOK_SECRET;
    else process.env.MP_WEBHOOK_SECRET = previousSecret;
    if (previousMpEnvironment === undefined) delete process.env.MP_ENV;
    else process.env.MP_ENV = previousMpEnvironment;
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(Payment.prototype, "get", async () => {
    throw new Error("Falla transitoria de MercadoPago");
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    message: "Ocurrió un error interno. Intentá de nuevo.",
  });
});

test("metadata con una duración inválida no modifica la suscripción", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({
    metadata: { plan_id: "basic", months: 2, type: "upgrade" },
  }));
  let updates = 0;
  t.mock.method(User, "findByIdAndUpdate", async () => { updates += 1; });

  await mpWebhook(request(), response());

  assert.equal(updates, 0);
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.months, 2);
  assert.equal(transaction.entitlementStatus, "not_applied");
  assert.equal(transaction.entitlementReason, "invalid_months");
  assert.equal(transaction.userID, USER_ID);
});

test("si falla el historial durable no se modifica la suscripción", async (t) => {
  mockCommon(t, approvedPayment(), {
    transactionError: new Error("Falla transitoria de MongoDB"),
  });
  let userReads = 0;
  let userUpdates = 0;
  t.mock.method(User, "findById", () => {
    userReads += 1;
    return { select: async () => null };
  });
  t.mock.method(User, "findByIdAndUpdate", async () => {
    userUpdates += 1;
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 500);
  assert.equal(userReads, 0);
  assert.equal(userUpdates, 0);
});

test("paymentID tiene un índice único y el historial no usa TTL", () => {
  assert.equal(PaymentTransaction.schema.path("paymentID").options.unique, true);
  assert.equal(PaymentTransaction.schema.path("expiresAt"), undefined);
  assert.equal(
    PaymentTransaction.schema.path("subscriptionExpiresAtBefore").options.default,
    undefined
  );
});

test("el checkout conserva un snapshot durable y usa la fuente única de precios", () => {
  assert.equal(getCheckoutAmount("basic", 3), 5400);
  assert.equal(getCheckoutAmount("pro", 12), 45000);
  assert.equal(PAYMENT_CURRENCY, "ARS");
  assert.equal(PaymentCheckout.schema.path("expiresAt"), undefined);
  assert.equal(
    PaymentCheckout.schema.path("expectedAmount").options.required,
    true
  );
  assert.equal(
    PaymentCheckout.schema.path("expectedAmount").options.immutable,
    true
  );
  const preferenceIndex = PaymentCheckout.schema.indexes().find(
    ([fields]) => fields.preferenceId === 1
  );
  assert.equal(preferenceIndex[1].unique, true);
  assert.equal(preferenceIndex[1].sparse, true);
});

test("preferencias antiguas sin months acreditan un mes con vencimiento", async (t) => {
  mockCommon(t, approvedPayment({
    metadata: { plan_id: "basic", type: "upgrade" },
  }));
  const updates = [];
  mockExistingUser(t, { subscription: "free", subscriptionExpiresAt: null }, updates);

  await mpWebhook(request(), response());

  assert.equal(updates[0].update.subscriptionExpiresAt.toISOString(), "2026-09-21T15:00:00.000Z");
});

for (const envoyNibble of ["9", "a", "b"]) {
  test(
    `acepta la firma cuando Envoy cambia el UUID v4 de 4 a ${envoyNibble}`,
    async (t) => {
      const paymentContext = mockCommon(
        t,
        approvedPayment({ live_mode: false })
      );
      process.env.MP_ENV = "production";

      const signedRequestId =
        "48270012-3bee-4a70-b11f-62efd7533e50";
      const receivedRequestId =
        `48270012-3bee-${envoyNibble}a70-b11f-62efd7533e50`;

      const res = response();

      await mpWebhook(
        request("payment-123", {
          signedRequestId,
          receivedRequestId,
        }),
        res
      );

      assert.equal(res.statusCode, 200);
      assert.equal(
        paymentContext.getTransaction().entitlementReason,
        "payment_environment_mismatch"
      );
    }
  );
}

test("una firma inválida devuelve 401 antes de consultar el pago", async (t) => {
  const previousSecret = process.env.MP_WEBHOOK_SECRET;
  process.env.MP_WEBHOOK_SECRET = TEST_MP_WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.MP_WEBHOOK_SECRET;
    else process.env.MP_WEBHOOK_SECRET = previousSecret;
  });
  t.mock.method(console, "error", () => {});
  let paymentReads = 0;
  t.mock.method(Payment.prototype, "get", async () => {
    paymentReads += 1;
    return approvedPayment();
  });

  const res = response();
  const invalidRequest = request("payment-123", {
  signedRequestId: "48270012-3bee-4a70-b11f-62efd7533e50",
  receivedRequestId: "48270012-3bee-9a70-b11f-62efd7533e50",
});

invalidRequest.headers["x-signature"] =
  `ts=1704908010,v1=${"0".repeat(64)}`;
  await mpWebhook(invalidRequest, res);

  assert.equal(res.statusCode, 401);
  assert.equal(paymentReads, 0);
});

test("sin MP_WEBHOOK_SECRET el webhook falla cerrado antes de consultar el pago", async (t) => {
  const previousSecret = process.env.MP_WEBHOOK_SECRET;
  delete process.env.MP_WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.MP_WEBHOOK_SECRET;
    else process.env.MP_WEBHOOK_SECRET = previousSecret;
  });
  t.mock.method(console, "error", () => {});
  let paymentReads = 0;
  t.mock.method(Payment.prototype, "get", async () => {
    paymentReads += 1;
    return approvedPayment();
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 401);
  assert.equal(paymentReads, 0);
});

test("un pago de prueba no acredita beneficios en el ambiente productivo", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment({ live_mode: false }));
  process.env.MP_ENV = "production";
  let userReads = 0;
  let userUpdates = 0;
  t.mock.method(User, "findById", () => {
    userReads += 1;
    return { select: async () => null };
  });
  t.mock.method(User, "findByIdAndUpdate", async () => {
    userUpdates += 1;
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(userReads, 0);
  assert.equal(userUpdates, 0);
  assert.equal(paymentContext.getTransaction().liveMode, false);
  assert.equal(
    paymentContext.getTransaction().entitlementReason,
    "payment_environment_mismatch"
  );
});

test("un upgrade aprobado para un usuario inexistente no crea cuentas", async (t) => {
  const paymentContext = mockCommon(t, approvedPayment());
  t.mock.method(User, "findById", () => ({ select: async () => null }));
  let updates = 0;
  let creates = 0;
  t.mock.method(User, "findByIdAndUpdate", async () => { updates += 1; });
  t.mock.method(User, "create", async () => { creates += 1; });

  await mpWebhook(request(), response());

  assert.equal(updates, 0);
  assert.equal(creates, 0);
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.entitlementStatus, "not_applied");
  assert.equal(transaction.entitlementReason, "user_not_found");
  assert.equal(transaction.userID, USER_ID);
  assert.equal(paymentContext.crmUpdates.length, 0);
});

for (const paymentType of ["upgrade", "registration"]) {
  test(`una referencia externa inválida no consulta entidades para ${paymentType}`, async (t) => {
    const paymentContext = mockCommon(t, approvedPayment({
      external_reference: "not-an-object-id",
      metadata: {
        plan_id: "basic",
        months: 1,
        type: paymentType,
      },
    }));
    let userReads = 0;
    let userUpdates = 0;
    let pendingReads = 0;
    let pendingUpdates = 0;
    t.mock.method(User, "findById", () => {
      userReads += 1;
      return { select: async () => null };
    });
    t.mock.method(User, "findByIdAndUpdate", async () => {
      userUpdates += 1;
      return null;
    });
    t.mock.method(PendingRegistration, "findById", () => {
      pendingReads += 1;
      return { select: async () => null };
    });
    t.mock.method(PendingRegistration, "findOneAndUpdate", async () => {
      pendingUpdates += 1;
      return null;
    });

    const res = response();
    await mpWebhook(request(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(userReads, 0);
    assert.equal(userUpdates, 0);
    assert.equal(pendingReads, 0);
    assert.equal(pendingUpdates, 0);
    const transaction = paymentContext.getTransaction();
    assert.equal(transaction.entitlementStatus, "not_applied");
    assert.equal(transaction.entitlementReason, "invalid_external_reference");
    assert.equal(transaction.userID, null);
    assert.equal(transaction.pendingRegistrationID, null);
    assert.equal(paymentContext.crmUpdates.length, 0);
  });
}

test("un pago no hereda el alta completada por otro payment ID", async (t) => {
  const paymentID = "payment-B";
  const paymentContext = mockCommon(t, approvedPayment({
    id: paymentID,
    external_reference: PENDING_REGISTRATION_ID,
    metadata: { plan_id: "basic", months: 3, type: "registration" },
  }));
  const pending = {
    _id: PENDING_REGISTRATION_ID,
    status: "completed",
    paymentID: "payment-A",
    userID: USER_ID,
    planId: "basic",
    months: 3,
    preferenceId: PREFERENCE_ID,
  };
  t.mock.method(PendingRegistration, "findById", () => ({
    select: async () => pending,
  }));
  let userReads = 0;
  let userUpdates = 0;
  let userCreates = 0;
  t.mock.method(User, "findById", () => {
    userReads += 1;
    return {
      select: async () => ({
        _id: USER_ID,
        subscription: "basic",
        subscriptionExpiresAt: new Date("2026-11-21T15:00:00.000Z"),
      }),
    };
  });
  t.mock.method(User, "findByIdAndUpdate", async () => {
    userUpdates += 1;
    return {};
  });
  t.mock.method(User, "create", async () => {
    userCreates += 1;
    return {};
  });

  const res = response();
  await mpWebhook(request(paymentID), res);

  assert.equal(res.statusCode, 200);
  assert.equal(userReads, 0);
  assert.equal(userUpdates, 0);
  assert.equal(userCreates, 0);
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.entitlementStatus, "not_applied");
  assert.equal(
    transaction.entitlementReason,
    "registration_completed_by_other_payment"
  );
  assert.equal(transaction.pendingRegistrationID, PENDING_REGISTRATION_ID);
  assert.equal(transaction.preferenceId, PREFERENCE_ID);
  assert.equal(paymentContext.crmUpdates.length, 0);
});

test("un usuario existente recibe el entitlement antes de completar el alta", async (t) => {
  const previousSecret = process.env.PENDING_REGISTRATION_SECRET;
  process.env.PENDING_REGISTRATION_SECRET = "secret-de-prueba-con-mas-de-32-caracteres";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.PENDING_REGISTRATION_SECRET;
    else process.env.PENDING_REGISTRATION_SECRET = previousSecret;
  });
  const paymentContext = mockCommon(t, approvedPayment({
    external_reference: PENDING_REGISTRATION_ID,
    metadata: { plan_id: "basic", months: 3, type: "registration" },
  }));
  const pending = {
    _id: PENDING_REGISTRATION_ID,
    status: "pending",
    username: "usuario-recuperado",
    ...encryptPendingPassword("password-seguro"),
    contactInfo: { mail: "recovery@example.com", businessName: "Recovery" },
    months: 3,
    preferenceId: PREFERENCE_ID,
  };
  t.mock.method(PendingRegistration, "findById", () => ({
    select: async () => pending,
  }));
  const writeOrder = [];
  let pendingUpdate;
  t.mock.method(PendingRegistration, "findByIdAndUpdate", async (id, update) => {
    writeOrder.push("pending-completed");
    pendingUpdate = { id, update };
    applyMockUpdate(pending, update);
    return pending;
  });
  const existingUser = {
    _id: USER_ID,
    subscription: "free",
    subscriptionExpiresAt: null,
    matchPassword: async (password) => password === "password-seguro",
  };
  t.mock.method(User, "findOne", () => ({ select: async () => existingUser }));
  let userUpdate;
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => {
    writeOrder.push("user-entitlement");
    userUpdate = { id, update };
    Object.assign(existingUser, update.$set || update);
    return existingUser;
  });
  let userCreates = 0;
  t.mock.method(User, "create", async () => {
    userCreates += 1;
    return {};
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(userCreates, 0);
  assert.deepEqual(writeOrder, ["user-entitlement", "pending-completed"]);
  assert.equal(userUpdate.id, USER_ID);
  const entitlementUpdate = userUpdate.update.$set || userUpdate.update;
  assert.equal(entitlementUpdate.subscription, "basic");
  assert.equal(
    entitlementUpdate.subscriptionExpiresAt.toISOString(),
    "2026-11-21T15:00:00.000Z"
  );
  assert.equal(pendingUpdate.id, PENDING_REGISTRATION_ID);
  assert.equal(pending.status, "completed");
  assert.equal(pending.userID, USER_ID);
  assert.equal(pending.paymentID, "payment-123");
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.entitlementStatus, "applied");
  assert.equal(transaction.userID, USER_ID);
  assert.equal(
    transaction.subscriptionExpiresAtAfter.toISOString(),
    entitlementUpdate.subscriptionExpiresAt.toISOString()
  );
  assert.equal(paymentContext.crmUpdates.length, 1);
});

test("un alta Basic no degrada un Pro activo ni acorta su vencimiento", async (t) => {
  const currentExpiry = new Date("2099-02-10T15:00:00.000Z");
  const purchasedExpiry = "2098-11-21T15:00:00.000Z";
  const {
    paymentContext,
    pending,
    pendingUpdates,
    userUpdates,
    getUserCreates,
  } = mockExistingRegistrationUser(t, {
    purchasedPlan: "basic",
    months: 3,
    approvedAt: "2098-08-21T15:00:00.000Z",
    currentPlan: "pro",
    currentExpiresAt: currentExpiry,
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(getUserCreates(), 0);
  assert.equal(userUpdates.length, 1);
  const entitlementUpdate = userUpdates[0].update.$set || userUpdates[0].update;
  assert.equal(entitlementUpdate.subscription, "pro");
  assert.equal(
    entitlementUpdate.subscriptionExpiresAt.toISOString(),
    currentExpiry.toISOString()
  );
  assert.equal(pendingUpdates.length, 1);
  assert.equal(pending.status, "completed");
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.entitlementStatus, "applied");
  assert.equal(transaction.appliedPlanId, "basic");
  assert.equal(
    transaction.subscriptionExpiresAtBefore.toISOString(),
    currentExpiry.toISOString()
  );
  assert.equal(
    transaction.subscriptionExpiresAtAfter.toISOString(),
    purchasedExpiry
  );
  assert.equal(paymentContext.crmUpdates.length, 1);
});

test("un Basic legacy que compra Pro recibe el vencimiento del pago", async (t) => {
  const purchasedExpiry = "2098-11-21T15:00:00.000Z";
  const {
    paymentContext,
    pending,
    pendingUpdates,
    userUpdates,
    getUserCreates,
  } = mockExistingRegistrationUser(t, {
    purchasedPlan: "pro",
    months: 3,
    approvedAt: "2098-08-21T15:00:00.000Z",
    currentPlan: "basic",
    currentExpiresAt: null,
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(getUserCreates(), 0);
  assert.equal(userUpdates.length, 1);
  const entitlementUpdate = userUpdates[0].update.$set || userUpdates[0].update;
  assert.equal(entitlementUpdate.subscription, "pro");
  assert.equal(
    entitlementUpdate.subscriptionExpiresAt.toISOString(),
    purchasedExpiry
  );
  assert.equal(pendingUpdates.length, 1);
  assert.equal(pending.status, "completed");
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.entitlementStatus, "applied");
  assert.equal(transaction.appliedPlanId, "pro");
  assert.equal(transaction.subscriptionExpiresAtBefore, null);
  assert.equal(
    transaction.subscriptionExpiresAtAfter.toISOString(),
    purchasedExpiry
  );
  assert.equal(paymentContext.crmUpdates.length, 1);
});

test("un update crítico nulo del pending no marca el pago como aplicado", async (t) => {
  const previousSecret = process.env.PENDING_REGISTRATION_SECRET;
  process.env.PENDING_REGISTRATION_SECRET = "secret-de-prueba-con-mas-de-32-caracteres";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.PENDING_REGISTRATION_SECRET;
    else process.env.PENDING_REGISTRATION_SECRET = previousSecret;
  });
  const paymentContext = mockCommon(t, approvedPayment({
    external_reference: PENDING_REGISTRATION_ID,
    metadata: { plan_id: "basic", months: 3, type: "registration" },
  }));
  const pending = {
    _id: PENDING_REGISTRATION_ID,
    status: "pending",
    username: "pending-desaparecido",
    ...encryptPendingPassword("password-seguro"),
    contactInfo: { mail: "missing@example.com", businessName: "Missing" },
    months: 3,
    preferenceId: PREFERENCE_ID,
  };
  t.mock.method(PendingRegistration, "findById", () => ({
    select: async () => pending,
  }));
  t.mock.method(PendingRegistration, "findByIdAndUpdate", async () => null);
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  t.mock.method(User, "exists", async () => null);
  let userCreates = 0;
  t.mock.method(User, "create", async (data) => {
    userCreates += 1;
    return { _id: NEW_USER_ID, ...data };
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 500);
  assert.equal(userCreates, 1);
  assert.notEqual(
    paymentContext.getTransaction().entitlementStatus,
    "applied"
  );
  assert.equal(paymentContext.crmUpdates.length, 0);
});

test("el alta encadena pending, aprobación, completed y sesión autenticada", async (t) => {
  const previousPendingSecret = process.env.PENDING_REGISTRATION_SECRET;
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.PENDING_REGISTRATION_SECRET = "secret-de-prueba-con-mas-de-32-caracteres";
  process.env.JWT_SECRET = "jwt-secret-de-prueba";
  t.after(() => {
    if (previousPendingSecret === undefined) delete process.env.PENDING_REGISTRATION_SECRET;
    else process.env.PENDING_REGISTRATION_SECRET = previousPendingSecret;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  });
  const registrationToken = "d".repeat(64);
  const activationTokenHash = crypto
    .createHash("sha256")
    .update(registrationToken)
    .digest("hex");
  const paymentData = approvedPayment({
    status: "in_process",
    status_detail: "pending_review_manual",
    date_approved: null,
    external_reference: PENDING_REGISTRATION_ID,
    metadata: { plan_id: "basic", months: 3, type: "registration" },
  });
  const paymentContext = mockCommon(t, paymentData);
  const pending = {
    _id: PENDING_REGISTRATION_ID,
    status: "pending",
    username: "flujo-encadenado",
    ...encryptPendingPassword("password-seguro"),
    contactInfo: {
      mail: "flow@example.com",
      businessName: "Flujo Encadenado",
    },
    months: 3,
    preferenceId: PREFERENCE_ID,
    activationTokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  t.mock.method(PendingRegistration, "findOneAndUpdate", async (filter, update) => {
    assert.deepEqual(filter, {
      _id: PENDING_REGISTRATION_ID,
      status: "pending",
    });
    applyMockUpdate(pending, update);
    return pending;
  });
  t.mock.method(PendingRegistration, "findById", () => ({
    select: async () => pending,
  }));
  t.mock.method(PendingRegistration, "findByIdAndUpdate", async (id, update) => {
    assert.equal(id, PENDING_REGISTRATION_ID);
    applyMockUpdate(pending, update);
    return pending;
  });
  const statusFilters = [];
  t.mock.method(PendingRegistration, "findOne", (filter) => {
    statusFilters.push(filter);
    const tokenMatches = filter.activationTokenHash === pending.activationTokenHash;
    const expiryMatches = !filter.expiresAt
      || pending.expiresAt > filter.expiresAt.$gt;
    return {
      select: async () => (tokenMatches && expiryMatches ? pending : null),
    };
  });
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  t.mock.method(User, "exists", async () => null);
  let userCreates = 0;
  let createdUser = null;
  t.mock.method(User, "create", async (data) => {
    userCreates += 1;
    createdUser = {
      _id: NEW_USER_ID,
      ...data,
      active: true,
      admin: false,
    };
    return createdUser;
  });
  let userReads = 0;
  t.mock.method(User, "findById", () => ({
    select: async () => {
      userReads += 1;
      return createdUser;
    },
  }));

  const pendingWebhookResponse = response();
  await mpWebhook(request(), pendingWebhookResponse);

  assert.equal(pendingWebhookResponse.statusCode, 200);
  assert.equal(pending.status, "pending");
  assert.equal(pending.paymentStatus, "in_process");
  assert.equal(paymentContext.getTransaction().entitlementStatus, "not_applied");
  assert.equal(userCreates, 0);

  const pendingStatusResponse = response();
  await getRegistrationStatus(
    { body: { registrationToken } },
    pendingStatusResponse
  );

  assert.deepEqual(pendingStatusResponse.body, {
    status: "pending",
    paymentStatus: "in_process",
    paymentStatusDetail: "pending_review_manual",
  });
  assert.equal(userReads, 0);

  paymentData.status = "approved";
  paymentData.status_detail = "accredited";
  paymentData.date_approved = "2099-08-21T15:00:00.000Z";
  paymentData.date_last_updated = "2099-08-21T15:00:01.000Z";
  const approvedWebhookResponse = response();
  await mpWebhook(request(), approvedWebhookResponse);

  assert.equal(approvedWebhookResponse.statusCode, 200);
  assert.equal(userCreates, 1);
  assert.equal(pending.status, "completed");
  assert.equal(pending.userID, NEW_USER_ID);
  assert.equal(pending.paymentID, "payment-123");
  assert.equal(pending.paymentStatus, "approved");
  assert.equal(pending.passwordCiphertext, undefined);
  assert.equal(pending.passwordIV, undefined);
  assert.equal(pending.passwordAuthTag, undefined);

  const completedStatusResponse = response();
  await getRegistrationStatus(
    { body: { registrationToken } },
    completedStatusResponse
  );

  assert.equal(completedStatusResponse.body.status, "completed");
  assert.equal(completedStatusResponse.body.auth._id, NEW_USER_ID);
  assert.equal(completedStatusResponse.body.auth.username, "flujo-encadenado");
  assert.equal(completedStatusResponse.body.auth.admin, false);
  assert.equal(completedStatusResponse.body.auth.slug, "flujo-encadenado");
  assert.equal(completedStatusResponse.body.auth.subscription, "basic");
  assert.equal(
    completedStatusResponse.body.auth.subscriptionExpiresAt.toISOString(),
    "2099-11-21T15:00:00.000Z"
  );
  assert.equal(
    jwt.verify(completedStatusResponse.body.auth.token, process.env.JWT_SECRET).id,
    NEW_USER_ID
  );
  assert.equal(userReads, 1);
  assert.equal(statusFilters.length, 2);
  assert.ok(statusFilters.every((filter) => (
    filter.activationTokenHash === activationTokenHash
    && filter.expiresAt?.$gt instanceof Date
  )));
  assert.equal(paymentContext.getTransaction().entitlementStatus, "applied");
  assert.equal(paymentContext.crmUpdates.length, 1);
});

test("un alta paga crea el usuario con plan y vencimiento correctos", async (t) => {
  const previousSecret = process.env.PENDING_REGISTRATION_SECRET;
  process.env.PENDING_REGISTRATION_SECRET = "secret-de-prueba-con-mas-de-32-caracteres";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.PENDING_REGISTRATION_SECRET;
    else process.env.PENDING_REGISTRATION_SECRET = previousSecret;
  });
  const paymentContext = mockCommon(t, approvedPayment({
    external_reference: PENDING_REGISTRATION_ID,
    metadata: { plan_id: "pro", months: 12, type: "registration" },
  }));
  const pending = {
    _id: PENDING_REGISTRATION_ID,
    status: "pending",
    username: "restaurante-test",
    ...encryptPendingPassword("password-seguro"),
    contactInfo: { mail: "test@example.com", businessName: "Restaurante Test" },
    months: 12,
    preferenceId: PREFERENCE_ID,
  };
  t.mock.method(PendingRegistration, "findById", () => ({
    select: async () => pending,
  }));
  let pendingUpdate;
  t.mock.method(PendingRegistration, "findByIdAndUpdate", async (id, update) => {
    pendingUpdate = { id, update };
    applyMockUpdate(pending, update);
    return pending;
  });
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  t.mock.method(User, "exists", async () => null);
  let created;
  t.mock.method(User, "create", async (data) => {
    created = data;
    return { _id: NEW_USER_ID };
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(created.password, "password-seguro");
  assert.equal(created.subscription, "pro");
  assert.equal(created.subscriptionExpiresAt.toISOString(), "2027-08-21T15:00:00.000Z");
  assert.equal(pendingUpdate.id, PENDING_REGISTRATION_ID);
  assert.deepEqual(pendingUpdate.update.$unset, {
    password: 1,
    passwordCiphertext: 1,
    passwordIV: 1,
    passwordAuthTag: 1,
  });
  const transaction = paymentContext.getTransaction();
  assert.equal(transaction.entitlementStatus, "applied");
  assert.equal(transaction.entitlementReason, null);
  assert.ok(transaction.entitlementAppliedAt instanceof Date);
  assert.equal(transaction.appliedPlanId, "pro");
  assert.equal(transaction.appliedMonths, 12);
  assert.equal(transaction.userID, NEW_USER_ID);
  assert.equal(transaction.pendingRegistrationID, PENDING_REGISTRATION_ID);
  assert.equal(transaction.preferenceId, PREFERENCE_ID);
  assert.equal(transaction.subscriptionExpiresAtBefore, null);
  assert.equal(
    transaction.subscriptionExpiresAtAfter.toISOString(),
    "2027-08-21T15:00:00.000Z"
  );
  assert.equal(paymentContext.crmUpdates.length, 1);
});

test("un alta completada recupera la finalización sin recrear usuario ni CRM", async (t) => {
  const previousSecret = process.env.PENDING_REGISTRATION_SECRET;
  process.env.PENDING_REGISTRATION_SECRET = "secret-de-prueba-con-mas-de-32-caracteres";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.PENDING_REGISTRATION_SECRET;
    else process.env.PENDING_REGISTRATION_SECRET = previousSecret;
  });
  const paymentContext = mockCommon(t, approvedPayment({
    date_approved: null,
    external_reference: PENDING_REGISTRATION_ID,
    metadata: { plan_id: "basic", months: 3, type: "registration" },
  }), {
    markAppliedErrorOnce: new Error("Falla al finalizar el alta"),
  });
  const pending = {
    _id: PENDING_REGISTRATION_ID,
    status: "pending",
    username: "restaurante-recovery",
    ...encryptPendingPassword("password-seguro"),
    contactInfo: { mail: "recovery@example.com", businessName: "Recovery" },
    months: 3,
    preferenceId: PREFERENCE_ID,
  };
  let pendingReads = 0;
  let pendingUpdates = 0;
  t.mock.method(PendingRegistration, "findById", () => ({
    select: async () => {
      pendingReads += 1;
      return pending;
    },
  }));
  t.mock.method(PendingRegistration, "findByIdAndUpdate", async (id, update) => {
    pendingUpdates += 1;
    assert.equal(id, PENDING_REGISTRATION_ID);
    applyMockUpdate(pending, update);
    return pending;
  });
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  t.mock.method(User, "exists", async () => null);
  let userCreates = 0;
  let createdUser = null;
  t.mock.method(User, "create", async (data) => {
    userCreates += 1;
    createdUser = { _id: NEW_USER_ID, ...data };
    return createdUser;
  });
  let userReads = 0;
  t.mock.method(User, "findById", () => ({
    select: async () => {
      userReads += 1;
      return createdUser;
    },
  }));

  const firstResponse = response();
  await mpWebhook(request(), firstResponse);

  assert.equal(firstResponse.statusCode, 500);
  assert.equal(pending.status, "completed");
  assert.equal(pending.paymentID, "payment-123");
  assert.equal(userCreates, 1);
  assert.equal(paymentContext.crmUpdates.length, 0);
  const preparedExpiry = paymentContext
    .getTransaction()
    .subscriptionExpiresAtAfter.toISOString();
  assert.equal(createdUser.subscriptionExpiresAt.toISOString(), preparedExpiry);
  // El estado actual del usuario puede haber avanzado después del alta. La
  // atribución histórica debe salir del pago/contexto durable, no revertirlo.
  createdUser.subscription = "pro";
  createdUser.subscriptionExpiresAt = new Date("2027-12-01T00:00:00.000Z");

  const recoveryResponse = response();
  await mpWebhook(request(), recoveryResponse);

  assert.equal(recoveryResponse.statusCode, 200);
  assert.equal(userCreates, 1);
  assert.equal(userReads, 1);
  assert.equal(pendingReads, 2);
  assert.equal(pendingUpdates, 1);
  assert.equal(paymentContext.crmUpdates.length, 1);
  const recoveredTransaction = paymentContext.getTransaction();
  assert.equal(recoveredTransaction.entitlementStatus, "applied");
  assert.equal(recoveredTransaction.entitlementReason, null);
  assert.equal(recoveredTransaction.appliedPlanId, "basic");
  assert.equal(recoveredTransaction.appliedMonths, 3);
  assert.equal(recoveredTransaction.userID, NEW_USER_ID);
  assert.equal(recoveredTransaction.pendingRegistrationID, PENDING_REGISTRATION_ID);
  assert.equal(recoveredTransaction.preferenceId, PREFERENCE_ID);
  assert.equal(
    recoveredTransaction.subscriptionExpiresAtAfter.toISOString(),
    preparedExpiry
  );
  const appliedAt = recoveredTransaction.entitlementAppliedAt.getTime();

  const duplicateResponse = response();
  await mpWebhook(request(), duplicateResponse);

  assert.equal(duplicateResponse.statusCode, 200);
  assert.equal(userCreates, 1);
  assert.equal(userReads, 1);
  assert.equal(pendingReads, 2);
  assert.equal(pendingUpdates, 1);
  assert.equal(paymentContext.crmUpdates.length, 1);
  assert.equal(
    paymentContext.getTransaction().entitlementAppliedAt.getTime(),
    appliedAt
  );
});
