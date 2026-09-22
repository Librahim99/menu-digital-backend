// Gestor de imágenes: /api/items/lite, /api/items/images/pending y sobre
// todo /api/items/images/assign (el diff toAdd/toRemove + el hueco de
// seguridad de no poder "robar" una imagen pendiente de otro usuario). No
// se testea uploadLibraryImage acá — mismo criterio que uploadDraftImage/
// uploadImage, no testeados a nivel de subida a Cloudinary en este repo.
const ORIGINAL_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";

const test = require("node:test");
const assert = require("node:assert/strict");
const Item = require("../src/models/Item");
const Menu = require("../src/models/Menu");
const User = require("../src/models/User");
const { cloudinary } = require("../src/config/cloudinary");
const {
  getLiteItems, getPendingImages, getPresetImages, assignImages, checkImageQuota, deleteItem, deleteItemsBulk,
  deleteLibraryImage, MAX_BULK_ITEMS,
} = require("../src/controllers/itemController");

const originalItemFind = Item.find;
const originalItemFindById = Item.findById;
const originalItemFindByIdAndDelete = Item.findByIdAndDelete;
const originalItemDeleteMany = Item.deleteMany;
const originalItemBulkWrite = Item.bulkWrite;
const originalItemCountDocuments = Item.countDocuments;
const originalItemUpdateMany = Item.updateMany;
const originalMenuFind = Menu.find;
const originalMenuFindById = Menu.findById;
const originalUserFindById = User.findById;
const originalUserFindByIdAndUpdate = User.findByIdAndUpdate;
const originalUserFindOne = User.findOne;
const originalCloudinaryDestroy = cloudinary.uploader.destroy;

test.after(() => {
  process.env.CLOUDINARY_CLOUD_NAME = ORIGINAL_CLOUD_NAME;
});

// Sin esto, todo test que llegue a getPresetImagesOwner() (assignImages,
// deleteLibraryImage, checkImageQuota) ejecutaría el User.findOne real de
// Mongoose sin conexión. Default "sin banco de prediseñadas configurado" —
// deja el comportamiento de siempre intacto; los tests de presets de más
// abajo pisan este mock con el suyo.
test.beforeEach(() => {
  User.findOne = () => ({ select: async () => null });
});

test.afterEach(() => {
  Item.find = originalItemFind;
  Item.findById = originalItemFindById;
  Item.findByIdAndDelete = originalItemFindByIdAndDelete;
  Item.deleteMany = originalItemDeleteMany;
  Item.bulkWrite = originalItemBulkWrite;
  Item.countDocuments = originalItemCountDocuments;
  Item.updateMany = originalItemUpdateMany;
  Menu.find = originalMenuFind;
  Menu.findById = originalMenuFindById;
  User.findById = originalUserFindById;
  User.findByIdAndUpdate = originalUserFindByIdAndUpdate;
  User.findOne = originalUserFindOne;
  cloudinary.uploader.destroy = originalCloudinaryDestroy;
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

test("getPendingImages no devuelve prediseñadas ajenas y las saca de las pendientes del usuario", async () => {
  User.findOne = () => ({ select: async () => ({ _id: "preset-owner", pendingMenuImages: ["url-preset"] }) });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: ["url-1", "url-preset"] }) });
  let pullArgs;
  User.findByIdAndUpdate = async (id, update) => {
    pullArgs = { id, update };
    return {};
  };
  const req = { user: { _id: "user-1" } };
  const res = makeResponse();
  await getPendingImages(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { pendingImages: ["url-1"] });
  assert.deepEqual(pullArgs, { id: "user-1", update: { $pull: { pendingMenuImages: { $in: ["url-preset"] } } } });
});

