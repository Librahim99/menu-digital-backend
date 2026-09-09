const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const Seller = require("../src/models/Seller");
const Plan = require("../src/models/Plan");
const PendingServiceAction = require("../src/models/PendingServiceAction");
const mailer = require("../src/utils/mailer");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { registerTrial } = require("../src/controllers/userController");

const validContact = {
  businessName: "Bar de prueba",
  mail: "trial@example.com",
  number: 1123456789,
};

const seller = {
  _id: "64f000000000000000000999",
  code: "LZD-264",
};

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

// Mismo recipe que paymentWebhook.test.js (mockEmailVerificationCode): el
// alta dispara sendEmailVerificationCode → createPendingServiceAction → un
// código de 6 dígitos por mail, best-effort. Se mockea para no pegarle a
// Mongo/SMTP real ni bloquear el 201 si el mail tarda.
function mockEmailVerificationCode(t) {
  t.mock.method(PendingServiceAction, "deleteMany", async () => ({ deletedCount: 0 }));
  t.mock.method(PendingServiceAction, "create", async (data) => ({ _id: "pending-verif-mock", ...data }));
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => {});
}

function mockPlanCatalog(t) {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find((p) => p.name === name)));
}

function baseBody(overrides = {}) {
  return {
    username: "restauranteprueba",
    password: "password-seguro",
    acceptedTerms: true,
    contactInfo: validContact,
    sellerCode: "LZD-264",
    ...overrides,
  };
}

test("registerTrial rechaza username/password ausentes o con tipo incorrecto", async () => {
  for (const body of [
    { ...baseBody(), username: undefined },
    { ...baseBody(), password: 12345678 },
  ]) {
    const res = response();
    await registerTrial({ body }, res);
    assert.equal(res.statusCode, 400);
  }
});

test("registerTrial rechaza un username con guiones (colisiona con la detección de código de vendedor en el login)", async () => {
  const res = response();
  await registerTrial({ body: baseBody({ username: "mi-local" }) }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /guiones/);
});

test("registerTrial rechaza un email de contacto ausente o inválido", async () => {
  for (const mail of [undefined, "", "ididid"]) {
    const res = response();
    await registerTrial({ body: baseBody({ contactInfo: { ...validContact, mail } }) }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /email/i);
  }
});

test("registerTrial exige teléfono de contacto válido", async () => {
  for (const number of [undefined, null, "abc", "123"]) {
    const res = response();
    await registerTrial({ body: baseBody({ contactInfo: { ...validContact, number } }) }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /teléfono/i);
  }
});

test("registerTrial rechaza una contraseña débil", async () => {
  const res = response();
  await registerTrial({ body: baseBody({ password: "12345678" }) }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /contraseña/i);
});

test("registerTrial exige aceptar términos y condiciones", async () => {
  const res = response();
  await registerTrial({ body: baseBody({ acceptedTerms: false }) }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /términos/i);
});

test("registerTrial rechaza sin código de promoción — es lo único que dispara la prueba gratis", async () => {
  for (const sellerCode of [undefined, "", "   "]) {
    const res = response();
    await registerTrial({ body: baseBody({ sellerCode }) }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /código de promoción/i);
  }
});

test("registerTrial rechaza un código de promoción con formato inválido", async (t) => {
  t.mock.method(Seller, "findOne", () => assert.fail("no debe consultar Seller con formato inválido"));
  const res = response();
  await registerTrial({ body: baseBody({ sellerCode: "no-es-un-codigo" }) }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "Código de promoción inválido");
});

test("registerTrial rechaza un código de promoción con formato válido pero inexistente", async (t) => {
  t.mock.method(Seller, "findOne", async () => null);
  const res = response();
  await registerTrial({ body: baseBody({ sellerCode: "zzz-999" }) }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "Código de promoción no encontrado");
});

test("registerTrial rechaza si el username o el email ya están registrados (chequeo fuerte, no solo username)", async (t) => {
  t.mock.method(Seller, "findOne", async () => seller);
  let receivedFilter;
  t.mock.method(User, "findOne", async (filter) => {
    receivedFilter = filter;
    return { _id: "alguien-mas" };
  });

  const res = response();
  await registerTrial({ body: baseBody() }, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(receivedFilter, {
    $or: [{ username: "restauranteprueba" }, { "contactInfo.mail": "trial@example.com" }],
  });
});

test("registerTrial crea la cuenta con Pro por 7 días, sellerID del código y dispara el mail de verificación", async (t) => {
  mockEmailVerificationCode(t);
  mockPlanCatalog(t);
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "jwt-secret-de-prueba";
  t.after(() => {
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  });

  t.mock.method(Seller, "findOne", async () => seller);
  t.mock.method(User, "findOne", async () => null);
  t.mock.method(User, "exists", async () => false);

  const beforeCreation = Date.now();
  let createdData;
  t.mock.method(User, "create", async (data) => {
    createdData = data;
    return { _id: "64f000000000000000000abc", ...data };
  });

  const res = response();
  await registerTrial({ body: baseBody() }, res);
  const afterCreation = Date.now();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.username, "restauranteprueba");
  assert.ok(res.body.token);

  assert.equal(createdData.subscription, "pro");
  assert.equal(createdData.sellerID, seller._id);
  assert.equal(createdData.trialActive, true);
  assert.equal(createdData.emailVerified, false);
  assert.equal(createdData.contactInfo.mail, "trial@example.com");

  const expiresAtMs = createdData.subscriptionExpiresAt.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  assert.ok(expiresAtMs >= beforeCreation + sevenDaysMs);
  assert.ok(expiresAtMs <= afterCreation + sevenDaysMs);
});
