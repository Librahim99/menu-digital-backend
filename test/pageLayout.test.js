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
const {
  PAGE_LAYOUTS, PAGE_LAYOUT_LABELS, getPageLayoutFeature, getPageLayoutForFeatures,
} = require("../src/config/pageLayouts");

const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const owner = (subscription = "free") => ({
  _id: "64f000000000000000000123", subscription, template: 1,
  contactInfo: { businessName: "Bistró de prueba", mail: "cafe@example.com" },
});
const mockPlan = (t) => t.mock.method(Plan, "findOne", async ({ name }) =>
  new Plan(INITIAL_PLANS.find(plan => plan.name === name)));
// Plan real del catálogo con una feature forzada: prueba que el permiso sale
// del documento de MongoDB y no del nombre del plan.
const mockPlanWith = (t, name, features) => t.mock.method(Plan, "findOne", async () => {
  const plan = INITIAL_PLANS.find(value => value.name === name);
  return new Plan({ ...plan, features: { ...plan.features, ...features } });
});
const readMocks = (t) => {
  t.mock.method(Menu, "find", async () => []);
  t.mock.method(Item, "find", async () => []);
  t.mock.method(Item, "countDocuments", async () => 0);
  t.mock.method(PageView, "findOneAndUpdate", async () => ({}));
};
const GATED_LAYOUTS = PAGE_LAYOUTS.filter(layout => getPageLayoutFeature(layout) !== null);

test("cuentas nuevas usan Estándar y el schema rechaza plantillas desconocidas", () => {
  assert.equal(new User().pageLayout, "standard");
  assert.ok(new User({ pageLayout: "unknown" }).validateSync().errors.pageLayout);
});

// Espejo de PAGE_LAYOUTS del frontend (src/lib/pageLayouts.ts): si divergen,
// el selector ofrece una plantilla que el PATCH rechaza.
test("Estándar es la única plantilla abierta; el resto usa page_layouts", () => {
  assert.deepEqual(PAGE_LAYOUTS, ["standard", "immersive", "split"]);
  assert.equal(getPageLayoutFeature("standard"), null);
  for (const layout of GATED_LAYOUTS) assert.equal(getPageLayoutFeature(layout), "page_layouts");
  assert.equal(getPageLayoutFeature("unknown"), null);
});

test("el recorte de lectura devuelve Estándar sin la feature y para valores desconocidos", () => {
  for (const layout of GATED_LAYOUTS) {
    assert.equal(getPageLayoutForFeatures(layout, { page_layouts: true }), layout);
    assert.equal(getPageLayoutForFeatures(layout, { page_layouts: false }), "standard");
    // Un catálogo anterior no trae la clave: tampoco la habilita.
    assert.equal(getPageLayoutForFeatures(layout, {}), "standard");
  }
  for (const value of [undefined, null, "unknown", 3]) {
    assert.equal(getPageLayoutForFeatures(value, { page_layouts: true }), "standard");
  }
});