test("getPresetImages devuelve las pendingMenuImages del usuario marcado presetImagesUser", async () => {
  User.findOne = (filter) => {
    assert.deepEqual(filter, { presetImagesUser: true });
    return { select: async () => ({ _id: "preset-owner", pendingMenuImages: ["preset-1", "preset-2"] }) };
  };
  const res = makeResponse();
  await getPresetImages({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { presetImages: ["preset-1", "preset-2"] });
});

test("getPresetImages devuelve array vacío si ningún usuario está marcado como banco de prediseñadas", async () => {
  User.findOne = () => ({ select: async () => null });
  const res = makeResponse();
  await getPresetImages({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { presetImages: [] });
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
// assignImages — imágenes prediseñadas (banco compartido, ver
// User.presetImagesUser): asignarlas/desasignarlas nunca toca
// pendingMenuImages de nadie, a diferencia de una pendiente propia.
// ──────────────────────────────────────────────

test("assignImages permite asignar una imagen prediseñada ajena y no la toca en pendingMenuImages de nadie", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [] }) }); // quien asigna no la tiene pendiente
  User.findOne = () => ({ select: async () => ({ _id: "preset-owner", pendingMenuImages: ["preset-url"] }) });
  Item.find = () => ({
    select: async (fields) => {
      if (fields === "_id menuID") return [{ _id: "item-1", menuID: "menu-A" }];
      if (fields === "_id image") return []; // todavía nadie la tiene asignada
      throw new Error("unexpected select: " + fields);
    },
  });

  let bulkOps;
  Item.bulkWrite = async (ops) => { bulkOps = ops; return {}; };
  const userUpdateCalls = [];
  User.findByIdAndUpdate = async (id, update) => { userUpdateCalls.push(update); return {}; };

  const req = {
    user: { _id: "user-1" },
    body: { changes: [{ imageUrl: "preset-url", itemIDs: ["item-1"] }] },
  };
  const res = makeResponse();
  await assignImages(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(bulkOps, [
    { updateMany: { filter: { _id: { $in: ["item-1"] } }, update: { $set: { image: "preset-url" } } } },
  ]);
  // Ni $pull ni $addToSet: la prediseñada no se mueve del array de su dueño.
  assert.equal(userUpdateCalls.length, 0);
});

test("assignImages al desasignar una imagen prediseñada no la agrega a las pendientes propias de quien la usaba", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [] }) });
  User.findOne = () => ({ select: async () => ({ _id: "preset-owner", pendingMenuImages: ["preset-url"] }) });
  Item.find = () => ({
    select: async (fields) => {
      if (fields === "_id menuID") return [];
      if (fields === "_id image") return [{ _id: "item-1", image: "preset-url" }]; // item-1 la tenía asignada
      throw new Error("unexpected select: " + fields);
    },
  });

  let bulkOps;
  Item.bulkWrite = async (ops) => { bulkOps = ops; return {}; };
  const userUpdateCalls = [];
  User.findByIdAndUpdate = async (id, update) => { userUpdateCalls.push(update); return {}; };

  const req = {
    user: { _id: "user-1" },
    body: { changes: [{ imageUrl: "preset-url", itemIDs: [] }] },
  };
  const res = makeResponse();
  await assignImages(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(bulkOps[0].updateMany.update.$set.image, "");
  assert.equal(userUpdateCalls.length, 0); // no vuelve a pendingMenuImages de user-1
});

test("assignImages trata la imagen como pendiente propia (no preset) cuando quien asigna es el dueño del banco", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: ["own-url"] }) });
  User.findOne = () => ({ select: async () => ({ _id: "user-1", pendingMenuImages: ["own-url"] }) }); // mismo user
  Item.find = () => ({
    select: async (fields) => {
      if (fields === "_id menuID") return [{ _id: "item-1", menuID: "menu-A" }];
      if (fields === "_id image") return [];
      throw new Error("unexpected select: " + fields);
    },
  });

  Item.bulkWrite = async () => ({});
  const userUpdateCalls = [];
  User.findByIdAndUpdate = async (id, update) => { userUpdateCalls.push(update); return {}; };

  const req = {
    user: { _id: "user-1" },
    body: { changes: [{ imageUrl: "own-url", itemIDs: ["item-1"] }] },
  };
  const res = makeResponse();
  await assignImages(req, res);

  assert.equal(res.statusCode, 200);
  const pullCall = userUpdateCalls.find((u) => u.$pull);
  assert.deepEqual(pullCall.$pull.pendingMenuImages.$in, ["own-url"]);
});

// ──────────────────────────────────────────────
// deleteItem / deleteItemsBulk — la imagen saliente vuelve a pendientes
// ──────────────────────────────────────────────

