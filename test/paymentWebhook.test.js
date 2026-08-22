const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { Payment } = require("mercadopago");
const User = require("../src/models/User");
const PendingRegistration = require("../src/models/PendingRegistration");
const CrmProfile = require("../src/models/CrmProfile");
const { getRegistrationStatus, mpWebhook } = require("../src/controllers/paymentController");
const { encryptPendingPassword } = require("../src/utils/pendingCredentials");

function request() {
  return {
    query: { "data.id": "payment-123", type: "payment" },
    body: {},
    headers: {},
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
    status: "approved",
    external_reference: "user-123",
    date_approved: "2026-08-21T15:00:00.000Z",
    metadata: {
      plan_id: "basic",
      months: 3,
      type: "upgrade",
      payment_mode: "upgrade",
    },
    ...overrides,
  };
}

function mockCommon(t, paymentData) {
  const previousSecret = process.env.MP_WEBHOOK_SECRET;
  delete process.env.MP_WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.MP_WEBHOOK_SECRET;
    else process.env.MP_WEBHOOK_SECRET = previousSecret;
  });
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(Payment.prototype, "get", async () => paymentData);
  t.mock.method(CrmProfile, "findOneAndUpdate", async () => ({}));
}

function mockExistingUser(t, previousUser, updates) {
  t.mock.method(User, "findById", () => ({
    select: async () => previousUser,
  }));
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => {
    updates.push({ id, update });
    return {};
  });
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

test("upgrade aprobado actualiza plan y vencimiento según los meses pagados", async (t) => {
  mockCommon(t, approvedPayment());
  const updates = [];
  mockExistingUser(t, { subscription: "free", subscriptionExpiresAt: null }, updates);

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.subscription, "basic");
  assert.equal(updates[0].update.subscriptionExpiresAt.toISOString(), "2026-11-21T15:00:00.000Z");
});

test("renovación anticipada suma meses desde el vencimiento vigente", async (t) => {
  mockCommon(t, approvedPayment({
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
  mockCommon(t, approvedPayment({
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
  await mpWebhook(request(), response());

  assert.equal(updates.length, 2);
  assert.equal(
    updates[0].update.subscriptionExpiresAt.toISOString(),
    updates[1].update.subscriptionExpiresAt.toISOString()
  );
  assert.equal(updates[0].update.subscriptionExpiresAt.toISOString(), "2027-06-15T15:00:00.000Z");
});

test("un pago pendiente no modifica la suscripción", async (t) => {
  mockCommon(t, approvedPayment({ status: "pending" }));
  let updates = 0;
  t.mock.method(User, "findByIdAndUpdate", async () => { updates += 1; });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updates, 0);
});

test("un pago rechazado guarda el estado de MercadoPago sin cerrar el alta", async (t) => {
  mockCommon(t, approvedPayment({
    id: 987654,
    status: "rejected",
    status_detail: "cc_rejected_other_reason",
    date_last_updated: "2026-08-21T15:05:00.000Z",
    external_reference: "pending-123",
    metadata: { plan_id: "basic", months: 1, type: "registration" },
  }));
  let persisted;
  t.mock.method(PendingRegistration, "findOneAndUpdate", async (filter, update) => {
    persisted = { filter, update };
    return {};
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(persisted.filter, { _id: "pending-123", status: "pending" });
  assert.equal(persisted.update.$set.paymentID, "987654");
  assert.equal(persisted.update.$set.paymentStatus, "rejected");
  assert.equal(persisted.update.$set.paymentStatusDetail, "cc_rejected_other_reason");
  assert.equal(
    persisted.update.$set.paymentUpdatedAt.toISOString(),
    "2026-08-21T15:05:00.000Z"
  );
});

test("un error interno devuelve 500 para que MercadoPago reintente", async (t) => {
  const previousSecret = process.env.MP_WEBHOOK_SECRET;
  delete process.env.MP_WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.MP_WEBHOOK_SECRET;
    else process.env.MP_WEBHOOK_SECRET = previousSecret;
  });
  t.mock.method(console, "warn", () => {});
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
  mockCommon(t, approvedPayment({
    metadata: { plan_id: "basic", months: 2, type: "upgrade" },
  }));
  let updates = 0;
  t.mock.method(User, "findByIdAndUpdate", async () => { updates += 1; });

  await mpWebhook(request(), response());

  assert.equal(updates, 0);
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

test("una firma inválida devuelve 401 antes de consultar el pago", async (t) => {
  const previousSecret = process.env.MP_WEBHOOK_SECRET;
  process.env.MP_WEBHOOK_SECRET = "webhook-secret";
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

test("un upgrade aprobado para un usuario inexistente no crea cuentas", async (t) => {
  mockCommon(t, approvedPayment());
  t.mock.method(User, "findById", () => ({ select: async () => null }));
  let updates = 0;
  let creates = 0;
  t.mock.method(User, "findByIdAndUpdate", async () => { updates += 1; });
  t.mock.method(User, "create", async () => { creates += 1; });

  await mpWebhook(request(), response());

  assert.equal(updates, 0);
  assert.equal(creates, 0);
});

test("un alta paga crea el usuario con plan y vencimiento correctos", async (t) => {
  const previousSecret = process.env.PENDING_REGISTRATION_SECRET;
  process.env.PENDING_REGISTRATION_SECRET = "secret-de-prueba-con-mas-de-32-caracteres";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.PENDING_REGISTRATION_SECRET;
    else process.env.PENDING_REGISTRATION_SECRET = previousSecret;
  });
  mockCommon(t, approvedPayment({
    external_reference: "pending-123",
    metadata: { plan_id: "pro", months: 12, type: "registration" },
  }));
  const pending = {
    _id: "pending-123",
    status: "pending",
    username: "restaurante-test",
    ...encryptPendingPassword("password-seguro"),
    contactInfo: { mail: "test@example.com", businessName: "Restaurante Test" },
    months: 12,
  };
  t.mock.method(PendingRegistration, "findById", () => ({
    select: async () => pending,
  }));
  let pendingUpdate;
  t.mock.method(PendingRegistration, "findByIdAndUpdate", async (id, update) => {
    pendingUpdate = { id, update };
    return {};
  });
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  t.mock.method(User, "exists", async () => null);
  let created;
  t.mock.method(User, "create", async (data) => {
    created = data;
    return { _id: "new-user-123" };
  });

  const res = response();
  await mpWebhook(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(created.password, "password-seguro");
  assert.equal(created.subscription, "pro");
  assert.equal(created.subscriptionExpiresAt.toISOString(), "2027-08-21T15:00:00.000Z");
  assert.deepEqual(pendingUpdate.update.$unset, {
    password: 1,
    passwordCiphertext: 1,
    passwordIV: 1,
    passwordAuthTag: 1,
  });
});
