const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const User = require("../src/models/User");
const { cloudinary } = require("../src/config/cloudinary");
const { setMenusHiddenBulk, deleteMenusBulk, deleteMenu } = require("../src/controllers/menuController");

// ──────────────────────────────────────────────
// Acciones en lote sobre secciones y categorías (PATCH /menus/bulk/hidden,
// POST /menus/bulk/delete) y la opción "Eliminar secciones y categorías con
// contenido" (panelSettings.deleteMenusWithContent), que también cambia
// DELETE /menus/:menuID.
// ──────────────────────────────────────────────

const originals = {
  menuFind: Menu.find,
  menuFindById: Menu.findById,
  menuUpdateMany: Menu.updateMany,
  menuDeleteMany: Menu.deleteMany,
  itemFind: Item.find,
  itemCountDocuments: Item.countDocuments,
  itemDeleteMany: Item.deleteMany,
  userFindOne: User.findOne,
  userFindByIdAndUpdate: User.findByIdAndUpdate,
};

test.afterEach(() => {
  Menu.find = originals.menuFind;
  Menu.findById = originals.menuFindById;
  Menu.updateMany = originals.menuUpdateMany;
  Menu.deleteMany = originals.menuDeleteMany;
  Item.find = originals.itemFind;
  Item.countDocuments = originals.itemCountDocuments;
  Item.deleteMany = originals.itemDeleteMany;
  User.findOne = originals.userFindOne;
  User.findByIdAndUpdate = originals.userFindByIdAndUpdate;
});

const oid = () => new mongoose.Types.ObjectId();
const USER_ID = oid();

const makeResponse = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const request = (body, panelSettings = {}) => ({ body, params: {}, user: { _id: USER_ID, panelSettings } });

// Carta en memoria: una sección con dos categorías (una con productos, otra
// vacía) y una categoría suelta vacía. Los mocks responden según el filtro,
// como lo haría Mongo, y registran lo que se borra.
const setupCatalog = () => {
  const seccion = { _id: oid(), userID: USER_ID, section: true, sectionID: null };
  const conItems = { _id: oid(), userID: USER_ID, section: false, sectionID: seccion._id };
  const vaciaEnSeccion = { _id: oid(), userID: USER_ID, section: false, sectionID: seccion._id };
  const suelta = { _id: oid(), userID: USER_ID, section: false, sectionID: null };
  const menus = [seccion, conItems, vaciaEnSeccion, suelta];
  const items = [
    { _id: oid(), menuID: conItems._id, image: "https://res.cloudinary.com/demo/image/upload/a.jpg" },
    { _id: oid(), menuID: conItems._id, image: "" },
  ];

  // Un filtro de id: { $in: [...] } o un id suelto.
  const ids = (filter) => (filter?.$in ?? (filter ? [filter] : [])).map(String);
  const matchesMenu = (menu, filter) => {
    if (filter._id && !ids(filter._id).includes(String(menu._id))) return false;
    if (filter.userID && String(filter.userID) !== String(menu.userID)) return false;
    if (filter.sectionID && !ids(filter.sectionID).includes(String(menu.sectionID))) return false;
    return true;
  };
  const deleted = { menus: [], items: [] };
  const recycled = [];

  Menu.find = (filter) => ({ select: async () => menus.filter((menu) => matchesMenu(menu, filter)) });
  Menu.deleteMany = async (filter) => { deleted.menus.push(...ids(filter._id)); return {}; };
  Item.countDocuments = async (filter) => items.filter((item) => ids(filter.menuID).includes(String(item.menuID))).length;
  Item.find = (filter) => ({
    select: async () => {
      if (filter.image) return []; // recycleDeletedItemImages: nadie más usa la imagen
      return items.filter((item) => ids(filter.menuID).includes(String(item.menuID)));
    },
  });
  Item.deleteMany = async (filter) => { deleted.items.push(...ids(filter._id)); return {}; };
  User.findOne = () => ({ select: async () => null }); // sin banco de prediseñadas
  User.findByIdAndUpdate = async (id, update) => { recycled.push(...update.$addToSet.pendingMenuImages.$each); return {}; };

  return { seccion, conItems, vaciaEnSeccion, suelta, items, deleted, recycled };
};

