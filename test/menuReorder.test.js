const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Plan = require("../src/models/Plan");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { reorderItems, moveItem } = require("../src/controllers/itemController");
const { reorderMenus, moveMenu, newMenu } = require("../src/controllers/menuController");
const { fetchOwnMenu } = require("../src/controllers/userController");
const { mockQuery } = require("../test-support/queryMock");

// ──────────────────────────────────────────────
// Ordenar el menú arrastrando (tarjeta Trello "Poder ordenar el menú"):
// PATCH /api/items/reorder, PATCH /api/menus/reorder, y que las altas y los
// move dejen lo nuevo al final de su contenedor. Ver utils/menuOrder.js.
// ──────────────────────────────────────────────

const USER_ID = new mongoose.Types.ObjectId("64f000000000000000000123");
const OTHER_USER_ID = new mongoose.Types.ObjectId("64f000000000000000000999");

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

// Menú de prueba con órdenes ya guardados, salvo "Promos", anterior al campo.
const buildCatalog = () => {
  const comidas = new Menu({ userID: USER_ID, title: "Comidas", section: true, order: 0 });
  const bebidas = new Menu({ userID: USER_ID, title: "Bebidas", section: true, order: 1 });
  const pizzas = new Menu({ userID: USER_ID, title: "Pizzas", sectionID: comidas._id, order: 0 });
  const empanadas = new Menu({ userID: USER_ID, title: "Empanadas", sectionID: comidas._id, order: 1 });
  const gaseosas = new Menu({ userID: USER_ID, title: "Gaseosas", sectionID: bebidas._id, order: 0 });
  const promos = new Menu({ userID: USER_ID, title: "Promos" });
  const ajena = new Menu({ userID: OTHER_USER_ID, title: "De otro local" });

  const muzza = new Item({ menuID: pizzas._id, title: "Muzzarella", order: 0 });
  const napo = new Item({ menuID: pizzas._id, title: "Napolitana", order: 1 });
  const fugazza = new Item({ menuID: pizzas._id, title: "Fugazzeta", order: 2 });
  const carne = new Item({ menuID: empanadas._id, title: "Carne", order: 0 });
  const ajeno = new Item({ menuID: ajena._id, title: "Ajeno", order: 0 });

  return {
    menus: [comidas, bebidas, pizzas, empanadas, gaseosas, promos, ajena],
    items: [muzza, napo, fugazza, carne, ajeno],
    comidas, bebidas, pizzas, empanadas, gaseosas, promos, ajena,
    muzza, napo, fugazza, carne, ajeno,
  };
};

// Mongo mockeado con queryMock (aplica filtros y proyecciones de verdad) y
// los bulkWrite registrados por modelo.
const setup = (t) => {
  const catalog = buildCatalog();
  const calls = {
    menuFind: mockQuery(t, Menu, "find", catalog.menus),
    itemFind: mockQuery(t, Item, "find", catalog.items),
  };
  const writes = { item: [], menu: [] };
  t.mock.method(Item, "bulkWrite", async (operations) => { writes.item.push(...operations); return {}; });
  t.mock.method(Menu, "bulkWrite", async (operations) => { writes.menu.push(...operations); return {}; });
  return { ...catalog, calls, writes };
};

const ids = (...docs) => docs.map((doc) => String(doc._id));

// Una fila por operación de bulkWrite: qué documento y qué le escribe.
const summarize = (operations) => operations.map(({ updateOne }) => {
  const { order, menuID, sectionID } = updateOne.update.$set;
  return {
    id: String(updateOne.filter._id),
    order,
    ...(menuID !== undefined && { menuID: String(menuID) }),
    ...(sectionID !== undefined && { sectionID: sectionID === null ? null : String(sectionID) }),
  };
});

const run = async (handler, body) => {
  const res = response();
  await handler({ user: { _id: USER_ID, panelSettings: {} }, body }, res);
  return res;
};

// ──────────────────────────────────────────────
// PATCH /api/items/reorder
// ──────────────────────────────────────────────

test("reorderItems ordena una categoría y solo escribe lo que cambia", async (t) => {
  const { pizzas, muzza, napo, fugazza, writes } = setup(t);

  const res = await run(reorderItems, { menuID: String(pizzas._id), itemIds: ids(muzza, fugazza, napo) });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.itemIds, ids(muzza, fugazza, napo));
  assert.deepEqual(summarize(writes.item), [
    { id: String(fugazza._id), order: 1 },
    { id: String(napo._id), order: 2 },
  ]);
});

test("reorderItems pasa un producto de otra categoría a esta, en la posición pedida", async (t) => {
  const { pizzas, muzza, napo, fugazza, carne, writes } = setup(t);

  const res = await run(reorderItems, { menuID: String(pizzas._id), itemIds: ids(muzza, carne, napo, fugazza) });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(summarize(writes.item), [
    { id: String(carne._id), order: 1, menuID: String(pizzas._id) },
    { id: String(napo._id), order: 2 },
    { id: String(fugazza._id), order: 3 },
  ]);
});

