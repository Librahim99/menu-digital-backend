const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const Plan = require("../src/models/Plan");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const PageView = require("../src/models/PageView");
const CrmProfile = require("../src/models/CrmProfile");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { useTemplate, fetchUserWithMenu, fetchUser, getAuthUser } = require("../src/controllers/userController");
const { MENU_STYLES, MENU_STYLE_LABELS } = require("../src/config/menuStyles");

const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const owner = () => ({
  _id: "64f000000000000000000123", subscription: "free", template: 1,
  contactInfo: { businessName: "Bistró de prueba", mail: "cafe@example.com" },
});
const mockPlan = (t) => t.mock.method(Plan, "findOne", async ({ name }) =>
  new Plan(INITIAL_PLANS.find(plan => plan.name === name)));

test("cuentas nuevas usan Clásico y el schema rechaza diseños desconocidos", () => {
  assert.equal(new User().menuStyle, "classic");
  assert.ok(new User({ menuStyle: "unknown" }).validateSync().errors.menuStyle);
});

for (const menuStyle of MENU_STYLES.filter(style => style !== "classic")) {
test(`guarda ${menuStyle} con una paleta permitida y registra su nombre en CRM`, async (t) => {
  mockPlan(t);
  const user = owner();
  let event;
  t.mock.method(CrmProfile, "findOneAndUpdate", async (_, update) => { event = update; });
  t.mock.method(User, "findByIdAndUpdate", async (id, update, options) => {
    assert.equal(id, user._id);
    assert.deepEqual(update, { template: 1, menuStyle });
    assert.equal(options.runValidators, true);
    return { ...user, ...update };
  });
  const res = response();
  await useTemplate({ user, body: { template: 1, menuStyle } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { template: 1, menuStyle });
  assert.ok(event.$push.notes.$each[0].text.includes(MENU_STYLE_LABELS[menuStyle]));
});
}

test("clientes anteriores pueden cambiar paleta sin sobrescribir el diseño", async (t) => {
  mockPlan(t);
  const user = { ...owner(), menuStyle: "bistro" };
  t.mock.method(User, "findByIdAndUpdate", async (_, update) => {
    assert.deepEqual(update, { template: 1 });
    return user;
  });
  const res = response();
  await useTemplate({ user, body: { template: 1 } }, res);
  assert.equal(res.body.menuStyle, "bistro");
});

test("rechaza estilos arbitrarios y no permite saltarse el gating de paletas", async (t) => {
  mockPlan(t);
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe escribir"));
  for (const menuStyle of [null, {}, [], 1, "unknown"]) {
    const res = response();
    await useTemplate({ user: owner(), body: { template: 1, menuStyle } }, res);
    assert.equal(res.statusCode, 400);
  }
  for (const menuStyle of MENU_STYLES) {
    const res = response();
    await useTemplate({ user: owner(), body: { template: 6, menuStyle } }, res);
    assert.equal(res.statusCode, 403);
  }
});

test("la carta pública y el editor devuelven el diseño; cuentas viejas conservan Clásico", async (t) => {
  mockPlan(t);
  t.mock.method(Menu, "find", async () => []);
  t.mock.method(Item, "find", async () => []);
  t.mock.method(Item, "countDocuments", async () => 0);
  t.mock.method(PageView, "findOneAndUpdate", async () => ({}));
  for (const menuStyle of [undefined, ...MENU_STYLES, "unknown"]) {
    const user = { ...owner(), menuStyle, toObject() { return { ...this }; } };
    t.mock.method(User, "findOne", async () => user);
    t.mock.method(User, "findByIdAndUpdate", async () => user);
    const menu = response();
    await fetchUserWithMenu({ params: { slug: "bistro-de-prueba" } }, menu);
    assert.equal(menu.statusCode, 200);
    assert.equal(menu.body.user.menuStyle, MENU_STYLES.includes(menuStyle) ? menuStyle : "classic");
    const panel = response();
    await getAuthUser({ user }, panel);
    assert.equal(panel.body.menuStyle, menu.body.user.menuStyle);
  }
});

test("la portada devuelve la misma familia sin eludir la disponibilidad por plan", async (t) => {
  mockPlan(t);
  for (const menuStyle of [undefined, ...MENU_STYLES, "unknown"]) {
    t.mock.method(User, "findOne", async () => ({ ...owner(), subscription: "pro", menuStyle }));
    const res = response();
    await fetchUser({ params: { slug: "local-de-prueba" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.menuStyle, MENU_STYLES.includes(menuStyle) ? menuStyle : "classic");
  }
  t.mock.method(User, "findOne", async () => ({ ...owner(), menuStyle: "premium" }));
  t.mock.method(Plan, "findOne", async () => {
    const plan = INITIAL_PLANS.find(value => value.name === "free");
    return new Plan({ ...plan, features: { ...plan.features, landing_page: false } });
  });
  const res = response();
  await fetchUser({ params: { slug: "local-de-prueba" } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "LANDING_NOT_INCLUDED");
});

test("informa si la cuenta desapareció antes de guardar", async (t) => {
  mockPlan(t);
  t.mock.method(User, "findByIdAndUpdate", async () => null);
  const res = response();
  await useTemplate({ user: owner(), body: { template: 1, menuStyle: "bistro" } }, res);
  assert.equal(res.statusCode, 404);
});
