const test = require("node:test");
const assert = require("node:assert/strict");
const Plan = require("../src/models/Plan");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const PageView = require("../src/models/PageView");
const catalog = require("../src/services/planCatalog");
const { requireFeature } = require("../src/middleware/auth");
const users = require("../src/controllers/userController");
const { newItem, editItem } = require("../src/controllers/itemController");
const plans = require("../src/controllers/planController");
const { getSubscriptionState } = require("../src/config/plans");

const document = (name, changes = {}) => {
  const initial = structuredClone(catalog.INITIAL_PLANS.find(plan => plan.name === name));
  return new Plan({ ...initial, features: { ...initial.features, ...changes }, __v: 0 });
};
const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  set() { return this; },
});

test("un cambio de features se aplica por petición, sin herencia implícita de Pro", async (t) => {
  const stored = document("pro", { carga_masiva_excel: false, item_limit: 27, templateIds: [2, 7] });
  t.mock.method(Plan, "findOne", async () => stored);
  const gate = requireFeature("carga_masiva_excel");
  const res = response();
  await gate({ user: { subscription: "pro" } }, res, () => assert.fail("No debe habilitar Excel"));
  assert.equal(res.statusCode, 403);
  const dto = await catalog.getPlan("pro");
  assert.equal(dto.features.item_limit, 27);
  assert.deepEqual(dto.features.templateIds, [2, 7]);
  stored.features.carga_masiva_excel = true;
  let next = false;
  await gate({ user: { subscription: "pro" } }, response(), () => { next = true; });
  assert.equal(next, true);
});

test("un Free puede usar estadísticas si están habilitadas en su documento", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => document(name, { estadisticas: true }));
  let next = false;
  await requireFeature("estadisticas")({ user: { subscription: "free" } }, response(), () => { next = true; });
  assert.equal(next, true);
});

test("un plan vencido recibe las funciones de Free y un fallo del catálogo no concede permisos", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => {
    assert.equal(name, "free");
    return document(name);
  });
  const req = { user: { subscription: "pro", subscriptionExpiresAt: new Date(0) } };
  const expired = response();
  await requireFeature("estadisticas")(req, expired, () => assert.fail("No debe habilitar estadísticas"));
  assert.equal(expired.statusCode, 403);
  t.mock.method(console, "error", () => {});
  t.mock.method(Plan, "findOne", async () => { throw new Error("DB unavailable"); });
  const unavailable = response();
  await requireFeature("menu_editor")({ user: { subscription: "pro" } }, unavailable, () => assert.fail("No debe habilitar el editor"));
  assert.equal(unavailable.statusCode, 503);
});

test("el estado de suscripción cubre vencimiento exacto, legacy sin fecha e inválidos", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");
  assert.deepEqual(
    getSubscriptionState("pro", "2026-09-02T12:00:00.000Z", now),
    {
      storedPlan: "pro",
      effectivePlan: "free",
      subscriptionStatus: "expired",
      previousSubscription: "pro",
      downgradeReason: "subscription_expired",
      downgradedAt: new Date("2026-09-02T12:00:00.000Z"),
    }
  );
  assert.equal(getSubscriptionState("basic", null, now).effectivePlan, "basic");
  assert.equal(getSubscriptionState("basic", null, now).subscriptionStatus, "active");
  assert.equal(getSubscriptionState("pro", "fecha-inválida", now).effectivePlan, "free");
  assert.equal(getSubscriptionState("pro", "fecha-inválida", now).subscriptionStatus, "expired");
  assert.deepEqual(getSubscriptionState("free", null, now), {
    storedPlan: "free",
    effectivePlan: "free",
    subscriptionStatus: "free",
    previousSubscription: null,
    downgradeReason: null,
    downgradedAt: null,
  });
});

test("el backend bloquea un template retirado y usa uno permitido al leer la carta", async (t) => {
  t.mock.method(Plan, "findOne", async () => document("pro", { templateIds: [2, 7] }));
  const user = { _id: "64f000000000000000000123", subscription: "pro", template: 15, contactInfo: {} };
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe guardar template retirado"));
  const blocked = response();
  await users.useTemplate({ user, body: { template: 15 } }, blocked);
  assert.equal(blocked.statusCode, 403);
  t.mock.method(User, "findOne", async () => user);
  const publicPage = response();
  await users.fetchUser({ params: { slug: "cafe" } }, publicPage);
  assert.equal(publicPage.body.template, 2);
  assert.equal(user.template, 15);
});