for (const pageLayout of GATED_LAYOUTS) {
  test(`guarda la plantilla ${pageLayout} con plan pro y registra su nombre en CRM`, async (t) => {
    mockPlan(t);
    const user = owner("pro");
    let event;
    t.mock.method(CrmProfile, "findOneAndUpdate", async (_, update) => { event = update; });
    t.mock.method(User, "findByIdAndUpdate", async (id, update, options) => {
      assert.equal(id, user._id);
      // Sin menuStyle en el body no se escribe: elegir plantilla no toca el diseño.
      assert.deepEqual(update, { template: 1, pageLayout });
      assert.equal(options.runValidators, true);
      return { ...user, ...update };
    });
    const res = response();
    await useTemplate({ user, body: { template: 1, pageLayout } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { template: 1, menuStyle: "classic", pageLayout });
    assert.ok(event.$push.notes.$each[0].text.includes(PAGE_LAYOUT_LABELS[pageLayout]));
  });
}

test("un plan sin plantillas las rechaza sin escribir nada", async (t) => {
  mockPlan(t);
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe escribir"));
  t.mock.method(CrmProfile, "findOneAndUpdate", async () => assert.fail("No debe registrar CRM"));
  for (const pageLayout of GATED_LAYOUTS) {
    const res = response();
    await useTemplate({ user: owner(), body: { template: 1, pageLayout } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "FEATURE_NOT_INCLUDED");
    assert.equal(res.body.feature, "page_layouts");
  }
});

test("Estándar se puede elegir con cualquier plan", async (t) => {
  mockPlan(t);
  const user = { ...owner(), pageLayout: "immersive" };
  t.mock.method(CrmProfile, "findOneAndUpdate", async () => ({}));
  t.mock.method(User, "findByIdAndUpdate", async (_, update) => ({ ...user, ...update }));
  const res = response();
  await useTemplate({ user, body: { template: 1, pageLayout: "standard" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pageLayout, "standard");
});

test("las plantillas se habilitan por documento del catálogo y no dependen de los diseños", async (t) => {
  t.mock.method(CrmProfile, "findOneAndUpdate", async () => ({}));
  mockPlanWith(t, "basic", { page_layouts: true, menu_styles: false, premium_menu_styles: false });
  t.mock.method(User, "findByIdAndUpdate", async (_, update) => ({ ...owner("basic"), ...update }));
  const habilitado = response();
  await useTemplate({ user: owner("basic"), body: { template: 1, pageLayout: "immersive" } }, habilitado);
  assert.equal(habilitado.statusCode, 200);
  assert.equal(habilitado.body.pageLayout, "immersive");

  mockPlanWith(t, "pro", { page_layouts: false });
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe escribir"));
  const retirado = response();
  await useTemplate({ user: owner("pro"), body: { template: 1, pageLayout: "immersive" } }, retirado);
  assert.equal(retirado.statusCode, 403);
  assert.equal(retirado.body.feature, "page_layouts");
});

test("rechaza plantillas arbitrarias", async (t) => {
  mockPlan(t);
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe escribir"));
  for (const pageLayout of [null, {}, [], 1, "unknown"]) {
    const res = response();
    await useTemplate({ user: owner("pro"), body: { template: 1, pageLayout } }, res);
    assert.equal(res.statusCode, 400);
  }
});

test("cambiar paleta o diseño no sobrescribe la plantilla guardada", async (t) => {
  mockPlan(t);
  const user = { ...owner("pro"), pageLayout: "immersive" };
  t.mock.method(CrmProfile, "findOneAndUpdate", async () => ({}));
  t.mock.method(User, "findByIdAndUpdate", async (_, update) => {
    assert.equal("pageLayout" in update, false);
    return { ...user, ...update };
  });
  const paleta = response();
  await useTemplate({ user, body: { template: 2 } }, paleta);
  assert.equal(paleta.body.pageLayout, "immersive");
  const diseno = response();
  await useTemplate({ user, body: { template: 1, menuStyle: "grill" } }, diseno);
  assert.equal(diseno.body.pageLayout, "immersive");
});

test("al vencer la suscripción las tres superficies muestran Estándar y MongoDB conserva la plantilla", async (t) => {
  readMocks(t);
  t.mock.method(Plan, "findOne", async ({ name }) => {
    assert.equal(name, "free");
    return new Plan(INITIAL_PLANS.find(plan => plan.name === name));
  });
  const user = {
    ...owner("pro"), subscriptionExpiresAt: new Date(0), pageLayout: "immersive",
    toObject() { return { ...this }; },
  };
  t.mock.method(User, "findOne", async () => user);
  t.mock.method(User, "findByIdAndUpdate", async () => user);

  const carta = response();
  await fetchUserWithMenu({ params: { slug: "bistro-de-prueba" } }, carta);
  assert.equal(carta.statusCode, 200);

  const portada = response();
  await fetchUser({ params: { slug: "local-de-prueba" } }, portada);
  assert.equal(portada.body.pageLayout, "standard");

  const panel = response();
  await getAuthUser({ user }, panel);
  assert.equal(panel.body.pageLayout, "standard");

  // Cambiar de paleta con el plan vencido no da 403 ni pisa lo guardado.
  const res = response();
  await useTemplate({ user, body: { template: 1 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pageLayout, "standard");
  assert.equal(user.pageLayout, "immersive");
});

test("con el plan vigente la portada y el panel devuelven la plantilla elegida", async (t) => {
  readMocks(t);
  mockPlan(t);
  for (const pageLayout of [undefined, ...PAGE_LAYOUTS, "unknown"]) {
    const user = { ...owner("pro"), pageLayout, toObject() { return { ...this }; } };
    t.mock.method(User, "findOne", async () => user);
    t.mock.method(User, "findByIdAndUpdate", async () => user);
    const esperado = PAGE_LAYOUTS.includes(pageLayout) ? pageLayout : "standard";
    const portada = response();
    await fetchUser({ params: { slug: "local-de-prueba" } }, portada);
    assert.equal(portada.body.pageLayout, esperado);
    const panel = response();
    await getAuthUser({ user }, panel);
    assert.equal(panel.body.pageLayout, esperado);
  }
});
