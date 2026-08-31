const test = require("node:test");
const assert = require("node:assert/strict");
const Plan = require("../src/models/Plan");
const catalog = require("../src/services/planCatalog");
const controller = require("../src/controllers/planController");
const { protect, isAdmin } = require("../src/middleware/auth");
const router = require("../src/routes/adminPlanRoutes");

const document = (name = "basic", overrides = {}) => new Plan({
  ...catalog.INITIAL_PLANS.find(plan => plan.name === name), __v: 0,
  ...overrides,
});
const response = () => ({
  statusCode: 200, headers: {}, body: null,
  status(code) { this.statusCode = code; return this; },
  set(key, value) { this.headers[key] = value; return this; },
  json(body) { this.body = body; return this; },
});
const adminRequest = (body = {}, name = "basic") => ({
  params: { name }, user: { _id: "64f000000000000000000123" },
  body: { price: 34999, discountPrice: 29999, version: 0, label: "Básico", description: "Descripción", features: structuredClone(catalog.INITIAL_PLANS.find(plan => plan.name === name).features), ...body },
});

test("los tres planes iniciales validan sin alterar sus importes actuales", async () => {
  for (const plan of catalog.INITIAL_PLANS) await new Plan(plan).validate();
  assert.equal(document("basic").price, 29999);
  assert.equal(document("pro").price, 49999);
});

test("features es obligatorio y rechaza límites o listas de templates inválidas", async () => {
  for (const features of [undefined, { ...catalog.INITIAL_PLANS[0].features, item_limit: undefined },
    { ...catalog.INITIAL_PLANS[0].features, templateIds: [] },
    { ...catalog.INITIAL_PLANS[0].features, templateIds: [1, 16] }]) {
    await assert.rejects(document("free", { features }).validate(), { name: "ValidationError" });
  }
});

test("el modelo rechaza precios y promociones incompatibles con cada plan", async () => {
  for (const [name, overrides] of [
    ["free", { price: 1 }], ["free", { discountPrice: 1 }],
    ["basic", { price: 0 }], ["basic", { price: -1 }], ["basic", { price: 2.5 }],
    ["basic", { price: Infinity }], ["pro", { discountPrice: 0 }],
    ["pro", { discountPrice: 49999 }], ["pro", { discountPrice: 59999 }],
    ["pro", { discountPrice: 1.5 }],
    ["pro", { periodMultipliers: { 1: 1, 3: 2.7, 6: 5 } }],
    ["pro", { periodMultipliers: { 1: 1, 3: -1, 6: 5, 12: 9 } }],
    ["pro", { price: 1, periodMultipliers: { 1: 1, 3: 0.1, 6: 5, 12: 9 } }],
  ]) await assert.rejects(document(name, overrides).validate(), { name: "ValidationError" });
});

test("la cotización lee MongoDB y combina promoción con el período una sola vez", async (t) => {
  const plan = document("basic", { price: 34999, discountPrice: 29999, __v: 4 });
  t.mock.method(Plan, "findOne", async (filter) => {
    assert.deepEqual(filter, { name: "basic" });
    return plan;
  });
  const quote = await catalog.getCheckoutQuote("basic", 3);
  assert.equal(quote.total, 80997);
  assert.equal(quote.version, 4);
  assert.equal(quote.currency, "ARS");
  assert.equal(quote.plan.billingOptions[1].regularTotal, 104997);
  assert.equal(quote.plan.billingOptions[1].savings, 24000);
  plan.price = 40000;
  plan.discountPrice = null;
  plan.__v = 5;
  assert.equal((await catalog.getCheckoutQuote("basic", 3)).total, 108000);
});

test("no hay fallback de precios si falta un plan o MongoDB falla", async (t) => {
  t.mock.method(Plan, "findOne", async () => null);
  await assert.rejects(catalog.getCheckoutQuote("basic", 1), /no disponible/);
  t.mock.method(Plan, "findOne", async () => { throw new Error("database unavailable"); });
  await assert.rejects(catalog.getCheckoutQuote("pro", 1), /database unavailable/);
  assert.equal(await catalog.getCheckoutQuote("free", 1), null);
  assert.equal(await catalog.getCheckoutQuote("pro", 2), null);
});

