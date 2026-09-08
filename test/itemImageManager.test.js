// Gestor de imágenes: /api/items/lite, /api/items/images/pending y sobre
// todo /api/items/images/assign (el diff toAdd/toRemove + el hueco de
// seguridad de no poder "robar" una imagen pendiente de otro usuario). No
// se testea uploadLibraryImage acá — mismo criterio que uploadDraftImage/
// uploadImage, no testeados a nivel de subida a Cloudinary en este repo.
const test = require("node:test");
const assert = require("node:assert/strict");
const Item = require("../src/models/Item");
const Menu = require("../src/models/Menu");
const User = require("../src/models/User");
const {
  getLiteItems, getPendingImages, assignImages, checkImageQuota, deleteItem, deleteItemsBulk, MAX_BULK_ITEMS,
} = require("../src/controllers/itemController");

const originalItemFind = Item.find;
const originalItemFindById = Item.findById;
const originalItemFindByIdAndDelete = Item.findByIdAndDelete;
const originalItemDeleteMany = Item.deleteMany;
const originalItemBulkWrite = Item.bulkWrite;
const originalItemCountDocuments = Item.countDocuments;
const originalMenuFind = Menu.find;
const originalMenuFindById = Menu.findById;
const originalUserFindById = User.findById;
const originalUserFindByIdAndUpdate = User.findByIdAndUpdate;

test.afterEach(() => {
  Item.find = originalItemFind;
  Item.findById = originalItemFindById;
  Item.findByIdAndDelete = originalItemFindByIdAndDelete;
  Item.deleteMany = originalItemDeleteMany;
  Item.bulkWrite = originalItemBulkWrite;
  Item.countDocuments = originalItemCountDocuments;
  Menu.find = originalMenuFind;
  Menu.findById = originalMenuFindById;
  User.findById = originalUserFindById;
  User.findByIdAndUpdate = originalUserFindByIdAndUpdate;
});

const makeResponse = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

// ──────────────────────────────────────────────
// getLiteItems / getPendingImages
// ──────────────────────────────────────────────

test("getLiteItems devuelve solo los items de los menús del usuario, con los campos livianos", async () => {
  let receivedFilter;
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  Item.find = (filter) => {
    receivedFilter = filter;
    return { select: async () => [{ _id: "item-1", title: "Pizza", code: "P1", image: "" }] };
  };

  const req = { user: { _id: "user-1" } };
  const res = makeResponse();
  await getLiteItems(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(receivedFilter, { menuID: { $in: ["menu-A"] } });
  assert.deepEqual(res.body, [{ _id: "item-1", title: "Pizza", code: "P1", image: "" }]);
});

test("getPendingImages devuelve el array de pendientes del usuario", async () => {
  User.findById = () => ({ select: async () => ({ pendingMenuImages: ["url-1", "url-2"] }) });
  const req = { user: { _id: "user-1" } };
  const res = makeResponse();
  await getPendingImages(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { pendingImages: ["url-1", "url-2"] });
});

// ──────────────────────────────────────────────
// assignImages — validación de payload (sin tocar la base)
// ──────────────────────────────────────────────

test("assignImages rechaza un itemID repetido entre dos cambios distintos", async () => {
  const req = {
    user: { _id: "user-1" },
    body: {
      changes: [
        { imageUrl: "url-a", itemIDs: ["item-1"] },
        { imageUrl: "url-b", itemIDs: ["item-1"] },
      ],
    },
  };
  const res = makeResponse();
  await assignImages(req, res);
  assert.equal(res.statusCode, 400);
});

test("assignImages rechaza una imageUrl repetida entre dos cambios distintos", async () => {
  const req = {
    user: { _id: "user-1" },
    body: {
      changes: [
        { imageUrl: "url-a", itemIDs: ["item-1"] },
        { imageUrl: "url-a", itemIDs: ["item-2"] },
      ],
    },
  };
  const res = makeResponse();
  await assignImages(req, res);
  assert.equal(res.statusCode, 400);
});

test("assignImages rechaza más cambios que MAX_BULK_ITEMS", async () => {
  const req = {
    user: { _id: "user-1" },
    body: {
      changes: Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, i) => ({ imageUrl: `url-${i}`, itemIDs: [] })),
    },
  };
  const res = makeResponse();
  await assignImages(req, res);
  assert.equal(res.statusCode, 400);
});

