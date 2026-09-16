// "Plantillas de menúes" (tarjeta Trello): el usuario presetImagesUser
// también actúa como dueño del menú plantilla. Mismo estilo de mocks que
// itemImageManager.test.js — sin conexión real a Mongo.
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

const fakeMenu = ({ id, title = "Categoría", description = "", image = "", section = false, sectionID = null, hidden = false, code = "OLD1" }) => ({
  _id: fakeId(id), title, description, image, section, hidden, code,
  sectionID: sectionID ? fakeId(sectionID) : null,
  toObject() { return { title: this.title, description: this.description, image: this.image, section: this.section, sectionID: this.sectionID, code: this.code }; },
  save: async () => {},
});

const fakeItem = ({ id, menuID, title = "Producto", price = 100, hidden = false, code = "OLD2", ...rest }) => ({
  _id: fakeId(id), menuID: fakeId(menuID), title, price, hidden, code,
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
      availabilitySchedule: this.availabilitySchedule,
    };
  },
  save: async () => {},
});

// Instala Menu.find/Item.find devolviendo el catálogo plantilla dado, más
// arrays vacíos para los fetches secundarios (menús propios del usuario
// destino y códigos hermanos al generar código automático).
const installOwnerCatalog = (ownerMenus, ownerItems) => {
  Menu.find = async (filter) => (filter.hidden === false ? ownerMenus : []);
  Item.find = async (filter) => (filter.hidden === false ? ownerItems : []);
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

// ──────────────────────────────────────────────
// getMenuTemplates
// ──────────────────────────────────────────────

test("getMenuTemplates devuelve menú vacío si no hay usuario marcado como plantilla", async () => {
  User.findOne = (filter) => {
    assert.deepEqual(filter, { presetImagesUser: true });
    return { select: async () => null };
  };
  const res = makeResponse();
  await getMenuTemplates({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { secciones: [], sinSeccion: [] });
});

test("getMenuTemplates arma secciones → categorías → items del usuario plantilla, sin ocultos", async () => {
  User.findOne = () => ({ select: async () => ({ _id: fakeId("owner") }) });
  const sec = fakeMenu({ id: "sec-1", title: "Bebidas", section: true });
  const catInSec = fakeMenu({ id: "cat-1", title: "Gaseosas", sectionID: "sec-1" });
  const catLoose = fakeMenu({ id: "cat-2", title: "Postres" });
  let receivedMenuFilter;
  let receivedItemFilter;
  Menu.find = async (filter) => { receivedMenuFilter = filter; return [sec, catInSec, catLoose]; };
  Item.find = async (filter) => {
    receivedItemFilter = filter;
    return [
      fakeItem({ id: "item-1", menuID: "cat-1", title: "Coca-Cola" }),
      fakeItem({ id: "item-2", menuID: "cat-2", title: "Flan" }),
    ];
  };

  const res = makeResponse();
  await getMenuTemplates({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(receivedMenuFilter.hidden, false);
  assert.equal(receivedMenuFilter.userID.toString(), "owner");
  assert.equal(receivedItemFilter.hidden, false);
  assert.equal(res.body.secciones.length, 1);
  assert.equal(res.body.secciones[0].title, "Bebidas");
  assert.equal(res.body.secciones[0].categorias.length, 1);
  assert.equal(res.body.secciones[0].categorias[0].title, "Gaseosas");
  assert.equal(res.body.secciones[0].categorias[0].items[0].title, "Coca-Cola");
  assert.equal(res.body.sinSeccion.length, 1);
  assert.equal(res.body.sinSeccion[0].title, "Postres");
  assert.equal(res.body.sinSeccion[0].items[0].title, "Flan");
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
// copyMenuTemplates — copiado
// ──────────────────────────────────────────────

test("copyMenuTemplates copia una categoría completa con todos sus productos, con código y dueño nuevos", async () => {
  User.findOne = () => ({ select: async () => ({ _id: fakeId("owner") }) });
  const cat = fakeMenu({ id: "cat-1", title: "Pizzas", code: "PIZZ" });
  const item1 = fakeItem({ id: "item-1", menuID: "cat-1", title: "Muzzarella", price: 500, code: "MUZZ" });
  const item2 = fakeItem({ id: "item-2", menuID: "cat-1", title: "Napolitana", price: 600, code: "NAPO" });
  installOwnerCatalog([cat], [item1, item2]);
  const { createdMenus, createdItems } = installCreators();
  User.findByIdAndUpdate = async () => {};

  const req = { body: { categoryIds: ["cat-1"] }, user: { _id: fakeId("user-1"), plan: undefined }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { createdSections: 0, createdCategories: 1, createdItems: 2 });

  assert.equal(createdMenus.length, 1);
  assert.equal(createdMenus[0].title, "Pizzas");
  assert.equal(createdMenus[0].userID, req.user._id);
  assert.notEqual(createdMenus[0].code, "PIZZ");

  assert.equal(createdItems.length, 2);
  assert.deepEqual(createdItems.map((i) => i.title).sort(), ["Muzzarella", "Napolitana"]);
  createdItems.forEach((created, idx) => {
    assert.equal(created.menuID, createdMenus[0]._id);
    assert.notEqual(created.code, [item1, item2][idx].code);
  });
});

test("copyMenuTemplates copia una sección entera y remapea sectionID a la sección recién creada", async () => {
  User.findOne = () => ({ select: async () => ({ _id: fakeId("owner") }) });
  const sec = fakeMenu({ id: "sec-1", title: "Bebidas", section: true });
  const cat = fakeMenu({ id: "cat-1", title: "Gaseosas", sectionID: "sec-1" });
  const item = fakeItem({ id: "item-1", menuID: "cat-1", title: "Sprite" });
  installOwnerCatalog([sec, cat], [item]);
  const { createdMenus } = installCreators();
  User.findByIdAndUpdate = async () => {};

  const req = { body: { sectionIds: ["sec-1"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { createdSections: 1, createdCategories: 1, createdItems: 1 });
  const newSection = createdMenus.find((m) => m.section === true);
  const newCategory = createdMenus.find((m) => m.section === false);
  assert.equal(newCategory.sectionID, newSection._id);
});

test("copyMenuTemplates copia un producto suelto dentro de una copia de su categoría, sin arrastrar sus hermanos", async () => {
  User.findOne = () => ({ select: async () => ({ _id: fakeId("owner") }) });
  const cat = fakeMenu({ id: "cat-1", title: "Postres" });
  const wanted = fakeItem({ id: "item-1", menuID: "cat-1", title: "Flan" });
  const sibling = fakeItem({ id: "item-2", menuID: "cat-1", title: "Helado" });
  installOwnerCatalog([cat], [wanted, sibling]);
  const { createdMenus, createdItems } = installCreators();
  User.findByIdAndUpdate = async () => {};

  const req = { body: { itemIds: ["item-1"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { createdSections: 0, createdCategories: 1, createdItems: 1 });
  assert.equal(createdMenus[0].title, "Postres");
  assert.equal(createdItems.length, 1);
  assert.equal(createdItems[0].title, "Flan");
});

test("copyMenuTemplates ignora ids que no pertenecen al usuario plantilla o están ocultos", async () => {
  User.findOne = () => ({ select: async () => ({ _id: fakeId("owner") }) });
  // El catálogo plantilla real solo tiene "cat-1" — "cat-ajena" no existe ahí
  // (podría pertenecer a otro usuario o estar oculta).
  const cat = fakeMenu({ id: "cat-1", title: "Real" });
  installOwnerCatalog([cat], []);
  installCreators();

  const req = { body: { categoryIds: ["cat-ajena"] }, user: { _id: fakeId("user-1") }, plan: { features: { item_limit: null, programacion_productos: true } } };
  const res = makeResponse();
  await copyMenuTemplates(req, res);

  assert.equal(res.statusCode, 400);
});

test("copyMenuTemplates respeta el límite de productos del plan destino sin escribir nada", async () => {
  User.findOne = () => ({ select: async () => ({ _id: fakeId("owner") }) });
  const cat = fakeMenu({ id: "cat-1", title: "Pizzas" });
  const item1 = fakeItem({ id: "item-1", menuID: "cat-1", title: "Muzzarella" });
  const item2 = fakeItem({ id: "item-2", menuID: "cat-1", title: "Napolitana" });
  installOwnerCatalog([cat], [item1, item2]);
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
  User.findOne = () => ({ select: async () => ({ _id: fakeId("owner") }) });
  const cat = fakeMenu({ id: "cat-1", title: "Ofertas" });
  const scheduled = fakeItem({
    id: "item-1", menuID: "cat-1", title: "Combo",
    offerPrice: 300, offerRange: { from: new Date("2026-01-01"), to: new Date("2026-01-31") },
    availabilitySchedule: { enabled: true },
  });
  installOwnerCatalog([cat], [scheduled]);
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
