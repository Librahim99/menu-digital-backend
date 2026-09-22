// "Plantillas de menúes" (tarjeta Trello): el usuario presetImagesUser
// también actúa como dueño del menú plantilla. Las copias conservan el
// código original de la plantilla para poder reconocer qué ya se importó
// (reutilizar categoría/sección existente, no recrear un producto ya
// copiado) — ver menuTemplateController.js. Mismo estilo de mocks que
// itemImageManager.test.js, sin conexión real a Mongo.
const test = require("node:test");
const assert = require("node:assert/strict");
const Item = require("../src/models/Item");
const Menu = require("../src/models/Menu");
const User = require("../src/models/User");
const { getMenuTemplates, copyMenuTemplates } = require("../src/controllers/menuTemplateController");

const originalMenuFind = Menu.find;
const originalMenuCreate = Menu.create;
const originalItemFind = Item.find;
const originalItemCreate = Item.create;
const originalItemCountDocuments = Item.countDocuments;
const originalUserFindOne = User.findOne;
const originalUserFindByIdAndUpdate = User.findByIdAndUpdate;

test.afterEach(() => {
  Menu.find = originalMenuFind;
  Menu.create = originalMenuCreate;
  Item.find = originalItemFind;
  Item.create = originalItemCreate;
  Item.countDocuments = originalItemCountDocuments;
  User.findOne = originalUserFindOne;
  User.findByIdAndUpdate = originalUserFindByIdAndUpdate;
});

const makeResponse = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const fakeId = (id) => ({
  toString: () => id,
  equals(other) { return id === (other && typeof other.toString === "function" ? other.toString() : String(other)); },
});

const fakeMenu = ({ id, code, title = "Categoría", description = "", image = "", section = false, sectionID = null, hidden = false, order }) => ({
  _id: fakeId(id), title, description, image, section, hidden, code, order,
  sectionID: sectionID ? fakeId(sectionID) : null,
  toObject() { return { title: this.title, description: this.description, image: this.image, section: this.section, sectionID: this.sectionID, code: this.code }; },
  save: async () => {},
});

const fakeItem = ({ id, menuID, code, title = "Producto", price = 100, hidden = false, ...rest }) => ({
  _id: fakeId(id), menuID: fakeId(menuID), title, price, hidden, code, order: rest.order,
  description: rest.description ?? "",
  offerPrice: rest.offerPrice ?? null,
  offerRange: rest.offerRange ?? { from: null, to: null },
  options: rest.options ?? {},
  image: rest.image ?? "",
  isExtra: rest.isExtra ?? false,
  recommended: rest.recommended ?? false,
  apt: rest.apt ?? {},
  availabilitySchedule: rest.availabilitySchedule ?? { enabled: false },
  toObject() {
    return {
      title: this.title, description: this.description, price: this.price,
      offerPrice: this.offerPrice, offerRange: this.offerRange, options: this.options,
      image: this.image, isExtra: this.isExtra, recommended: this.recommended, apt: this.apt,
      availabilitySchedule: this.availabilitySchedule, code: this.code,
    };
  },
  save: async () => {},
});

// Instala Menu.find/Item.find distinguiendo el catálogo plantilla (llamado
// con hidden:false, igual que en el controller) del catálogo propio del
// usuario destino (sin ese filtro) — mismo criterio que usa el controller
// para decidir a quién le está preguntando.
const installCatalogs = ({ ownerMenus = [], ownerItems = [], ownMenus = [], ownItems = [] }) => {
  Menu.find = async (filter) => (filter.hidden === false ? ownerMenus : ownMenus);
  Item.find = async (filter) => (filter.hidden === false ? ownerItems : ownItems);
};

const installCreators = () => {
  const createdMenus = [];
  const createdItems = [];
  Menu.create = async (data) => {
    const doc = { _id: fakeId(`new-menu-${createdMenus.length}`), ...data, save: async () => {} };
    createdMenus.push(doc);
    return doc;
  };
  Item.create = async (data) => {
    const doc = { _id: fakeId(`new-item-${createdItems.length}`), ...data, save: async () => {} };
    createdItems.push(doc);
    return doc;
  };
  return { createdMenus, createdItems };
};