// ──────────────────────────────────────────────
// assignImages — ownership
// ──────────────────────────────────────────────

test("assignImages rechaza una imagen que no está en pendientes del usuario ni asignada a un producto suyo (robo de imagen ajena)", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [] }) });
  Item.find = () => ({
    select: async (fields) => {
      if (fields === "_id menuID") return [{ _id: "item-1", menuID: "menu-A" }];
      if (fields === "_id image") return []; // nadie tiene asignada esta imagen tampoco
      throw new Error("unexpected select: " + fields);
    },
  });

  const req = {
    user: { _id: "user-1" },
    body: { changes: [{ imageUrl: "https://res.cloudinary.com/x/otro-user_1.jpg", itemIDs: ["item-1"] }] },
  };
  const res = makeResponse();
  await assignImages(req, res);

  assert.equal(res.statusCode, 403);
});

test("assignImages rechaza si alguno de los itemIDs no pertenece al usuario", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: ["url-pending"] }) });
  Item.find = () => ({
    select: async (fields) => {
      // item-1 es de menu-B, que no está entre los menús del usuario
      if (fields === "_id menuID") return [{ _id: "item-1", menuID: "menu-B" }];
      if (fields === "_id image") return [];
      throw new Error("unexpected select: " + fields);
    },
  });

  const req = {
    user: { _id: "user-1" },
    body: { changes: [{ imageUrl: "url-pending", itemIDs: ["item-1"] }] },
  };
  const res = makeResponse();
  await assignImages(req, res);

  assert.equal(res.statusCode, 403);
});

// ──────────────────────────────────────────────
// assignImages — diff toAdd/toRemove y pendingMenuImages
// ──────────────────────────────────────────────

test("assignImages agrega una pendiente, reasigna una ya asignada, y actualiza pendingMenuImages en un solo guardado", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: ["url-pending"] }) });
  Item.find = () => ({
    select: async (fields) => {
      if (fields === "_id menuID") {
        return [
          { _id: "item-1", menuID: "menu-A" },
          { _id: "item-3", menuID: "menu-A" },
        ];
      }
      if (fields === "_id image") {
        // url-assigned hoy la tiene item-2; url-pending no la tiene nadie.
        return [{ _id: "item-2", image: "url-assigned" }];
      }
      throw new Error("unexpected select: " + fields);
    },
  });

  let bulkOps;
  Item.bulkWrite = async (ops) => {
    bulkOps = ops;
    return {};
  };
  const userUpdateCalls = [];
  User.findByIdAndUpdate = async (id, update) => {
    userUpdateCalls.push(update);
    return {};
  };

  const req = {
    user: { _id: "user-1" },
    body: {
      changes: [
        { imageUrl: "url-pending", itemIDs: ["item-1"] }, // nueva asignación
        { imageUrl: "url-assigned", itemIDs: ["item-3"] }, // se la saca a item-2 y se la da a item-3
      ],
    },
  };
  const res = makeResponse();
  await assignImages(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.updatedCount, 3); // item-1 add, item-2 remove, item-3 add

  const opByIds = (ids) => bulkOps.find((op) => {
    const filterIds = op.updateMany.filter._id.$in;
    return filterIds.length === ids.length && ids.every((id) => filterIds.includes(id));
  });

  assert.equal(opByIds(["item-1"]).updateMany.update.$set.image, "url-pending");
  assert.equal(opByIds(["item-2"]).updateMany.update.$set.image, "");
  assert.equal(opByIds(["item-3"]).updateMany.update.$set.image, "url-assigned");

  // Las dos imágenes terminan asignadas a algo, así que las dos se sacan de
  // pendientes — "url-assigned" nunca estuvo ahí, pero el $pull es un no-op
  // inofensivo si el valor no está presente.
  const pullCall = userUpdateCalls.find((u) => u.$pull);
  assert.deepEqual(new Set(pullCall.$pull.pendingMenuImages.$in), new Set(["url-pending", "url-assigned"]));
  assert.equal(userUpdateCalls.some((u) => u.$addToSet), false);
});