test("deleteItem devuelve la imagen del item borrado a pendingMenuImages", async () => {
  Item.findById = () => ({
    select: async () => ({
      _id: "item-1",
      image: "url-1",
      menuID: { toString: () => "menu-A" },
    }),
  });
  Item.findByIdAndDelete = async () => ({});
  Menu.findById = () => ({ select: async () => ({ userID: { toString: () => "user-1" } }) });
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
  Item.findById = () => ({
    select: async () => ({
      _id: "item-1",
      image: "url-compartida",
      menuID: { toString: () => "menu-A" },
    }),
  });
  Item.findByIdAndDelete = async () => ({});
  Menu.findById = () => ({ select: async () => ({ userID: { toString: () => "user-1" } }) });
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

test("deleteItem NO manda a pendientes una imagen prediseñada ajena (no es del usuario)", async () => {
  User.findOne = () => ({ select: async () => ({ _id: "preset-owner", pendingMenuImages: ["url-preset"] }) });
  Item.findById = () => ({
    select: async () => ({ _id: "item-1", image: "url-preset", menuID: { toString: () => "menu-A" } }),
  });
  Item.findByIdAndDelete = async () => ({});
  Menu.findById = () => ({ select: async () => ({ userID: { toString: () => "user-1" } }) });
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  Item.find = () => ({ select: async () => [] }); // nadie más la usa

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

test("deleteItem del dueño del banco sí devuelve su prediseñada a sus pendientes (es propia)", async () => {
  User.findOne = () => ({ select: async () => ({ _id: "user-1", pendingMenuImages: [] }) });
  Item.findById = () => ({
    select: async () => ({ _id: "item-1", image: "url-preset", menuID: { toString: () => "menu-A" } }),
  });
  Item.findByIdAndDelete = async () => ({});
  Menu.findById = () => ({ select: async () => ({ userID: { toString: () => "user-1" } }) });
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  Item.find = () => ({ select: async () => [] });

  let addToSetArgs;
  User.findByIdAndUpdate = async (id, update) => {
    addToSetArgs = { id, update };
    return {};
  };

  const req = { params: { itemID: "item-1" }, user: { _id: { toString: () => "user-1" } } };
  const res = makeResponse();
  await deleteItem(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(addToSetArgs.update, { $addToSet: { pendingMenuImages: { $each: ["url-preset"] } } });
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

test("checkImageQuota (Pro) no cuenta las imágenes prediseñadas asignadas contra el cupo propio", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [] }) });
  User.findOne = () => ({
    select: async () => ({ _id: "preset-owner", pendingMenuImages: ["preset-1", "preset-2"] }),
  });
  // 5 productos creados, todos con una imagen prediseñada asignada (ninguna propia).
  Item.countDocuments = async (filter) => {
    if (filter.image) {
      assert.deepEqual(filter.image.$nin, ["preset-1", "preset-2"]);
      return 0;
    }
    return 5;
  };

  const req = { user: { _id: "user-1" }, plan: { features: { item_limit: null } } };
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

// ──────────────────────────────────────────────
// deleteLibraryImage
// ──────────────────────────────────────────────

const VALID_LIBRARY_URL = "https://res.cloudinary.com/test-cloud/image/upload/v123/menu-digital/items/user1_999.jpg";

test("deleteLibraryImage rechaza sin una imageUrl válida", async () => {
  const req = { user: { _id: "user-1" }, body: { imageUrl: "https://evil.example.com/x.jpg" } };
  const res = makeResponse();
  await deleteLibraryImage(req, res);
  assert.equal(res.statusCode, 400);
});

test("deleteLibraryImage rechaza una imagen que no está pendiente ni asignada a un producto del usuario", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [] }) });
  Item.find = () => ({ select: async () => [] }); // nadie del usuario tiene esa imagen

  const req = { user: { _id: "user-1" }, body: { imageUrl: VALID_LIBRARY_URL } };
  const res = makeResponse();
  await deleteLibraryImage(req, res);

  assert.equal(res.statusCode, 403);
});

