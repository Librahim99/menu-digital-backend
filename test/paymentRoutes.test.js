const test = require("node:test");
const assert = require("node:assert/strict");
const { RestClient } = require("mercadopago/dist/utils/restClient");

const User = require("../src/models/User");
const PendingRegistration = require("../src/models/PendingRegistration");
const PaymentCheckout = require("../src/models/PaymentCheckout");
const Plan = require("../src/models/Plan");
const catalog = require("../src/services/planCatalog");
const planController = require("../src/controllers/planController");
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
  set() { return this; },
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
  planVersion: 0,
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
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan({ ...catalog.INITIAL_PLANS.find(plan => plan.name === name), __v: 0 }));
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
};

for (const path of ["/crear-preferencia", "/crear-preferencia-registro"]) {
  test(`${path}: rechaza una versión vieja o ausente antes de persistir o llamar MercadoPago`, async (t) => {
    silencePaymentLogs(t);
    t.mock.method(User, "findOne", async () => assert.fail("No debe buscar identidad antes de aceptar el catálogo"));
    t.mock.method(PendingRegistration.prototype, "save", async () => assert.fail("No debe guardar un registro"));
    t.mock.method(PaymentCheckout, "create", async () => assert.fail("No debe crear checkout"));
    t.mock.method(RestClient, "fetch", async () => assert.fail("No debe llamar MercadoPago"));
    for (const planVersion of [undefined, -1, "0", 99]) {
      const res = createResponse();
      await getHandler(path)({ user: { subscription: "free" }, body: createRegistrationBody({ planVersion }) }, res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, "PLAN_PRICE_CHANGED");
    }
  });

  test(`${path}: una caída de MongoDB bloquea el cobro sin usar importes iniciales`, async (t) => {
    silencePaymentLogs(t);
    t.mock.method(Plan, "findOne", async () => { throw new Error("DB unavailable"); });
    t.mock.method(PaymentCheckout, "create", async () => assert.fail("No debe crear checkout"));
    t.mock.method(RestClient, "fetch", async () => assert.fail("No debe llamar MercadoPago"));
    const res = createResponse();
    await getHandler(path)({ user: { subscription: "free" }, body: createRegistrationBody() }, res);
    assert.equal(res.statusCode, 503);
  });
}

test("upgrade y renovación cotizan todos los períodos desde MongoDB y guardan ese importe", async (t) => {
  silencePaymentLogs(t);
  let saved, sent;
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan({
    ...catalog.INITIAL_PLANS.find(plan => plan.name === name), price: 61000, discountPrice: 45000,
    periodMultipliers: { 1: 1, 3: 2.5, 6: 4.5, 12: 8 }, __v: 7,
  }));
  t.mock.method(PaymentCheckout, "create", async snapshot => { saved = snapshot; return { ...snapshot, _id: AUTH_CHECKOUT_ID }; });
  t.mock.method(PaymentCheckout, "findByIdAndUpdate", async () => ({ _id: AUTH_CHECKOUT_ID }));
  t.mock.method(RestClient, "fetch", async (_url, config) => {
    sent = JSON.parse(config.body);
    return { id: "preference", init_point: "https://mercadopago.test/preference" };
  });
  for (const planId of ["basic", "pro"]) {
    for (const [months, multiplier] of [[1, 1], [3, 2.5], [6, 4.5], [12, 8]]) {
      for (const subscription of ["free", planId]) {
        const res = createResponse();
        await getHandler("/crear-preferencia")({ user: { _id: "owner", subscription }, body: { planId, months, planVersion: 7, amount: 1 } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(saved.expectedAmount, Math.round(45000 * multiplier));
        assert.equal(sent.items[0].unit_price, saved.expectedAmount);
        assert.equal(saved.planVersion, 7);
        assert.equal(saved.operation, subscription === "free" ? "upgrade" : "renewal");
      }
    }
  }
});

test("cambiar solo multiplicadores exige reconfirmar y conserva el importe de checkouts anteriores", async (t) => {
  silencePaymentLogs(t);
  const stored = new Plan({ ...catalog.INITIAL_PLANS[1], price: 10000, __v: 0 });
  t.mock.method(Plan, "findOne", async () => stored);
  t.mock.method(stored, "save", async () => { await stored.validate(); stored.__v += 1; return stored; });
  const snapshots = [];
  const sentAmounts = [];
  t.mock.method(PaymentCheckout, "create", async snapshot => {
    snapshots.push(structuredClone(snapshot));
    return { ...snapshot, _id: `${AUTH_CHECKOUT_ID}-${snapshots.length}` };
  });
  t.mock.method(PaymentCheckout, "findByIdAndUpdate", async (_id, update) => {
    assert.equal(update.$set.expectedAmount, undefined);
    assert.equal(update.$set.planVersion, undefined);
    return { _id };
  });
  t.mock.method(RestClient, "fetch", async (_url, config) => {
    sentAmounts.push(JSON.parse(config.body).items[0].unit_price);
    return { id: "preference", init_point: "https://mercadopago.test/preference" };
  });
  const req = { user: { _id: "owner", subscription: "free" }, body: { planId: "basic", months: 3, planVersion: 0 } };
  const initial = createResponse();
  await getHandler("/crear-preferencia")(req, initial);
  assert.equal(initial.statusCode, 200);
  const edited = createResponse();
  await planController.updatePlan({ params: { name: "basic" }, user: { _id: "64f000000000000000000123" }, body: {
    price: stored.price, discountPrice: null, label: stored.label, description: stored.description,
    features: stored.features.toObject(), version: 0, periodMultipliers: { 1: 1, 3: 2.4, 6: 5, 12: 9 },
  } }, edited);
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.body.plan.version, 1);
  for (const path of ["/crear-preferencia", "/crear-preferencia-registro"]) {
    const stale = createResponse();
    await getHandler(path)({ user: req.user, body: createRegistrationBody({ ...req.body }) }, stale);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.code, "PLAN_PRICE_CHANGED");
  }
  assert.equal(snapshots.length, 1);
  assert.deepEqual(sentAmounts, [27000]);
  const confirmed = createResponse();
  await getHandler("/crear-preferencia")({ ...req, body: { ...req.body, planVersion: 1 } }, confirmed);
  assert.equal(confirmed.statusCode, 200);
  assert.deepEqual(sentAmounts, [27000, 24000]);
  assert.deepEqual(snapshots.map(snapshot => [snapshot.expectedAmount, snapshot.planVersion]), [[27000, 0], [24000, 1]]);
});

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
      body: { planId: "basic", months: 1, planVersion: 0 },
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
      planVersion: 0,
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
