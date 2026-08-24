const test = require("node:test");
const assert = require("node:assert/strict");
const { RestClient } = require("mercadopago/dist/utils/restClient");

const User = require("../src/models/User");
const PendingRegistration = require("../src/models/PendingRegistration");
const PaymentCheckout = require("../src/models/PaymentCheckout");
const { getCheckoutAmount } = require("../src/config/paymentPlans");

process.env.MP_ACCESS_TOKEN = "TEST-token";
process.env.MP_WEBHOOK_URL = "https://backend.test/api/payments/webhook";
process.env.FRONTEND_URL = "https://frontend.test";

const paymentRouter = require("../src/routes/paymentRoutes");

const AUTH_CHECKOUT_ID = "auth-checkout";
const PENDING_ID = "pending-registration";
const OLD_CHECKOUT_ID = "old-checkout";
const NEW_CHECKOUT_ID = "new-checkout";
const OLD_PREFERENCE_ID = "old-preference";
const OLD_INIT_POINT = "https://mercadopago.test/old-preference";

const getHandler = (path) => {
  const routeLayer = paymentRouter.stack.find(
    (layer) => layer.route?.path === path
  );

  assert.ok(routeLayer, `No se encontró la ruta ${path}`);
  return routeLayer.route.stack.at(-1).handle;
};

const createResponse = () => ({
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
});

const createRegistrationBody = (overrides = {}) => ({
  username: "nuevo-local",
  password: "password-seguro",
  acceptedTerms: true,
  contactInfo: {
    mail: "dueno@example.com",
    businessName: "Nuevo Local",
  },
  planId: "pro",
  months: 3,
  ...overrides,
});

const createPending = () => {
  let saveCalls = 0;
  const pending = {
    _id: PENDING_ID,
    username: "nuevo-local",
    password: "password-seguro",
    contactInfo: {
      mail: "dueno@example.com",
      businessName: "Nuevo Local",
    },
    acceptedTerms: true,
    planId: "basic",
    months: 1,
    status: "pending",
    preferenceId: OLD_PREFERENCE_ID,
    initPoint: OLD_INIT_POINT,
    checkoutID: OLD_CHECKOUT_ID,
    async save() {
      saveCalls += 1;
      return this;
    },
  };

  return {
    pending,
    getSaveCalls: () => saveCalls,
  };
};

const mockPendingLookup = (t, pending) => {
  t.mock.method(User, "findOne", async () => null);
  t.mock.method(PendingRegistration, "findOne", () => ({
    select() {
      return this;
    },
    async sort() {
      return pending;
    },
  }));
};

const silencePaymentLogs = (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
};

