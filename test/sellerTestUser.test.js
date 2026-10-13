const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const Seller = require("../src/models/Seller");
const User = require("../src/models/User");
const Plan = require("../src/models/Plan");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { createSellerTestUser } = require("../src/controllers/sellerController");
const { generateAuthToken } = require("../src/utils/authToken");

const SELLER_ID = "64f000000000000000000401";

const seller = {
  _id: SELLER_ID,
  name: "Carla",
  mail: "Carla@Example.com",
  number: 5491123456789,
  active: true,
};

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

function request(body = {}) {
  return {
    params: { id: SELLER_ID },
    body: { username: "DemoCarla", password: "clave-de-demo", ...body },
  };
}

function mockSeller(t, found) {
  t.mock.method(Seller, "findById", () => ({ select: async () => found }));
}

function mockUserLookup(t, found) {
  const calls = {};
  t.mock.method(User, "findOne", (filter) => {
    calls.filter = filter;
    return { select: async () => found };
  });
  return calls;
}

function mockPlanCatalog(t) {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find((p) => p.name === name)));
}

function forbidCreation(t) {
  t.mock.method(User, "create", () => assert.fail("no debe crear una cuenta"));
}

test("createSellerTestUser crea una cuenta de comercio Pro sin vencimiento, con mail, teléfono y sellerID del vendedor", async (t) => {
  mockSeller(t, seller);
  const lookup = mockUserLookup(t, null);
  mockPlanCatalog(t);
  let created;
  t.mock.method(User, "create", async (data) => {
    created = data;
    return { _id: "64f000000000000000000abc", ...data };
  });

  const res = response();
  await createSellerTestUser(request(), res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(lookup.filter, {
    $or: [{ username: "democarla" }, { "contactInfo.mail": "carla@example.com" }],
  });

  assert.equal(created.username, "democarla");
  assert.equal(created.password, "clave-de-demo");
  assert.equal(created.subscription, "pro");
  assert.equal(created.subscriptionExpiresAt, null);
  assert.equal(created.sellerID, SELLER_ID);
  // La marca que la deja afuera de todas las estadísticas (utils/testUsers.js).
  assert.equal(created.testUser, true);
  assert.equal(created.emailVerified, true);
  assert.deepEqual(created.contactInfo, { mail: "carla@example.com", number: 1123456789 });

  // Vacía como un alta normal: sin nombre de negocio no hay slug, y no es ni
  // prueba de 7 días, ni lead de influencer, ni admin.
  assert.equal(created.slug, undefined);
  for (const field of ["trialActive", "influencerReferral", "assignedSeller", "admin", "menu"]) {
    assert.equal(created[field], undefined, `${field} debe quedar en su default`);
  }

  assert.deepEqual(res.body.user, {
    _id: "64f000000000000000000abc",
    username: "democarla",
    mail: "carla@example.com",
    number: 1123456789,
    subscription: "pro",
    subscriptionExpiresAt: null,
    sellerID: SELLER_ID,
  });
  assert.equal(JSON.stringify(res.body).includes("clave-de-demo"), false);
});

test("createSellerTestUser deja el teléfono vacío si el vendedor no tiene", async (t) => {
  mockSeller(t, { ...seller, number: null });
  mockUserLookup(t, null);
  mockPlanCatalog(t);
  let created;
  t.mock.method(User, "create", async (data) => {
    created = data;
    return { _id: "64f000000000000000000abc", ...data };
  });

  const res = response();
  await createSellerTestUser(request(), res);

  assert.equal(res.statusCode, 201);
  assert.equal(created.contactInfo.number, null);
});

test("createSellerTestUser valida usuario y contraseña antes de consultar la base", async (t) => {
  t.mock.method(Seller, "findById", () => assert.fail("no debe consultar el vendedor"));
  forbidCreation(t);

  const cases = [
    [{ username: undefined }, /obligatorios/],
    [{ username: ["demo"] }, /obligatorios/],
    [{ username: "   " }, /obligatorios/],
    [{ password: 12345678 }, /obligatorios/],
    [{ username: "demo-carla" }, /guiones/],
    [{ password: "corta" }, /8 caracteres/],
    [{ password: "12345678" }, /8 caracteres/],
  ];
  for (const [body, message] of cases) {
    const res = response();
    await createSellerTestUser(request(body), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, message);
  }
});

test("createSellerTestUser responde 404 si el vendedor no existe", async (t) => {
  mockSeller(t, null);
  forbidCreation(t);

  const res = response();
  await createSellerTestUser(request(), res);

  assert.equal(res.statusCode, 404);
});

test("createSellerTestUser no crea cuentas para un vendedor dado de baja ni con un mail inválido", async (t) => {
  forbidCreation(t);
  t.mock.method(User, "findOne", () => assert.fail("no debe buscar duplicados"));

  mockSeller(t, { ...seller, active: false });
  const inactiveRes = response();
  await createSellerTestUser(request(), inactiveRes);
  assert.equal(inactiveRes.statusCode, 400);
  assert.match(inactiveRes.body.message, /dado de baja/);

  mockSeller(t, { ...seller, mail: "sin-arroba" });
  const mailRes = response();
  await createSellerTestUser(request(), mailRes);
  assert.equal(mailRes.statusCode, 400);
  assert.match(mailRes.body.message, /mail válido/);
});

test("createSellerTestUser responde 409 si el username o el mail del vendedor ya tienen cuenta", async (t) => {
  mockSeller(t, seller);
  forbidCreation(t);

  mockUserLookup(t, { username: "democarla" });
  const usernameRes = response();
  await createSellerTestUser(request(), usernameRes);
  assert.equal(usernameRes.statusCode, 409);
  assert.match(usernameRes.body.message, /username ya está en uso/);

  mockUserLookup(t, { username: "otracuenta" });
  const mailRes = response();
  await createSellerTestUser(request(), mailRes);
  assert.equal(mailRes.statusCode, 409);
  assert.match(mailRes.body.message, /mail del vendedor \(usuario otracuenta\)/);
});

test("createSellerTestUser traduce el duplicado del índice unique a un 409", async (t) => {
  mockSeller(t, seller);
  mockUserLookup(t, null);
  mockPlanCatalog(t);
  t.mock.method(User, "create", async () => {
    throw Object.assign(new Error("E11000 duplicate key"), { code: 11000, keyPattern: { username: 1 } });
  });

  const res = response();
  await createSellerTestUser(request(), res);

  assert.equal(res.statusCode, 409);
});

// La ruta real, con su cadena de middlewares: solo un admin llega al controller.
test("POST /api/admin/sellers/:id/test-user exige sesión de admin", async (t) => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "jwt-secret-de-prueba";
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  });

  const plainUser = { _id: "64f000000000000000000202", admin: false, active: true, emailVerified: true };
  t.mock.method(User, "findById", () => ({ select: async () => plainUser }));
  t.mock.method(Seller, "findById", () => assert.fail("un no-admin no debe llegar al controller"));
  forbidCreation(t);

  const app = express();
  app.use(express.json());
  app.use("/api/admin/sellers", require("../src/routes/sellerRoutes"));
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/admin/sellers/${SELLER_ID}/test-user`;
  const post = (headers = {}) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ username: "democarla", password: "clave-de-demo" }),
  });

  assert.equal((await post()).status, 401);
  assert.equal((await post({ authorization: `Bearer ${generateAuthToken(plainUser._id)}` })).status, 403);
});
