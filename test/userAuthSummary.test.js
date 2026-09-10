const test = require("node:test");
const assert = require("node:assert/strict");
const Plan = require("../src/models/Plan");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const { getAuthUserSummary } = require("../src/controllers/userController");

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

// Encadena .select() como lo hace el controller, capturando la proyección
// pedida para poder chequear que no incluye password ni el resto del user.
function userFindByIdQuery(user, calls) {
  return {
    select(fields) {
      calls.select = fields;
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(user).then(resolve, reject);
    },
  };
}

test("getAuthUserSummary devuelve solo los 7 campos livianos del dashboard, sin password ni el resto del user", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find(plan => plan.name === name)));

  const user = {
    _id: "64f000000000000000000123",
    slug: "cafe-de-prueba",
    hasDelivery: true,
    template: 1,
    subscription: "pro",
    subscriptionExpiresAt: null,
    contactInfo: { businessName: "Café de prueba" },
    media: { backgroundPicture: "https://example.com/fondo.jpg" },
  };
  const calls = {};
  t.mock.method(User, "findById", () => userFindByIdQuery(user, calls));
  t.mock.method(Menu, "find", async () => [
    { _id: "menu-1", section: false },
    { _id: "menu-2", section: true }, // sección: no cuenta como categoría
  ]);
  t.mock.method(Item, "countDocuments", async () => 4);

  const res = response();
  await getAuthUserSummary({ user: { _id: user._id } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    slug: "cafe-de-prueba",
    hasDelivery: true,
    template: 1,
    itemCount: 4,
    categoryCount: 1,
    contactInfo: { businessName: "Café de prueba" },
    media: { backgroundPicture: "https://example.com/fondo.jpg" },
  });

  // La proyección no debe pedir password ni el resto de campos sensibles/no usados.
  assert.ok(!calls.select.includes("password"));
  assert.equal(res.body.password, undefined);
  assert.equal(res.body.subscription, undefined);
  assert.equal(res.body.subscriptionExpiresAt, undefined);
});
