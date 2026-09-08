const test = require("node:test");
const assert = require("node:assert/strict");
const Item = require("../src/models/Item");
const Menu = require("../src/models/Menu");
const {
  setAvailableBulk, setHiddenBulk, deleteItemsBulk, MAX_BULK_ITEMS
} = require("../src/controllers/itemController");

const originalItemFind = Item.find;
const originalItemUpdateMany = Item.updateMany;
const originalItemDeleteMany = Item.deleteMany;
const originalMenuFind = Menu.find;

test.afterEach(() => {
  Item.find = originalItemFind;
  Item.updateMany = originalItemUpdateMany;
  Item.deleteMany = originalItemDeleteMany;
  Menu.find = originalMenuFind;
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

// item-1 y item-2 son de menu-A (del usuario), item-3 es de menu-B (de otro
// usuario). item-missing no existe. Cubre los tres motivos por los que un id
// del lote puede terminar en failedIds: no encontrado, de otro usuario, o
// simplemente no seleccionado.
const mockMixedOwnershipItems = () => {
  const userID = { toString: () => "user-1" };

  Item.find = () => ({
    select: async () => [
      { _id: { toString: () => "item-1" }, menuID: { toString: () => "menu-A" } },
      { _id: { toString: () => "item-2" }, menuID: { toString: () => "menu-A" } },
      { _id: { toString: () => "item-3" }, menuID: { toString: () => "menu-B" } },
    ],
  });
  Menu.find = () => ({
    select: async () => [{ _id: { toString: () => "menu-A" } }],
  });

  return userID;
};

test("setAvailableBulk actualiza solo los items del usuario y reporta el resto en failedIds", async () => {
  const userID = mockMixedOwnershipItems();
  let receivedFilter, receivedUpdate;
  Item.updateMany = async (filter, update) => {
    receivedFilter = filter;
    receivedUpdate = update;
    return { modifiedCount: 2 };
  };

  const req = {
    user: { _id: userID },
    body: { available: false, itemIds: ["item-1", "item-2", "item-3", "item-missing"] },
  };
  const res = makeResponse();

  await setAvailableBulk(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(receivedUpdate, { $set: { available: false } });
  assert.deepEqual(new Set(receivedFilter._id.$in), new Set(["item-1", "item-2"]));
  assert.equal(res.body.updatedCount, 2);
  assert.deepEqual(new Set(res.body.failedIds), new Set(["item-3", "item-missing"]));
});

test("setAvailableBulk rechaza available que no sea booleano sin tocar la base", async () => {
  let updateCalled = false;
  Item.updateMany = async () => { updateCalled = true; };

  const req = { user: { _id: "user-1" }, body: { available: "false", itemIds: ["item-1"] } };
  const res = makeResponse();

  await setAvailableBulk(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(updateCalled, false);
});

test("setHiddenBulk rechaza un itemIds vacío", async () => {
  const req = { user: { _id: "user-1" }, body: { hidden: true, itemIds: [] } };
  const res = makeResponse();

  await setHiddenBulk(req, res);

  assert.equal(res.statusCode, 400);
});

test("setHiddenBulk rechaza un lote más grande que MAX_BULK_ITEMS", async () => {
  const req = {
    user: { _id: "user-1" },
    body: { hidden: true, itemIds: Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, i) => `item-${i}`) },
  };
  const res = makeResponse();

  await setHiddenBulk(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, new RegExp(String(MAX_BULK_ITEMS)));
});

test("deleteItemsBulk solo elimina los ids que pertenecen al usuario", async () => {
  const userID = mockMixedOwnershipItems();
  let receivedFilter;
  Item.deleteMany = async (filter) => {
    receivedFilter = filter;
    return { deletedCount: 2 };
  };

  const req = { user: { _id: userID }, body: { itemIds: ["item-1", "item-2", "item-3"] } };
  const res = makeResponse();

  await deleteItemsBulk(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(new Set(receivedFilter._id.$in), new Set(["item-1", "item-2"]));
  assert.equal(res.body.deletedCount, 2);
  assert.deepEqual(res.body.failedIds, ["item-3"]);
});

test("deleteItemsBulk no llama a deleteMany si ningún id pertenece al usuario", async () => {
  Item.find = () => ({
    select: async () => [{ _id: { toString: () => "item-3" }, menuID: { toString: () => "menu-B" } }],
  });
  Menu.find = () => ({ select: async () => [] });
  let deleteCalled = false;
  Item.deleteMany = async () => { deleteCalled = true; };

  const req = { user: { _id: { toString: () => "user-1" } }, body: { itemIds: ["item-3"] } };
  const res = makeResponse();

  await deleteItemsBulk(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(deleteCalled, false);
  assert.equal(res.body.deletedCount, 0);
  assert.deepEqual(res.body.failedIds, ["item-3"]);
});