test("reorderItems deja al final lo que ya estaba en la categoría y no vino en la lista", async (t) => {
  const { pizzas, muzza, napo, fugazza, writes } = setup(t);

  const res = await run(reorderItems, { menuID: String(pizzas._id), itemIds: ids(fugazza) });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.itemIds, ids(fugazza, muzza, napo));
  assert.deepEqual(summarize(writes.item), [
    { id: String(fugazza._id), order: 0 },
    { id: String(muzza._id), order: 1 },
    { id: String(napo._id), order: 2 },
  ]);
});

test("reorderItems no escribe nada si algún producto es ajeno o ya no existe", async (t) => {
  const { pizzas, muzza, ajeno, writes } = setup(t);

  const ajenoRes = await run(reorderItems, { menuID: String(pizzas._id), itemIds: ids(muzza, ajeno) });
  const borradoRes = await run(reorderItems, {
    menuID: String(pizzas._id),
    itemIds: [String(muzza._id), String(new mongoose.Types.ObjectId())],
  });

  assert.equal(ajenoRes.statusCode, 409);
  assert.equal(borradoRes.statusCode, 409);
  assert.match(ajenoRes.body.message, /Recargá el menú/);
  assert.deepEqual(writes.item, []);
});

test("reorderItems exige una categoría propia: no una ajena ni una sección", async (t) => {
  const { comidas, ajena, muzza, writes } = setup(t);

  const ajenaRes = await run(reorderItems, { menuID: String(ajena._id), itemIds: ids(muzza) });
  const seccionRes = await run(reorderItems, { menuID: String(comidas._id), itemIds: ids(muzza) });

  assert.equal(ajenaRes.statusCode, 404);
  assert.equal(seccionRes.statusCode, 400);
  assert.deepEqual(writes.item, []);
});

test("reorderItems rechaza pedidos mal formados sin consultar la base", async (t) => {
  const { pizzas, muzza, calls } = setup(t);
  const menuID = String(pizzas._id);

  for (const body of [
    {},
    { menuID },
    { menuID, itemIds: [] },
    { menuID, itemIds: ids(muzza, muzza) },
    { menuID, itemIds: ["no-es-un-id"] },
    { menuID: "no-es-un-id", itemIds: ids(muzza) },
    { menuID: { $ne: null }, itemIds: ids(muzza) },
  ]) {
    const res = await run(reorderItems, body);
    assert.equal(res.statusCode, 400, `debe rechazar ${JSON.stringify(body)}`);
  }
  assert.equal(calls.menuFind.length, 0);
  assert.equal(calls.itemFind.length, 0);
});

// ──────────────────────────────────────────────
// PATCH /api/menus/reorder
// ──────────────────────────────────────────────

test("reorderMenus ordena las secciones", async (t) => {
  const { comidas, bebidas, writes } = setup(t);

  const res = await run(reorderMenus, { sectionIds: ids(bebidas, comidas) });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { sectionIds: ids(bebidas, comidas) });
  assert.deepEqual(summarize(writes.menu), [
    { id: String(bebidas._id), order: 0 },
    { id: String(comidas._id), order: 1 },
  ]);
});

test("reorderMenus pasa una categoría a otra sección, en la posición pedida", async (t) => {
  const { bebidas, empanadas, gaseosas, writes } = setup(t);

  const res = await run(reorderMenus, { sectionID: String(bebidas._id), categoryIds: ids(empanadas, gaseosas) });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.categoryIds, ids(empanadas, gaseosas));
  assert.deepEqual(summarize(writes.menu), [
    { id: String(empanadas._id), order: 0, sectionID: String(bebidas._id) },
    { id: String(gaseosas._id), order: 1 },
  ]);
});

test("reorderMenus con sectionID null ordena las categorías sueltas y saca de su sección a las que llegan", async (t) => {
  const { pizzas, promos, writes } = setup(t);

  const res = await run(reorderMenus, { sectionID: null, categoryIds: ids(pizzas, promos) });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sectionID, null);
  assert.deepEqual(summarize(writes.menu), [
    { id: String(pizzas._id), order: 0, sectionID: null },
    { id: String(promos._id), order: 1 },
  ]);
});

test("reorderMenus no mezcla secciones con categorías ni acepta nada ajeno", async (t) => {
  const { comidas, pizzas, ajena, writes } = setup(t);

  const cases = [
    [{ sectionIds: ids(comidas, pizzas) }, 409],
    [{ sectionIds: ids(comidas, ajena) }, 409],
    [{ sectionID: null, categoryIds: ids(comidas) }, 409],
    [{ sectionID: null, categoryIds: ids(ajena) }, 409],
    [{ sectionID: String(pizzas._id), categoryIds: ids(pizzas) }, 404],
    [{ sectionID: String(ajena._id), categoryIds: ids(pizzas) }, 404],
  ];
  for (const [body, status] of cases) {
    const res = await run(reorderMenus, body);
    assert.equal(res.statusCode, status, `${JSON.stringify(body)} debe responder ${status}`);
  }
  assert.deepEqual(writes.menu, []);
});