test("deleteLibraryImage borra una imagen pendiente: la saca de pendingMenuImages y destruye en Cloudinary", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [VALID_LIBRARY_URL] }) });
  Item.find = () => ({ select: async () => [] }); // ningún producto la tiene asignada

  let pullArgs;
  User.findByIdAndUpdate = async (id, update) => {
    pullArgs = { id, update };
    return {};
  };
  let updateManyCalled = false;
  Item.updateMany = async () => { updateManyCalled = true; return {}; };

  let destroyArgs;
  cloudinary.uploader.destroy = async (publicId, options) => {
    destroyArgs = { publicId, options };
    return { result: "ok" };
  };

  const req = { user: { _id: "user-1" }, body: { imageUrl: VALID_LIBRARY_URL } };
  const res = makeResponse();
  await deleteLibraryImage(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removedFromItems, 0);
  assert.deepEqual(pullArgs.update, { $pull: { pendingMenuImages: VALID_LIBRARY_URL } });
  assert.equal(updateManyCalled, false);
  assert.equal(destroyArgs.publicId, "menu-digital/items/user1_999");
});

test("deleteLibraryImage borra una imagen asignada: limpia Item.image en los productos que la tenían y no toca pendientes", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [] }) });
  Item.find = () => ({ select: async () => [{ _id: "item-1" }, { _id: "item-2" }] });

  let updateManyArgs;
  Item.updateMany = async (filter, update) => { updateManyArgs = { filter, update }; return {}; };
  let userUpdateCalled = false;
  User.findByIdAndUpdate = async () => { userUpdateCalled = true; return {}; };
  cloudinary.uploader.destroy = async () => ({ result: "ok" });

  const req = { user: { _id: "user-1" }, body: { imageUrl: VALID_LIBRARY_URL } };
  const res = makeResponse();
  await deleteLibraryImage(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removedFromItems, 2);
  assert.deepEqual(updateManyArgs.filter._id.$in, ["item-1", "item-2"]);
  assert.equal(updateManyArgs.update.$set.image, "");
  assert.equal(userUpdateCalled, false);
});

test("deleteLibraryImage rechaza borrar una imagen prediseñada ajena aunque esté asignada a un producto propio", async () => {
  User.findOne = () => ({
    select: async () => ({ _id: "preset-owner", pendingMenuImages: [VALID_LIBRARY_URL] }),
  });
  let destroyCalled = false;
  cloudinary.uploader.destroy = async () => { destroyCalled = true; return { result: "ok" }; };

  const req = { user: { _id: "user-1" }, body: { imageUrl: VALID_LIBRARY_URL } };
  const res = makeResponse();
  await deleteLibraryImage(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(destroyCalled, false);
});

test("deleteLibraryImage permite al dueño del banco de prediseñadas borrar su propia imagen (no es 'ajena')", async () => {
  User.findOne = () => ({ select: async () => ({ _id: "user-1", pendingMenuImages: [VALID_LIBRARY_URL] }) });
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [VALID_LIBRARY_URL] }) });
  Item.find = () => ({ select: async () => [] });
  User.findByIdAndUpdate = async () => ({});
  let destroyCalled = false;
  cloudinary.uploader.destroy = async () => { destroyCalled = true; return { result: "ok" }; };

  const req = { user: { _id: "user-1" }, body: { imageUrl: VALID_LIBRARY_URL } };
  const res = makeResponse();
  await deleteLibraryImage(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(destroyCalled, true);
});

test("deleteLibraryImage igual devuelve 200 si Cloudinary falla al destruir (la limpieza en Mongo ya vale)", async () => {
  Menu.find = () => ({ select: async () => [{ _id: "menu-A" }] });
  User.findById = () => ({ select: async () => ({ pendingMenuImages: [VALID_LIBRARY_URL] }) });
  Item.find = () => ({ select: async () => [] });
  User.findByIdAndUpdate = async () => ({});
  cloudinary.uploader.destroy = async () => { throw new Error("Cloudinary caído"); };

  const req = { user: { _id: "user-1" }, body: { imageUrl: VALID_LIBRARY_URL } };
  const res = makeResponse();
  await deleteLibraryImage(req, res);

  assert.equal(res.statusCode, 200);
});