test("el DTO expone los permisos reales y no filtra metadatos internos", () => {
  const dto = catalog.planToDTO(document("basic", {
    updatedBy: "64f000000000000000000123",
  }));
  assert.equal(dto.features.item_limit, 50);
  assert.deepEqual(dto.features.templateIds, [1, 2, 3, 4, 5]);
  assert.equal(dto.features.carga_masiva_excel, true);
  assert.equal(dto.features.estadisticas, false);
  assert.equal(dto.updatedBy, undefined);
  assert.equal(dto._id, undefined);
  assert.equal(dto.__v, undefined);
  assert.deepEqual(catalog.planToDTO(document("free")).features.templateIds, [1]);
});

test("el DTO conserva los multiplicadores editados al serializar el mapa de MongoDB", () => {
  const periodMultipliers = { 1: 1, 3: 2.4, 6: 4.75, 12: 8.5 };
  const stored = document("pro", { periodMultipliers, price: 10000, discountPrice: 8000 });
  for (const source of [stored, stored.toObject()]) {
    const dto = JSON.parse(JSON.stringify(catalog.planToDTO(source)));
    assert.deepEqual(dto.periodMultipliers, periodMultipliers);
    assert.deepEqual(dto.billingOptions.map(option => option.multiplier), [1, 2.4, 4.75, 8.5]);
    assert.deepEqual(dto.billingOptions.map(option => option.total), [8000, 19200, 38000, 68000]);
    assert.deepEqual(Object.fromEntries(document("pro", dto).periodMultipliers), periodMultipliers);
  }
});

test("inicializar dos veces no sobrescribe una promoción administrada ni la versión", async (t) => {
  const stored = new Map();
  t.mock.method(Plan, "init", async () => {});
  t.mock.method(Plan, "updateOne", async (filter, update, options) => {
    if (filter.features) {
      const existing = stored.get(filter.name);
      if (!existing.features) { existing.features = update.$set.features; existing.__v += 1; }
      return;
    }
    assert.deepEqual(Object.keys(update), ["$setOnInsert"]);
    assert.equal(options.timestamps, false);
    assert.equal(options.upsert, true);
    if (!stored.has(filter.name)) stored.set(filter.name, new Plan(update.$setOnInsert));
  });
  t.mock.method(Plan, "find", async () => [...stored.values()]);
  await catalog.initializePlans();
  const basic = stored.get("basic");
  basic.price = 70000;
  basic.discountPrice = 50000;
  basic.periodMultipliers = { 1: 1, 3: 2.35, 6: 4.7, 12: 8.8 };
  basic.__v = 9;
  const updatedAt = basic.updatedAt;
  await catalog.initializePlans();
  assert.equal(stored.size, 3);
  assert.equal(basic.price, 70000);
  assert.equal(basic.discountPrice, 50000);
  assert.deepEqual(Object.fromEntries(basic.periodMultipliers), { 1: 1, 3: 2.35, 6: 4.7, 12: 8.8 });
  assert.equal(basic.__v, 9);
  assert.equal(basic.updatedAt, updatedAt);
});