test("assignImages devuelve la imagen a pendientes si se la desasigna sin darle un nuevo producto", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [] }) });
  Item.find = () => ({
    select: async (fields) => {
      if (fields === "_id menuID") return [];
      if (fields === "_id image") return [{ _id: "item-1", image: "url-assigned" }];
      throw new Error("unexpected select: " + fields);
    },
  });

  let bulkOps;
  Item.bulkWrite = async (ops) => {
    bulkOps = ops;
    return {};
  };
  const userUpdateCalls = [];
  User.findByIdAndUpdate = async (id, update) => {
    userUpdateCalls.push(update);
    return {};
  };

  const req = {
    user: { _id: "user-1" },
    body: { changes: [{ imageUrl: "url-assigned", itemIDs: [] }] },
  };
  const res = makeResponse();
  await assignImages(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(bulkOps.length, 1);
  assert.deepEqual(bulkOps[0].updateMany.filter._id.$in, ["item-1"]);
  assert.equal(bulkOps[0].updateMany.update.$set.image, "");

  const addToSetCall = userUpdateCalls.find((u) => u.$addToSet);
  assert.deepEqual(addToSetCall.$addToSet.pendingMenuImages.$each, ["url-assigned"]);
  assert.equal(userUpdateCalls.some((u) => u.$pull), false);
});

// ──────────────────────────────────────────────
// deleteItem / deleteItemsBulk — la imagen saliente vuelve a pendientes
// ──────────────────────────────────────────────

