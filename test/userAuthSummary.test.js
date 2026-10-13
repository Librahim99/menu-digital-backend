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

test("getAuthUserSummary devuelve solo los campos livianos del dashboard, sin password ni el resto del user", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find(plan => plan.name === name)));

  const user = {
    _id: "64f000000000000000000123",
    slug: "cafe-de-prueba",
    hasDelivery: true,
    hasTakeAway: true,
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
    hasTakeAway: true,
    template: 1,
    itemCount: 4,
    categoryCount: 1,
    contactInfo: { businessName: "Café de prueba" },
    media: { backgroundPicture: "https://example.com/fondo.jpg" },
    showDashboardActivity: true,
  });

  // La proyección no debe pedir password ni el resto de campos sensibles/no usados.
  assert.ok(!calls.select.includes("password"));
  assert.equal(res.body.password, undefined);
  assert.equal(res.body.subscription, undefined);
  assert.equal(res.body.subscriptionExpiresAt, undefined);
});

test("getAuthUserSummary avisa cuando el dueño apagó los datos de pedidos y reservas del inicio", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find(plan => plan.name === name)));
  const user = {
    _id: "64f000000000000000000123",
    slug: "cafe-de-prueba",
    subscription: "pro",
    subscriptionExpiresAt: null,
    panelSettings: { showDashboardActivity: false },
  };
  const calls = {};
  t.mock.method(User, "findById", () => userFindByIdQuery(user, calls));
  t.mock.method(Menu, "find", async () => []);
  t.mock.method(Item, "countDocuments", async () => 0);

  const res = response();
  await getAuthUserSummary({ user: { _id: user._id } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.showDashboardActivity, false);
  assert.ok(calls.select.includes("panelSettings.showDashboardActivity"));
});

test("PATCH /me/settings guarda el toggle del inicio solo si es booleano; sin guardar vale true", async (t) => {
  const { updatePanelSettings } = require("../src/controllers/userController");
  let received;
  const update = t.mock.method(User, "findByIdAndUpdate", async (_id, change) => {
    received = change.$set;
    return { panelSettings: { showDashboardActivity: false } };
  });

  const res = response();
  await updatePanelSettings({ user: { _id: "64f000000000000000000123" }, body: { showDashboardActivity: false } }, res);
  assert.deepEqual(received, { "panelSettings.showDashboardActivity": false });
  assert.equal(res.body.showDashboardActivity, false);

  const invalid = response();
  await updatePanelSettings({ user: { _id: "64f000000000000000000123" }, body: { showDashboardActivity: "no" } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(update.mock.callCount(), 1);

  // Cuenta anterior a la opción: el campo no está guardado.
  update.mock.mockImplementation(async () => ({ panelSettings: {} }));
  const legacy = response();
  await updatePanelSettings({ user: { _id: "64f000000000000000000123" }, body: { autoGenerateCodes: true } }, legacy);
  assert.equal(legacy.body.showDashboardActivity, true);
});