test(
  "el checkout autenticado envía una idempotencyKey propia",
  { concurrency: false },
  async (t) => {
    silencePaymentLogs(t);
    let sentConfig;

    t.mock.method(PaymentCheckout, "create", async (snapshot) => ({
      _id: AUTH_CHECKOUT_ID,
      status: "creating",
      ...snapshot,
    }));
    t.mock.method(PaymentCheckout, "findByIdAndUpdate", async () => ({
      _id: AUTH_CHECKOUT_ID,
      status: "ready",
    }));
    t.mock.method(RestClient, "fetch", async (_endpoint, config) => {
      sentConfig = config;
      return {
        id: "auth-preference",
        init_point: "https://mercadopago.test/auth-preference",
      };
    });

    const req = {
      body: { planId: "basic", months: 1 },
      user: {
        _id: "user-id",
        subscription: "free",
        subscriptionExpiresAt: null,
      },
    };
    const res = createResponse();

    await getHandler("/crear-preferencia")(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(
      sentConfig.idempotencyKey,
      `subscription-${AUTH_CHECKOUT_ID}`
    );
  }
);

for (const testCase of [
  {
    name: "sin id",
    mercadoPagoResult: {
      init_point: "https://mercadopago.test/new-preference",
    },
  },
  {
    name: "sin init_point",
    mercadoPagoResult: { id: "new-preference" },
  },
]) {
  test(
    `una preferencia de registro nueva ${testCase.name} no reutiliza datos viejos`,
    { concurrency: false },
    async (t) => {
      silencePaymentLogs(t);
      const { pending, getSaveCalls } = createPending();
      const updates = [];
      mockPendingLookup(t, pending);

      t.mock.method(PaymentCheckout, "findById", async () => ({
        _id: OLD_CHECKOUT_ID,
        status: "ready",
        planId: "basic",
        months: 1,
        expectedAmount: getCheckoutAmount("basic", 1),
        currency: "ARS",
      }));
      t.mock.method(PaymentCheckout, "create", async (snapshot) => ({
        _id: NEW_CHECKOUT_ID,
        status: "creating",
        sourcePlan: null,
        ...snapshot,
      }));
      t.mock.method(
        PaymentCheckout,
        "findByIdAndUpdate",
        async (id, update) => {
          updates.push({ id: String(id), status: update.$set.status });
          return { _id: id, status: update.$set.status };
        }
      );
      t.mock.method(
        RestClient,
        "fetch",
        async () => testCase.mercadoPagoResult
      );

      const req = { body: createRegistrationBody() };
      const res = createResponse();

      await getHandler("/crear-preferencia-registro")(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(pending.preferenceId, OLD_PREFERENCE_ID);
      assert.equal(pending.initPoint, OLD_INIT_POINT);
      assert.equal(getSaveCalls(), 0);
      assert.ok(
        updates.some(
          (update) =>
            update.id === NEW_CHECKOUT_ID && update.status === "failed"
        )
      );
      assert.ok(
        !updates.some(
          (update) =>
            update.id === NEW_CHECKOUT_ID && update.status === "ready"
        )
      );
    }
  );
}

test(
  "un update reutilizado conserva los datos guardados si MercadoPago no los repite",
  { concurrency: false },
  async (t) => {
    silencePaymentLogs(t);
    const { pending, getSaveCalls } = createPending();
    let sentEndpoint;
    let sentConfig;
    let readyCheckoutUpdate;
    mockPendingLookup(t, pending);

    t.mock.method(PaymentCheckout, "findById", async () => ({
      _id: OLD_CHECKOUT_ID,
      status: "ready",
      planId: "pro",
      months: 3,
      expectedAmount: getCheckoutAmount("pro", 3),
      currency: "ARS",
      sourcePlan: null,
    }));
    t.mock.method(PaymentCheckout, "create", async () => {
      throw new Error("No debe crear otro checkout cuando puede reutilizarlo");
    });
    t.mock.method(
      PaymentCheckout,
      "findByIdAndUpdate",
      async (id, update) => {
        readyCheckoutUpdate = update.$set;
        return { _id: id, status: update.$set.status };
      }
    );
    t.mock.method(RestClient, "fetch", async (endpoint, config) => {
      sentEndpoint = endpoint;
      sentConfig = config;
      return {};
    });

    const req = { body: createRegistrationBody() };
    const res = createResponse();

    await getHandler("/crear-preferencia-registro")(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.init_point, OLD_INIT_POINT);
    assert.equal(res.body.reused, true);
    assert.equal(pending.preferenceId, OLD_PREFERENCE_ID);
    assert.equal(pending.initPoint, OLD_INIT_POINT);
    assert.equal(getSaveCalls(), 1);
    assert.equal(readyCheckoutUpdate.preferenceId, OLD_PREFERENCE_ID);
    assert.equal(readyCheckoutUpdate.initPoint, OLD_INIT_POINT);
    assert.equal(readyCheckoutUpdate.status, "ready");
    assert.equal(sentEndpoint, `/checkout/preferences/${OLD_PREFERENCE_ID}`);
    assert.equal(sentConfig.method, "PUT");
    assert.match(
      sentConfig.idempotencyKey,
      /^registration-update-[0-9a-f-]{36}$/
    );
  }
);