test("deleteItem devuelve la imagen del item borrado a pendingMenuImages", async () => {
  Item.findById = async () => ({
    _id: "item-1",
    image: "url-1",
    menuID: { toString: () => "menu-A" },
  });
  Item.findByIdAndDelete = async () => ({});
  Menu.findById = async () => ({ userID: { toString: () => "user-1" } });
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  Item.find = () => ({ select: async () => [] }); // nadie más usa esa imagen

  let addToSetArgs;
  User.findByIdAndUpdate = async (id, update) => {
    addToSetArgs = { id, update };
    return {};
  };

  const req = { params: { itemID: "item-1" }, user: { _id: { toString: () => "user-1" } } };
  const res = makeResponse();
  await deleteItem(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(addToSetArgs.update, { $addToSet: { pendingMenuImages: { $each: ["url-1"] } } });
});

test("deleteItem NO devuelve la imagen a pendientes si otro item del usuario todavía la usa (imagen legacy compartida)", async () => {
  Item.findById = async () => ({
    _id: "item-1",
    image: "url-compartida",
    menuID: { toString: () => "menu-A" },
  });
  Item.findByIdAndDelete = async () => ({});
  Menu.findById = async () => ({ userID: { toString: () => "user-1" } });
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  // item-2 (distinto del borrado) todavía tiene esa misma URL.
  Item.find = () => ({ select: async () => [{ image: "url-compartida" }] });

  let updateCalled = false;
  User.findByIdAndUpdate = async () => {
    updateCalled = true;
    return {};
  };

  const req = { params: { itemID: "item-1" }, user: { _id: { toString: () => "user-1" } } };
  const res = makeResponse();
  await deleteItem(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, false);
});

test("deleteItemsBulk devuelve las imágenes de los items borrados a pendingMenuImages", async () => {
  // item-1 y item-2 son del usuario (menu-A), item-3 es de otro usuario (menu-B).
  Item.find = () => ({
    select: async (fields) => {
      if (fields === "_id menuID") {
        return [
          { _id: { toString: () => "item-1" }, menuID: { toString: () => "menu-A" } },
          { _id: { toString: () => "item-2" }, menuID: { toString: () => "menu-A" } },
          { _id: { toString: () => "item-3" }, menuID: { toString: () => "menu-B" } },
        ];
      }
      if (fields === "_id image") {
        return [
          { _id: "item-1", image: "url-1" },
          { _id: "item-2", image: "" }, // sin imagen, no debe intentar reciclarse
        ];
      }
      if (fields === "image") {
        return []; // nadie más usa url-1
      }
      throw new Error("unexpected select: " + fields);
    },
  });
  Menu.find = (filter) => {
    if (filter.userID) return { select: async () => [{ _id: "menu-A" }] };
    return { select: async () => [{ _id: "menu-A" }] };
  };
  Item.deleteMany = async () => ({ deletedCount: 2 });

  let addToSetArgs;
  User.findByIdAndUpdate = async (id, update) => {
    addToSetArgs = { id, update };
    return {};
  };

  const req = { user: { _id: { toString: () => "user-1" } }, body: { itemIds: ["item-1", "item-2", "item-3"] } };
  const res = makeResponse();
  await deleteItemsBulk(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedCount, 2);
  assert.deepEqual(addToSetArgs.update, { $addToSet: { pendingMenuImages: { $each: ["url-1"] } } });
});

// ──────────────────────────────────────────────
// checkImageQuota — tope de imágenes:
//   - Free/Basic (item_limit fijo): pendientes + asignadas no puede
//     superar ese número.
//   - Pro (item_limit null): el tope pasa a ser la cantidad de productos
//     que el usuario YA creó, no un número fijo.
// ──────────────────────────────────────────────

test("checkImageQuota (Pro) deja pasar si pendientes + asignadas es menor a la cantidad de productos creados", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: ["url-1"] }) });
  Item.countDocuments = async (filter) => (filter.image ? 2 : 5); // 1 pendiente + 2 asignadas = 3 < 5 productos

  const req = { user: { _id: "user-1" }, plan: { features: { item_limit: null } } };
  const res = makeResponse();
  let nextCalled = false;
  await checkImageQuota(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test("checkImageQuota (Pro) rechaza si pendientes + asignadas ya iguala la cantidad de productos creados", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: ["url-1", "url-2"] }) });
  Item.countDocuments = async (filter) => (filter.image ? 1 : 3); // 2 pendientes + 1 asignada = 3 >= 3 productos

  const req = { user: { _id: "user-1" }, plan: { features: { item_limit: null } } };
  const res = makeResponse();
  let nextCalled = false;
  await checkImageQuota(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /productos creados/);
});

test("checkImageQuota (Pro) rechaza la primera imagen si todavía no creó ningún producto", async () => {
  Menu.find = () => ({ select: async () => [] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [] }) });
  Item.countDocuments = async () => 0;

  const req = { user: { _id: "user-1" }, plan: { features: { item_limit: null } } };
  const res = makeResponse();
  let nextCalled = false;
  await checkImageQuota(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("checkImageQuota deja pasar si pendientes + asignadas todavía no llegó al tope", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: ["url-1", "url-2"] }) });
  Item.countDocuments = async () => 3; // 2 pendientes + 3 asignadas = 5 < 7

  const req = { user: { _id: "user-1" }, plan: { features: { item_limit: 7 } } };
  const res = makeResponse();
  let nextCalled = false;
  await checkImageQuota(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test("checkImageQuota rechaza con 403 al llegar al tope del plan, sin llamar a next", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: ["url-1", "url-2", "url-3"] }) });
  Item.countDocuments = async () => 4; // 3 pendientes + 4 asignadas = 7 >= 7

  const req = { user: { _id: "user-1" }, plan: { features: { item_limit: 7 } } };
  const res = makeResponse();
  let nextCalled = false;
  await checkImageQuota(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /7 imágenes/);
});