test("el límite de productos y los permisos del editor se leen desde MongoDB", async (t) => {
  t.mock.method(Plan, "findOne", async () => document("pro", { item_limit: 2, menu_pdf: false, carga_masiva_excel: false }));
  t.mock.method(Menu, "find", () => {
    const rows = [{ _id: "menu", userID: "owner", section: false, toObject() { return { _id: this._id }; } }];
    const query = Promise.resolve(rows);
    query.select = async () => rows;
    return query;
  });
  t.mock.method(Menu, "findById", async () => ({ userID: "owner" }));
  t.mock.method(Item, "countDocuments", async () => 2);
  t.mock.method(Item, "create", async () => assert.fail("No debe crear sobre el límite"));
  const req = { user: { _id: "owner", subscription: "pro" }, body: { menuID: "menu", title: "Café", price: 100 } };
  const create = response();
  await newItem(req, create);
  assert.equal(create.statusCode, 403);
  assert.match(create.body.message, /2 productos/);
  t.mock.method(Item, "find", async () => []);
  const own = response();
  await users.fetchOwnMenu({ user: req.user }, own);
  assert.equal(own.body.limits.itemLimit, 2);
  assert.equal(own.body.limits.canExportPdf, false);
  assert.equal(own.body.limits.canImportExcel, false);
});

test("retirar programación en Pro bloquea nuevas ofertas programadas y oculta las existentes", async (t) => {
  t.mock.method(Plan, "findOne", async () => document("pro", { programacion_productos: false }));
  const item = { _id: "item", menuID: { equals: id => id === "menu", toString: () => "menu" }, price: 100,
    offerPrice: 80, offerRange: { from: "2020-01-01", to: "2099-01-01" }, available: true,
    toObject() { return { ...this }; } };
  t.mock.method(Item, "findById", async () => item);
  t.mock.method(Menu, "findById", async () => ({ userID: "owner" }));
  t.mock.method(Item, "findByIdAndUpdate", async () => assert.fail("No debe guardar la programación"));
  const blocked = response();
  await editItem({ user: { _id: "owner", subscription: "pro" }, params: { itemID: "item" }, body: { offerPrice: 70, offerRange: item.offerRange } }, blocked);
  assert.equal(blocked.statusCode, 403);
  t.mock.method(User, "findOne", async () => ({ _id: "owner", subscription: "pro", contactInfo: {}, template: 1 }));
  t.mock.method(PageView, "findOneAndUpdate", async () => ({}));
  t.mock.method(Menu, "find", async () => [{ _id: "menu", section: false, toObject() { return {}; } }]);
  t.mock.method(Item, "find", async () => [item]);
  const publicMenu = response();
  await users.fetchUserWithMenu({ params: { slug: "cafe" } }, publicMenu);
  assert.equal(publicMenu.body.menu.sinSeccion[0].items[0].offerPrice, null);
});

test("el administrador puede editar Free y desactivar funcionalidades en cualquier plan", async (t) => {
  const current = document("free");
  t.mock.method(Plan, "findOne", async () => current);
  t.mock.method(current, "save", async () => { await current.validate(); current.__v += 1; });
  const features = { ...current.toObject().features, qr: false, item_limit: 8, templateIds: [3] };
  const res = response();
  await plans.updatePlan({ params: { name: "free" }, user: { _id: "64f000000000000000000123" },
    body: { version: 0, label: "Gratis", description: "Prueba", price: 0, discountPrice: null, features } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.plan.features, features);
  assert.equal(res.body.plan.version, 1);
});

test("la API no acepta tipos ambiguos, claves desconocidas ni templates inexistentes", async (t) => {
  t.mock.method(Plan, "findOne", async () => assert.fail("No debe leer ni escribir"));
  const valid = document("basic").toObject().features;
  for (const change of [{ qr: "false" }, { item_limit: 0 }, { item_limit: -1 }, { templateIds: [] }, { templateIds: [16] }, { templateIds: [1, 1] }, { feature_inventada: true }]) {
    const res = response();
    await plans.updatePlan({ params: { name: "basic" }, user: {}, body: {
      version: 0, label: "Básico", description: "Prueba", price: 100, discountPrice: null, features: { ...valid, ...change },
    } }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(change));
  }
});