test("deleteMenusBulk: con Eliminar deshabilitado desde Configuración responde 403", async () => {
  const { suelta, deleted } = setupCatalog();
  const res = makeResponse();
  await deleteMenusBulk(request({ menuIds: [String(suelta._id)] }, { disableMenuDelete: true }), res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(deleted.menus, []);
});

test("deleteMenusBulk: rechaza ids inválidos o vacíos", async () => {
  setupCatalog();
  for (const menuIds of [undefined, [], ["no-es-un-id"]]) {
    const res = makeResponse();
    await deleteMenusBulk(request({ menuIds }), res);
    assert.equal(res.statusCode, 400);
  }
});

test("deleteMenusBulk: si algún id no es del usuario no borra nada (todo o nada)", async () => {
  const { suelta, deleted } = setupCatalog();
  const res = makeResponse();
  await deleteMenusBulk(request({ menuIds: [String(suelta._id), String(oid())] }), res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(deleted.menus, []);
});

test("deleteMenusBulk sin la opción: una categoría con productos no se elimina, ni nada del lote", async () => {
  const { conItems, suelta, deleted } = setupCatalog();
  const res = makeResponse();
  await deleteMenusBulk(request({ menuIds: [String(conItems._id), String(suelta._id)] }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Configuración/);
  assert.deepEqual(deleted.menus, []);
  assert.deepEqual(deleted.items, []);
});

test("deleteMenusBulk sin la opción: una sección con categorías que no vienen en el lote no se elimina", async () => {
  const { seccion, vaciaEnSeccion, deleted } = setupCatalog();
  const res = makeResponse();
  // Falta conItems, que también es de la sección.
  await deleteMenusBulk(request({ menuIds: [String(seccion._id), String(vaciaEnSeccion._id)] }), res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(deleted.menus, []);
});

test("deleteMenusBulk sin la opción: elimina las vacías", async () => {
  const { vaciaEnSeccion, suelta, deleted } = setupCatalog();
  const res = makeResponse();
  await deleteMenusBulk(request({ menuIds: [String(vaciaEnSeccion._id), String(suelta._id)] }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { deletedMenus: 2, deletedItems: 0 });
  assert.deepEqual(deleted.menus.sort(), [String(vaciaEnSeccion._id), String(suelta._id)].sort());
});

test("deleteMenusBulk con la opción: elimina la sección con sus categorías y productos, y recicla las imágenes", async () => {
  const { seccion, conItems, vaciaEnSeccion, items, deleted, recycled } = setupCatalog();
  const res = makeResponse();
  await deleteMenusBulk(request({ menuIds: [String(seccion._id)] }, { deleteMenusWithContent: true }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { deletedMenus: 3, deletedItems: 2 });
  assert.deepEqual(
    deleted.menus.sort(),
    [String(seccion._id), String(conItems._id), String(vaciaEnSeccion._id)].sort(),
  );
  assert.deepEqual(deleted.items.sort(), items.map((item) => String(item._id)).sort());
  assert.deepEqual(recycled, ["https://res.cloudinary.com/demo/image/upload/a.jpg"]);
});

test("deleteMenusBulk con la opción: una imagen prediseñada ajena no vuelve a pendientes ni se borra de Cloudinary", async () => {
  const { seccion, items, recycled } = setupCatalog();
  const presetUrl = "https://res.cloudinary.com/demo/image/upload/prediseñada.jpg";
  items[1].image = presetUrl;
  User.findOne = () => ({ select: async () => ({ _id: oid(), pendingMenuImages: [presetUrl] }) });
  let destroyCalled = false;
  const originalDestroy = cloudinary.uploader.destroy;
  cloudinary.uploader.destroy = async () => { destroyCalled = true; return { result: "ok" }; };

  try {
    const res = makeResponse();
    await deleteMenusBulk(request({ menuIds: [String(seccion._id)] }, { deleteMenusWithContent: true }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deletedItems, 2);
    // Solo la imagen propia vuelve a pendientes; la prediseñada es del banco.
    assert.deepEqual(recycled, ["https://res.cloudinary.com/demo/image/upload/a.jpg"]);
    assert.equal(destroyCalled, false);
  } finally {
    cloudinary.uploader.destroy = originalDestroy;
  }
});

test("deleteMenu sin la opción sigue rechazando una categoría con productos", async () => {
  const { conItems, deleted } = setupCatalog();
  Menu.findById = () => ({ select: async () => conItems });
  const res = makeResponse();
  await deleteMenu({ ...request({}), params: { menuID: String(conItems._id) } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /2 producto/);
  assert.deepEqual(deleted.menus, []);
});

test("deleteMenu con la opción elimina la categoría con sus productos", async () => {
  const { conItems, items, deleted } = setupCatalog();
  Menu.findById = () => ({ select: async () => conItems });
  const res = makeResponse();
  await deleteMenu({ ...request({}, { deleteMenusWithContent: true }), params: { menuID: String(conItems._id) } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedItems, 2);
  assert.deepEqual(deleted.menus, [String(conItems._id)]);
  assert.deepEqual(deleted.items.sort(), items.map((item) => String(item._id)).sort());
});

test("setMenusHiddenBulk oculta las secciones y categorías del lote", async () => {
  const { seccion, suelta } = setupCatalog();
  let updateArgs;
  Menu.updateMany = async (filter, update) => { updateArgs = { filter, update }; return {}; };
  const menuIds = [String(seccion._id), String(suelta._id)];
  const res = makeResponse();
  await setMenusHiddenBulk(request({ menuIds, hidden: true }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { hidden: true, updatedCount: 2 });
  assert.deepEqual(updateArgs.filter._id.$in, menuIds);
  assert.deepEqual(updateArgs.update, { $set: { hidden: true } });
});

test("setMenusHiddenBulk exige hidden booleano", async () => {
  const { suelta } = setupCatalog();
  const res = makeResponse();
  await setMenusHiddenBulk(request({ menuIds: [String(suelta._id)], hidden: "sí" }), res);
  assert.equal(res.statusCode, 400);
});
