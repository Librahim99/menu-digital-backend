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
  MENU_STYLES, MENU_STYLE_LABELS, LEGACY_MENU_STYLES, VISUAL_FAMILIES,
} = require("../src/config/menuStyles");

const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
// Las familias visuales son una feature de plan: cualquier caso que las use
// tiene que decir con qué suscripción corre. Free sigue siendo el default
// porque es el escenario que más invariantes rompe.
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

test("cuentas nuevas usan Clásico y el schema rechaza diseños desconocidos", () => {
  assert.equal(new User().menuStyle, "classic");
  assert.ok(new User({ menuStyle: "unknown" }).validateSync().errors.menuStyle);
});

test("las familias y los diseños anteriores son dos grupos disjuntos que cubren el catálogo", () => {
  assert.deepEqual([...LEGACY_MENU_STYLES, ...VISUAL_FAMILIES].sort(), [...MENU_STYLES].sort());
  assert.equal(VISUAL_FAMILIES.some(style => LEGACY_MENU_STYLES.includes(style)), false);
  assert.ok(LEGACY_MENU_STYLES.includes("classic"));
});

// Guardado: los diseños anteriores quedan abiertos a cualquier plan porque ya
// había cuentas gratuitas usándolos; las familias exigen el plan que las
// incluya. El resto de los asserts es idéntico en los dos grupos.
for (const [grupo, estilos, subscription] of [
  ["anterior", LEGACY_MENU_STYLES.filter(style => style !== "classic"), "free"],
  ["familia", VISUAL_FAMILIES, "pro"],
]) {
  for (const menuStyle of estilos) {
    test(`guarda el diseño ${grupo} ${menuStyle} con plan ${subscription} y registra su nombre en CRM`, async (t) => {
      mockPlan(t);
      const user = owner(subscription);
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
}

test("un plan sin familias visuales las rechaza sin escribir nada", async (t) => {
  mockPlan(t);
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe escribir"));
  t.mock.method(CrmProfile, "findOneAndUpdate", async () => assert.fail("No debe registrar CRM"));
  for (const menuStyle of VISUAL_FAMILIES) {
    const res = response();
    // Template 1 sí está incluido en Free: así el 403 solo puede venir del
    // gating de familias y no del de paletas.
    await useTemplate({ user: owner(), body: { template: 1, menuStyle } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.feature, "menu_styles");
  }
});

test("los diseños anteriores siguen disponibles en el plan gratuito", async (t) => {
  mockPlan(t);
  for (const menuStyle of LEGACY_MENU_STYLES) {
    const user = owner();
    t.mock.method(CrmProfile, "findOneAndUpdate", async () => ({}));
    t.mock.method(User, "findByIdAndUpdate", async (_, update) => ({ ...user, ...update }));
    const res = response();
    await useTemplate({ user, body: { template: 1, menuStyle } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.menuStyle, menuStyle);
  }
});

test("las familias se habilitan por documento del catálogo, no por el nombre del plan", async (t) => {
  t.mock.method(CrmProfile, "findOneAndUpdate", async () => ({}));
  mockPlanWith(t, "basic", { menu_styles: true });
  t.mock.method(User, "findByIdAndUpdate", async (_, update) => ({ ...owner("basic"), ...update }));
  const habilitado = response();
  await useTemplate({ user: owner("basic"), body: { template: 1, menuStyle: "grill" } }, habilitado);
  assert.equal(habilitado.statusCode, 200);
  assert.equal(habilitado.body.menuStyle, "grill");

  mockPlanWith(t, "pro", { menu_styles: false });
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe escribir"));
  const retirado = response();
  await useTemplate({ user: owner("pro"), body: { template: 1, menuStyle: "grill" } }, retirado);
  assert.equal(retirado.statusCode, 403);
});

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

test("una cuenta vencida con familia guardada puede seguir cambiando de paleta", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => {
    assert.equal(name, "free");
    return new Plan(INITIAL_PLANS.find(plan => plan.name === name));
  });
  const user = { ...owner("pro"), subscriptionExpiresAt: new Date(0), menuStyle: "premium" };
  t.mock.method(User, "findByIdAndUpdate", async (_, update) => {
    // Sin menuStyle en el body no hay 403: cambiar de paleta no es elegir familia.
    assert.deepEqual(update, { template: 1 });
    return { ...user, ...update };
  });
  const res = response();
  await useTemplate({ user, body: { template: 1 } }, res);
  assert.equal(res.statusCode, 200);
  // La respuesta del PATCH recorta igual que las lecturas: si devolviera
  // "premium" el panel se contradiría con GET /me en la misma pantalla.
  assert.equal(res.body.menuStyle, "classic");
  assert.equal(user.menuStyle, "premium");
});

test("rechaza estilos arbitrarios y no permite saltarse el gating de paletas", async (t) => {
  mockPlan(t);
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe escribir"));
  for (const menuStyle of [null, {}, [], 1, "unknown"]) {
    const res = response();
    await useTemplate({ user: owner(), body: { template: 1, menuStyle } }, res);
    assert.equal(res.statusCode, 400);
  }
  // Template 6 no está en Free: acá el 403 tiene que ser el de paletas y no el
  // de familias, por eso se afirma el motivo y no solo el status.
  for (const menuStyle of MENU_STYLES) {
    const res = response();
    await useTemplate({ user: owner(), body: { template: 6, menuStyle } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, "Tu plan no incluye ese template.");
  }
});

test("la carta pública y el editor devuelven el diseño; cuentas viejas conservan Clásico", async (t) => {
  readMocks(t);
  // Free solo ve los diseños anteriores; Pro ve el catálogo entero de estilos.
  for (const [subscription, permitidos] of [["free", LEGACY_MENU_STYLES], ["pro", MENU_STYLES]]) {
    mockPlan(t);
    for (const menuStyle of [undefined, ...MENU_STYLES, "unknown"]) {
      const user = { ...owner(subscription), menuStyle, toObject() { return { ...this }; } };
      t.mock.method(User, "findOne", async () => user);
      t.mock.method(User, "findByIdAndUpdate", async () => user);
      const esperado = permitidos.includes(menuStyle) ? menuStyle : "classic";
      const menu = response();
      await fetchUserWithMenu({ params: { slug: "bistro-de-prueba" } }, menu);
      assert.equal(menu.statusCode, 200);
      assert.equal(menu.body.user.menuStyle, esperado);
      const panel = response();
      await getAuthUser({ user }, panel);
      // Contra el valor esperado Y contra la otra respuesta: si alguien recorta
      // en la carta pero se olvida del panel (o al revés), esto lo detecta.
      assert.equal(panel.body.menuStyle, esperado);
      assert.equal(panel.body.menuStyle, menu.body.user.menuStyle);
    }
  }
});

test("al vencer la suscripción las tres superficies muestran Clásico y MongoDB conserva la familia", async (t) => {
  readMocks(t);
  t.mock.method(Plan, "findOne", async ({ name }) => {
    // El plan efectivo de una cuenta vencida es Free: si acá se pidiera "pro",
    // el recorte estaría leyendo el plan comprado en vez del vigente.
    assert.equal(name, "free");
    return new Plan(INITIAL_PLANS.find(plan => plan.name === name));
  });
  const user = {
    ...owner("pro"), subscriptionExpiresAt: new Date(0), menuStyle: "premium",
    toObject() { return { ...this }; },
  };
  t.mock.method(User, "findOne", async () => user);
  t.mock.method(User, "findByIdAndUpdate", async () => user);

  const carta = response();
  await fetchUserWithMenu({ params: { slug: "bistro-de-prueba" } }, carta);
  assert.equal(carta.body.user.menuStyle, "classic");

  const portada = response();
  await fetchUser({ params: { slug: "local-de-prueba" } }, portada);
  assert.equal(portada.body.menuStyle, "classic");

  const panel = response();
  await getAuthUser({ user }, panel);
  assert.equal(panel.body.menuStyle, "classic");

  // El recorte es de lectura: al renovar, la carta recupera su familia sola.
  assert.equal(user.menuStyle, "premium");
});

test("la portada devuelve la misma familia sin eludir la disponibilidad por plan", async (t) => {
  mockPlan(t);
  for (const menuStyle of [undefined, ...MENU_STYLES, "unknown"]) {
    t.mock.method(User, "findOne", async () => ({ ...owner("pro"), menuStyle }));
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
  // El estilo tiene que ser uno de los anteriores a propósito: con una familia
  // el handler cortaría en el 403 del plan y nunca buscaría la cuenta.
  await useTemplate({ user: owner(), body: { template: 1, menuStyle: "bistro" } }, res);
  assert.equal(res.statusCode, 404);
});
