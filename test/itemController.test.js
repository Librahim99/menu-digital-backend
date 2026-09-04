const test = require("node:test");
const assert = require("node:assert/strict");
const Item = require("../src/models/Item");
const Menu = require("../src/models/Menu");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { editItem } = require("../src/controllers/itemController");

const originalItemFindById = Item.findById;
const originalItemFindByIdAndUpdate = Item.findByIdAndUpdate;
const originalMenuFindById = Menu.findById;

test.afterEach(() => {
  Item.findById = originalItemFindById;
  Item.findByIdAndUpdate = originalItemFindByIdAndUpdate;
  Menu.findById = originalMenuFindById;
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

const mockOwnedItem = () => {
  const userID = { toString: () => "user-1" };
  const menuID = { toString: () => "menu-1" };

  Item.findById = async () => ({
    _id: { toString: () => "item-1" },
    menuID,
    price: 1000,
    offerPrice: null,
    offerRange: { from: null, to: null },
  });
  Menu.findById = async () => ({ userID });

  return userID;
};

test("editItem persiste disponibilidad, visibilidad y recomendado", async () => {
  const userID = mockOwnedItem();
  let receivedUpdate;

  Item.findByIdAndUpdate = async (_id, update) => {
    receivedUpdate = update;
    return { _id: "item-1", ...update.$set };
  };

  const req = {
    params: { itemID: "item-1" },
    plan: INITIAL_PLANS.find(plan => plan.name === "free"),
    user: { _id: userID, subscription: "free" },
    body: { available: false, hidden: true, recommended: true },
  };
  const res = makeResponse();

  await editItem(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(receivedUpdate.$set, {
    recommended: true,
    hidden: true,
    available: false,
  });
});

test("editItem rechaza estados que no sean booleanos", async () => {
  const userID = mockOwnedItem();
  let updateCalled = false;
  Item.findByIdAndUpdate = async () => {
    updateCalled = true;
  };

  const req = {
    params: { itemID: "item-1" },
    plan: INITIAL_PLANS.find(plan => plan.name === "free"),
    user: { _id: userID, subscription: "free" },
    body: { hidden: "true" },
  };
  const res = makeResponse();

  await editItem(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "hidden debe ser un booleano" });
  assert.equal(updateCalled, false);
});

test("editItem rechaza una variante (options) con precio negativo", async () => {
  const userID = mockOwnedItem();
  let updateCalled = false;
  Item.findByIdAndUpdate = async () => {
    updateCalled = true;
  };

  const req = {
    params: { itemID: "item-1" },
    plan: INITIAL_PLANS.find(plan => plan.name === "free"),
    user: { _id: userID, subscription: "free" },
    body: { options: { "Tamaño chico": 800, "Tamaño grande": -100 } },
  };
  const res = makeResponse();

  await editItem(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /negativo/);
  assert.equal(updateCalled, false, "no debe guardar con una variante en negativo");
});

test("el modelo Item rechaza una variante (options) con precio negativo", () => {
  const item = new Item({
    menuID: new (require("mongoose").Types.ObjectId)(),
    title: "Pizza",
    options: { "Individual": 6200, "Grande": -50 },
  });
  const err = item.validateSync();
  assert.ok(err?.errors?.options, "debe rechazar la variante en negativo");
});