test("las rutas de administración exigen autenticación y rol admin", () => {
  assert.equal(router.stack[0].handle, protect);
  assert.equal(router.stack[1].handle, isAdmin);
  const res = response();
  let nextCalled = false;
  isAdmin({ user: { admin: false } }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test("el admin rechaza payloads inválidos antes de consultar o guardar", async (t) => {
  t.mock.method(Plan, "findOne", () => { assert.fail("No debe consultar"); });
  for (const overrides of [
    { price: "30000" }, { price: -1 }, { price: 0 }, { price: 3.5 },
    { discountPrice: "20000" }, { discountPrice: 0 }, { discountPrice: 50000 },
    { version: -1 }, { version: "0" }, { features: [] }, { name: "pro" },
  ]) {
    const res = response();
    await controller.updatePlan(adminRequest(overrides), res);
    assert.equal(res.statusCode, 400, JSON.stringify(overrides));
  }
  const free = response();
  await controller.updatePlan(adminRequest({}, "free"), free);
  assert.equal(free.statusCode, 400);
});

test("guardar un plan valida, atribuye el cambio y devuelve catálogo actualizado", async (t) => {
  const current = document();
  t.mock.method(Plan, "findOne", async () => current);
  t.mock.method(current, "save", async () => {
    await current.validate();
    current.__v += 1;
    return current;
  });
  const res = response();
  await controller.updatePlan(adminRequest(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.plan.effectivePrice, 29999);
  assert.equal(res.body.plan.price, 34999);
  assert.equal(res.body.plan.version, 1);
  assert.equal(String(current.updatedBy), "64f000000000000000000123");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("editar únicamente los períodos actualiza cotización, ahorro y versión del catálogo", async (t) => {
  const current = document("basic", { price: 10000, discountPrice: 8000, __v: 4 });
  const oldQuote = catalog.planToDTO(current);
  t.mock.method(Plan, "findOne", async () => current);
  t.mock.method(current, "save", async () => {
    await current.validate();
    current.__v += 1;
    return current;
  });
  const periodMultipliers = { 1: 1, 3: 2.4, 6: 4.75, 12: 8.5 };
  const res = response();
  await controller.updatePlan(adminRequest({ price: current.price, discountPrice: current.discountPrice,
    label: current.label, description: current.description, version: 4, periodMultipliers }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.plan.version, 5);
  assert.deepEqual(res.body.plan.periodMultipliers, periodMultipliers);
  const quote = await catalog.getCheckoutQuote("basic", 3);
  assert.equal(quote.version, 5);
  assert.equal(quote.total, 19200);
  assert.equal(quote.plan.billingOptions[1].regularTotal, 30000);
  assert.equal(quote.plan.billingOptions[1].savings, 10800);
  assert.equal(oldQuote.billingOptions[1].total, 21600);
  assert.equal(oldQuote.version, 4);
});

test("un cliente anterior puede omitir períodos sin sobrescribir el mapa administrado", async (t) => {
  const periodMultipliers = { 1: 1, 3: 2.1, 6: 4.2, 12: 8.4 };
  const current = document("basic", { periodMultipliers });
  t.mock.method(Plan, "findOne", async () => current);
  t.mock.method(current, "save", async () => { await current.validate(); current.__v += 1; return current; });
  const res = response();
  await controller.updatePlan(adminRequest(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.fromEntries(current.periodMultipliers), periodMultipliers);
  assert.deepEqual(res.body.plan.periodMultipliers, periodMultipliers);
});

test("el admin rechaza mapas de períodos ambiguos o inválidos antes de consultar MongoDB", async (t) => {
  t.mock.method(Plan, "findOne", () => assert.fail("No debe consultar ni persistir"));
  const valid = { 1: 1, 3: 2.7, 6: 5, 12: 9 };
  const cases = [undefined, null, [], [1, 2.7, 5, 9], "1,2.7,5,9", true, 1,
    new Map(Object.entries(valid)), { 1: 1, 3: 2.7, 6: 5 }, { ...valid, 24: 18 },
    ...[0, -1, "2.7", true, false, null, NaN, Infinity, 3.01, {}].map(value => ({ ...valid, 3: value })),
    { ...valid, 1: 0.9 }, { ...valid, 1: "1" }, { ...valid, 6: 6.1 }, { ...valid, 12: 12.1 },
  ];
  for (const periodMultipliers of cases) {
    const res = response();
    await controller.updatePlan(adminRequest({ periodMultipliers }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(periodMultipliers));
  }
  for (const overrides of [
    { price: 1, discountPrice: null, periodMultipliers: { ...valid, 3: 0.49 } },
    { price: 100, discountPrice: 1, periodMultipliers: { ...valid, 3: 0.49 } },
  ]) {
    const res = response();
    await controller.updatePlan(adminRequest(overrides), res);
    assert.equal(res.statusCode, 400);
  }
});

test("Free conserva precio cero al editar períodos, y el esquema protege un precio pago reducido", async (t) => {
  const free = document("free");
  t.mock.method(Plan, "findOne", async () => free);
  t.mock.method(free, "save", async () => { await free.validate(); free.__v += 1; return free; });
  const res = response();
  const periodMultipliers = { 1: 1, 3: 0.1, 6: 5, 12: 9 };
  await controller.updatePlan(adminRequest({ price: 0, discountPrice: null, periodMultipliers }, "free"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.plan.periodMultipliers, periodMultipliers);
  assert.ok(res.body.plan.billingOptions.every(option => option.total === 0));
  const paid = document("basic", { periodMultipliers });
  t.mock.method(Plan, "findOne", async () => paid);
  t.mock.method(paid, "save", async () => { await paid.validate(); return paid; });
  const reduced = response();
  await controller.updatePlan(adminRequest({ price: 1, discountPrice: null }), reduced);
  assert.equal(reduced.statusCode, 400);
});

test("una edición vieja no sobreescribe un precio nuevo, ni ante carrera al guardar", async (t) => {
  const current = document("basic", { __v: 2 });
  t.mock.method(Plan, "findOne", async () => current);
  const save = t.mock.method(current, "save", async () => {
    const error = new Error("conflict"); error.name = "VersionError"; throw error;
  });
  const stale = response();
  await controller.updatePlan(adminRequest(), stale);
  assert.equal(stale.statusCode, 409);
  assert.equal(save.mock.callCount(), 0);
  const racing = response();
  await controller.updatePlan(adminRequest({ version: 2 }), racing);
  assert.equal(racing.statusCode, 409);
  assert.equal(Plan.schema.options.optimisticConcurrency, true);
});

test("un catálogo incompleto no se publica como si estuviera listo para vender", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(Plan, "find", async () => [document("free")]);
  const res = response();
  await controller.listPlans({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.plans, undefined);
});

test("inicializar completa features legadas sin tocar precios ni configuraciones existentes", async (t) => {
  const legacyMultipliers = { 1: 1, 3: 2.5, 6: 4.5, 12: 8 };
  const legacy = document("basic", { features: undefined, price: 72000, discountPrice: 64000, periodMultipliers: legacyMultipliers, __v: 7 });
  const custom = document("pro", { features: { ...catalog.INITIAL_PLANS[2].features, estadisticas: false, item_limit: 99, templateIds: [2, 8] }, __v: 4 });
  const stored = [document("free"), legacy, custom];
  t.mock.method(Plan, "init", async () => {});
  t.mock.method(Plan, "updateOne", async (filter, update) => {
    if (!filter.features) return;
    assert.deepEqual(filter.features, { $exists: false });
    const existing = stored.find(plan => plan.name === filter.name);
    if (existing.features === undefined) {
      existing.features = update.$set.features;
      existing.__v += update.$inc.__v;
    }
  });
  t.mock.method(Plan, "find", async () => stored);
  await catalog.initializePlans();
  await catalog.initializePlans();
  assert.equal(legacy.price, 72000);
  assert.equal(legacy.discountPrice, 64000);
  assert.deepEqual(Object.fromEntries(legacy.periodMultipliers), legacyMultipliers);
  assert.equal(legacy.__v, 8);
  assert.deepEqual(legacy.features.toObject(), catalog.INITIAL_PLANS[1].features);
  assert.equal(custom.__v, 4);
  assert.equal(custom.features.estadisticas, false);
  assert.equal(custom.features.item_limit, 99);
  assert.deepEqual([...custom.features.templateIds], [2, 8]);
});