const withOwner = () => { User.findOne = () => ({ select: async () => ({ _id: fakeId("owner") }) }); };

// ──────────────────────────────────────────────
// getMenuTemplates
// ──────────────────────────────────────────────

test("getMenuTemplates devuelve menú vacío si no hay usuario marcado como plantilla", async () => {
  User.findOne = (filter) => {
    assert.deepEqual(filter, { presetImagesUser: true });
    return { select: async () => null };
  };
  const res = makeResponse();
  await getMenuTemplates({ user: { _id: fakeId("user-1") } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { secciones: [], sinSeccion: [] });
});

test("getMenuTemplates arma secciones → categorías → items del usuario plantilla, sin ocultos", async () => {
  withOwner();
  const sec = fakeMenu({ id: "sec-1", title: "Bebidas", section: true, code: "SEC1" });
  const catInSec = fakeMenu({ id: "cat-1", title: "Gaseosas", sectionID: "sec-1", code: "CAT1" });
  const catLoose = fakeMenu({ id: "cat-2", title: "Postres", code: "CAT2" });
  installCatalogs({
    ownerMenus: [sec, catInSec, catLoose],
    ownerItems: [
      fakeItem({ id: "item-1", menuID: "cat-1", title: "Coca-Cola", code: "COCA" }),
      fakeItem({ id: "item-2", menuID: "cat-2", title: "Flan", code: "FLAN" }),
    ],
  });

  const res = makeResponse();
  await getMenuTemplates({ user: { _id: fakeId("user-1") } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.secciones.length, 1);
  assert.equal(res.body.secciones[0].title, "Bebidas");
  assert.equal(res.body.secciones[0].categorias.length, 1);
  assert.equal(res.body.secciones[0].categorias[0].title, "Gaseosas");
  assert.equal(res.body.secciones[0].categorias[0].items[0].title, "Coca-Cola");
  assert.equal(res.body.sinSeccion.length, 1);
  assert.equal(res.body.sinSeccion[0].title, "Postres");
  assert.equal(res.body.sinSeccion[0].items[0].title, "Flan");
});

test("getMenuTemplates oculta productos ya importados (mismo código) y la categoría si no le queda nada pendiente", async () => {
  withOwner();
  const catA = fakeMenu({ id: "cat-1", title: "Pizzas", code: "PIZZ" });
  const catB = fakeMenu({ id: "cat-2", title: "Postres", code: "POST" });
  installCatalogs({
    ownerMenus: [catA, catB],
    ownerItems: [
      fakeItem({ id: "item-1", menuID: "cat-1", title: "Muzzarella", code: "MUZZ" }),
      fakeItem({ id: "item-2", menuID: "cat-1", title: "Napolitana", code: "NAPO" }),
      fakeItem({ id: "item-3", menuID: "cat-2", title: "Flan", code: "FLAN" }),
    ],
    // El usuario ya tiene "Muzzarella" (MUZZ) y las dos únicas de "Postres" (FLAN).
    ownMenus: [fakeMenu({ id: "own-1", code: "PIZZ" }), fakeMenu({ id: "own-2", code: "POST" })],
    ownItems: [fakeItem({ id: "own-item-1", menuID: "own-1", code: "MUZZ" }), fakeItem({ id: "own-item-2", menuID: "own-2", code: "FLAN" })],
  });

  const res = makeResponse();
  await getMenuTemplates({ user: { _id: fakeId("user-1") } }, res);

  assert.equal(res.statusCode, 200);
  // "Postres" ya no tiene nada pendiente → desaparece del todo.
  assert.equal(res.body.sinSeccion.length, 1);
  assert.equal(res.body.sinSeccion[0].title, "Pizzas");
  // Dentro de "Pizzas" solo queda "Napolitana" (Muzzarella ya está importada).
  assert.deepEqual(res.body.sinSeccion[0].items.map((i) => i.title), ["Napolitana"]);
});

// ──────────────────────────────────────────────
// copyMenuTemplates — validación de payload
// ──────────────────────────────────────────────

test("copyMenuTemplates rechaza una selección vacía sin consultar la base", async () => {
  User.findOne = () => assert.fail("No debe consultar sin selección");
  const res = makeResponse();
  await copyMenuTemplates({ body: {}, user: { _id: fakeId("user-1") } }, res);
  assert.equal(res.statusCode, 400);
});

test("copyMenuTemplates devuelve 404 si no hay menú plantilla configurado", async () => {
  User.findOne = () => ({ select: async () => null });
  const res = makeResponse();
  await copyMenuTemplates({ body: { categoryIds: ["cat-1"] }, user: { _id: fakeId("user-1") } }, res);
  assert.equal(res.statusCode, 404);
});

// ──────────────────────────────────────────────
// copyMenuTemplates — copiado con código original
// ──────────────────────────────────────────────

test("copyMenuTemplates copia una categoría completa conservando el código original de la plantilla", async () => {
  withOwner();
  const cat = fakeMenu({ id: "cat-1", title: "Pizzas", code: "PIZZ" });
  const item1 = fakeItem({ id: "item-1", menuID: "cat-1", title: "Muzzarella", price: 500, code: "MUZZ" });
  const item2 = fakeItem({ id: "item-2", menuID: "cat-1", title: "Napolitana", price: 600, code: "NAPO" });
  installCatalogs({ ownerMenus: [cat], ownerItems: [item1, item2] });
  const { createdMenus, createdItems } = installCreators();
  User.findByIdAndUpdate = async () => {};

  const req = { body: { categoryIds: ["cat-1"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { createdSections: 0, createdCategories: 1, createdItems: 2 });

  assert.equal(createdMenus.length, 1);
  assert.equal(createdMenus[0].title, "Pizzas");
  assert.equal(createdMenus[0].userID, req.user._id);
  assert.equal(createdMenus[0].code, "PIZZ");

  assert.equal(createdItems.length, 2);
  assert.deepEqual(createdItems.map((i) => i.code).sort(), ["MUZZ", "NAPO"]);
});

test("copyMenuTemplates copia una sección entera y remapea sectionID a la sección recién creada", async () => {
  withOwner();
  const sec = fakeMenu({ id: "sec-1", title: "Bebidas", section: true, code: "SBEB" });
  const cat = fakeMenu({ id: "cat-1", title: "Gaseosas", sectionID: "sec-1", code: "GASE" });
  const item = fakeItem({ id: "item-1", menuID: "cat-1", title: "Sprite", code: "SPRI" });
  installCatalogs({ ownerMenus: [sec, cat], ownerItems: [item] });
  const { createdMenus } = installCreators();
  User.findByIdAndUpdate = async () => {};

  const req = { body: { sectionIds: ["sec-1"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { createdSections: 1, createdCategories: 1, createdItems: 1 });
  const newSection = createdMenus.find((m) => m.section === true);
  const newCategory = createdMenus.find((m) => m.section === false);
  assert.equal(newSection.code, "SBEB");
  assert.equal(newCategory.code, "GASE");
  assert.equal(newCategory.sectionID, newSection._id);
});

test("copyMenuTemplates copia un producto suelto dentro de una copia de su categoría, sin arrastrar sus hermanos", async () => {
  withOwner();
  const cat = fakeMenu({ id: "cat-1", title: "Postres", code: "POST" });
  const wanted = fakeItem({ id: "item-1", menuID: "cat-1", title: "Flan", code: "FLAN" });
  const sibling = fakeItem({ id: "item-2", menuID: "cat-1", title: "Helado", code: "HELA" });
  installCatalogs({ ownerMenus: [cat], ownerItems: [wanted, sibling] });
  const { createdMenus, createdItems } = installCreators();
  User.findByIdAndUpdate = async () => {};

  const req = { body: { itemIds: ["item-1"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { createdSections: 0, createdCategories: 1, createdItems: 1 });
  assert.equal(createdMenus[0].code, "POST");
  assert.equal(createdItems.length, 1);
  assert.equal(createdItems[0].code, "FLAN");
});

test("copyMenuTemplates ignora ids que no pertenecen al usuario plantilla o están ocultos", async () => {
  withOwner();
  const cat = fakeMenu({ id: "cat-1", title: "Real", code: "REAL" });
  installCatalogs({ ownerMenus: [cat], ownerItems: [] });
  installCreators();

  const req = { body: { categoryIds: ["cat-ajena"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 400);
});

test("copyMenuTemplates respeta el límite de productos del plan destino sin escribir nada", async () => {
  withOwner();
  const cat = fakeMenu({ id: "cat-1", title: "Pizzas", code: "PIZZ" });
  const item1 = fakeItem({ id: "item-1", menuID: "cat-1", title: "Muzzarella", code: "MUZZ" });
  const item2 = fakeItem({ id: "item-2", menuID: "cat-1", title: "Napolitana", code: "NAPO" });
  installCatalogs({ ownerMenus: [cat], ownerItems: [item1, item2] });
  const { createdMenus, createdItems } = installCreators();
  Item.countDocuments = async () => 0; // el usuario destino ya no tiene productos propios

  // Límite de 1 producto, la categoría trae 2 → no debe alcanzar.
  const req = { body: { categoryIds: ["cat-1"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: 1, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(createdMenus.length, 0);
  assert.equal(createdItems.length, 0);
});

test("copyMenuTemplates quita programación de horario/oferta si el plan destino no la incluye", async () => {
  withOwner();
  const cat = fakeMenu({ id: "cat-1", title: "Ofertas", code: "OFER" });
  const scheduled = fakeItem({
    id: "item-1", menuID: "cat-1", title: "Combo", code: "COMB",
    offerPrice: 300, offerRange: { from: new Date("2026-01-01"), to: new Date("2026-01-31") },
    availabilitySchedule: { enabled: true },
  });
  installCatalogs({ ownerMenus: [cat], ownerItems: [scheduled] });
  const { createdItems } = installCreators();
  User.findByIdAndUpdate = async () => {};

  const req = { body: { categoryIds: ["cat-1"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: false } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(createdItems[0].offerPrice, null);
  assert.deepEqual(createdItems[0].offerRange, { from: null, to: null });
  assert.equal(createdItems[0].availabilitySchedule, undefined);
});

// ──────────────────────────────────────────────
// copyMenuTemplates — deduplicación por código (corrección post-testing)
// ──────────────────────────────────────────────

test("copyMenuTemplates reutiliza la categoría ya importada (mismo código) en vez de duplicarla", async () => {
  withOwner();
  const cat = fakeMenu({ id: "cat-1", title: "Tés", code: "TES1" });
  const already = fakeItem({ id: "item-1", menuID: "cat-1", title: "Earl Grey", code: "EARL" });
  const nuevo = fakeItem({ id: "item-2", menuID: "cat-1", title: "Chai", code: "CHAI" });
  // El usuario ya había importado "Earl Grey" antes, dentro de una copia
  // previa de "Tés" (mismo código de categoría TES1).
  const existingCat = fakeMenu({ id: "own-cat-1", title: "Tés", code: "TES1" });
  installCatalogs({
    ownerMenus: [cat],
    ownerItems: [already, nuevo],
    ownMenus: [existingCat],
    ownItems: [fakeItem({ id: "own-item-1", menuID: "own-cat-1", code: "EARL" })],
  });
  const { createdMenus, createdItems } = installCreators();
  User.findByIdAndUpdate = async () => {};

  // Selecciona el producto suelto "Chai" (no toda la categoría).
  const req = { body: { itemIds: ["item-2"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { createdSections: 0, createdCategories: 0, createdItems: 1 });
  assert.equal(createdMenus.length, 0, "no debe crear una segunda categoría 'Tés'");
  assert.equal(createdItems.length, 1);
  assert.equal(createdItems[0].code, "CHAI");
  assert.equal(createdItems[0].menuID, existingCat._id, "el producto nuevo debe caer en la categoría ya existente");
});

test("copyMenuTemplates no vuelve a copiar un producto ya importado (mismo código)", async () => {
  withOwner();
  const cat = fakeMenu({ id: "cat-1", title: "Pizzas", code: "PIZZ" });
  const already = fakeItem({ id: "item-1", menuID: "cat-1", title: "Muzzarella", code: "MUZZ" });
  const nuevo = fakeItem({ id: "item-2", menuID: "cat-1", title: "Napolitana", code: "NAPO" });
  const existingCat = fakeMenu({ id: "own-cat-1", title: "Pizzas", code: "PIZZ" });
  installCatalogs({
    ownerMenus: [cat],
    ownerItems: [already, nuevo],
    ownMenus: [existingCat],
    ownItems: [fakeItem({ id: "own-item-1", menuID: "own-cat-1", code: "MUZZ" })],
  });
  const { createdMenus, createdItems } = installCreators();
  User.findByIdAndUpdate = async () => {};

  // Selecciona la categoría COMPLETA (las dos), pero una ya estaba importada.
  const req = { body: { categoryIds: ["cat-1"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { createdSections: 0, createdCategories: 0, createdItems: 1 });
  assert.equal(createdMenus.length, 0);
  assert.equal(createdItems.length, 1);
  assert.equal(createdItems[0].code, "NAPO");
});

test("copyMenuTemplates devuelve 400 si toda la selección ya estaba importada", async () => {
  withOwner();
  const cat = fakeMenu({ id: "cat-1", title: "Pizzas", code: "PIZZ" });
  const already = fakeItem({ id: "item-1", menuID: "cat-1", title: "Muzzarella", code: "MUZZ" });
  const existingCat = fakeMenu({ id: "own-cat-1", title: "Pizzas", code: "PIZZ" });
  installCatalogs({
    ownerMenus: [cat],
    ownerItems: [already],
    ownMenus: [existingCat],
    ownItems: [fakeItem({ id: "own-item-1", menuID: "own-cat-1", code: "MUZZ" })],
  });
  const { createdMenus, createdItems } = installCreators();

  const req = { body: { itemIds: ["item-1"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(createdMenus.length, 0);
  assert.equal(createdItems.length, 0);
});

// ──────────────────────────────────────────────
// copyMenuTemplates — orden (tarjeta "Poder ordenar el menú")
// ──────────────────────────────────────────────

test("copyMenuTemplates copia en el orden de la plantilla, al final del menú del usuario", async () => {
  withOwner();
  // En la plantilla "Postres" va antes que "Pizzas", y el flan antes que el helado.
  const pizzas = fakeMenu({ id: "cat-1", title: "Pizzas", code: "PIZZ", order: 1 });
  const postres = fakeMenu({ id: "cat-2", title: "Postres", code: "POST", order: 0 });
  installCatalogs({
    ownerMenus: [pizzas, postres],
    ownerItems: [
      fakeItem({ id: "item-1", menuID: "cat-2", title: "Helado", code: "HELA", order: 1 }),
      fakeItem({ id: "item-2", menuID: "cat-1", title: "Muzzarella", code: "MUZZ", order: 0 }),
      fakeItem({ id: "item-3", menuID: "cat-2", title: "Flan", code: "FLAN", order: 0 }),
    ],
    // Las categorías sueltas del usuario: la última está en la posición 2.
    ownMenus: [fakeMenu({ id: "own-1", code: "MIA1", order: 2 }), fakeMenu({ id: "own-2", code: "MIA2" })],
  });
  const { createdMenus, createdItems } = installCreators();
  User.findByIdAndUpdate = async () => {};

  const req = { body: { categoryIds: ["cat-1", "cat-2"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(createdMenus.map((m) => [m.title, m.order]), [["Postres", 3], ["Pizzas", 4]]);
  assert.deepEqual(
    createdItems.map((i) => [i.title, i.order]),
    [["Flan", 0], ["Helado", 1], ["Muzzarella", 0]],
  );
});