test("reorderMenus rechaza pedidos mal formados sin consultar la base", async (t) => {
  const { comidas, pizzas, calls } = setup(t);

  for (const body of [
    {},
    { sectionIds: [] },
    { sectionIds: ids(comidas), categoryIds: ids(pizzas) },
    { categoryIds: ids(pizzas), sectionID: "no-es-un-id" },
    { categoryIds: ids(pizzas, pizzas) },
  ]) {
    const res = await run(reorderMenus, body);
    assert.equal(res.statusCode, 400, `debe rechazar ${JSON.stringify(body)}`);
  }
  assert.equal(calls.menuFind.length, 0);
});

// ──────────────────────────────────────────────
// Altas y move: lo nuevo va al final de su contenedor
// ──────────────────────────────────────────────

test("moveItem: al pasar a otra categoría el producto va al final de esa categoría", async (t) => {
  const catalog = buildCatalog();
  mockQuery(t, Item, "findById", catalog.items);
  mockQuery(t, Item, "findOne", catalog.items);
  mockQuery(t, Menu, "findById", catalog.menus);
  let update;
  t.mock.method(Item, "findByIdAndUpdate", async (_id, received) => { update = received; return received; });

  const res = response();
  await moveItem({
    user: { _id: USER_ID },
    params: { itemID: String(catalog.carne._id) },
    body: { menuID: String(catalog.pizzas._id) },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(update, { menuID: String(catalog.pizzas._id), order: 3 });
});

test("moveItem a la misma categoría no le cambia la posición", async (t) => {
  const catalog = buildCatalog();
  mockQuery(t, Item, "findById", catalog.items);
  mockQuery(t, Menu, "findById", catalog.menus);
  let update;
  t.mock.method(Item, "findByIdAndUpdate", async (_id, received) => { update = received; return received; });

  await moveItem({
    user: { _id: USER_ID },
    params: { itemID: String(catalog.muzza._id) },
    body: { menuID: String(catalog.pizzas._id) },
  }, response());

  assert.deepEqual(update, { menuID: String(catalog.pizzas._id) });
});

test("moveMenu: una categoría que cambia de sección va al final de la nueva", async (t) => {
  const catalog = buildCatalog();
  mockQuery(t, Menu, "findById", catalog.menus);
  mockQuery(t, Menu, "findOne", catalog.menus);
  let update;
  t.mock.method(Menu, "findByIdAndUpdate", async (_id, received) => { update = received; return received; });

  const res = response();
  await moveMenu({
    user: { _id: USER_ID },
    params: { menuID: String(catalog.gaseosas._id) },
    body: { sectionID: String(catalog.comidas._id) },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(update, { sectionID: String(catalog.comidas._id), order: 2 });
});

test("newMenu: una categoría nueva va al final de su sección y una sección, al final de las secciones", async (t) => {
  const catalog = buildCatalog();
  mockQuery(t, Menu, "findById", catalog.menus);
  mockQuery(t, Menu, "findOne", catalog.menus);
  t.mock.method(Menu.prototype, "save", async function save() { return this; });
  t.mock.method(User, "findByIdAndUpdate", async () => ({}));

  const categoria = await run(newMenu, { title: "Postres", sectionID: String(catalog.comidas._id), section: false });
  const seccion = await run(newMenu, { title: "Vinos", section: true });
  const suelta = await run(newMenu, { title: "Extras" });

  assert.equal(categoria.statusCode, 201);
  assert.equal(categoria.body.order, 2, "Comidas ya tiene Pizzas (0) y Empanadas (1)");
  assert.equal(seccion.body.order, 2, "ya hay dos secciones");
  assert.equal(suelta.body.order, 0, "la única suelta (Promos) no tiene order: va después");
});

// ──────────────────────────────────────────────
// El editor recibe el menú en el orden elegido
// ──────────────────────────────────────────────

test("fetchOwnMenu arma secciones, categorías y productos en el orden elegido y avisa que se puede ordenar", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find((plan) => plan.name === name)));
  const catalog = buildCatalog();
  // Entran al revés: el orden de la respuesta sale del campo `order`.
  mockQuery(t, Menu, "find", [...catalog.menus].reverse());
  mockQuery(t, Item, "find", [...catalog.items].reverse());

  const res = response();
  await fetchOwnMenu({
    user: { _id: USER_ID, subscription: "pro", subscriptionExpiresAt: new Date("2099-01-01") },
  }, res);

  assert.equal(res.statusCode, 200);
  const { menu, limits } = res.body;
  assert.deepEqual(menu.secciones.map((sec) => sec.title), ["Comidas", "Bebidas"]);
  assert.deepEqual(menu.secciones[0].categorias.map((cat) => cat.title), ["Pizzas", "Empanadas"]);
  assert.deepEqual(
    menu.secciones[0].categorias[0].items.map((item) => item.title),
    ["Muzzarella", "Napolitana", "Fugazzeta"],
  );
  assert.deepEqual(menu.sinSeccion.map((cat) => cat.title), ["Promos"]);
  assert.equal(limits.canReorder, true);
  assert.equal(limits.canReorder, limits.canEditMenu);
});
