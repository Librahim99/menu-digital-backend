// Duplicar una categoría con sus productos (menú contextual del editor):
// POST /api/menus/:menuID/duplicate → menuController.duplicateMenu.

const test = require("node:test");
const assert = require("node:assert/strict");
const Item = require("../src/models/Item");
const Menu = require("../src/models/Menu");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { duplicateMenu } = require("../src/controllers/menuController");

const originals = {
  menuFindById: Menu.findById,
  menuFind: Menu.find,
  menuUpdateMany: Menu.updateMany,
  menuSave: Menu.prototype.save,
  itemFind: Item.find,
  itemCountDocuments: Item.countDocuments,
  itemCreate: Item.create,
};

test.afterEach(() => {
  Menu.findById = originals.menuFindById;
  Menu.find = originals.menuFind;
  Menu.updateMany = originals.menuUpdateMany;
  Menu.prototype.save = originals.menuSave;
  Item.find = originals.itemFind;
  Item.countDocuments = originals.itemCountDocuments;
  Item.create = originals.itemCreate;
});

const USER = "64f0000000000000000000aa";
const SECTION = "64f0000000000000000000cc";
const plan = (name) => INITIAL_PLANS.find((entry) => entry.name === name);

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const item = (id, title, code, order) => ({
  _id: id, title, code, order,
  toObject: () => ({ _id: id, __v: 0, title, code, order, price: 1000, menuID: "orig", createdAt: 1, updatedAt: 2 }),
});

function setup({ category = {}, items = [], itemCount = 0, menuCodes = [], itemCodes = [] } = {}) {
  const state = { saved: [], created: [], shifted: null };
  const original = {
    _id: "orig", userID: { toString: () => USER }, title: "Pizzas", description: "Al horno", image: "",
    hidden: false, section: false, sectionID: SECTION, code: "PIZ", order: 2, ...category,
  };
  Menu.findById = async () => original;
  Menu.find = () => ({ select: async () => [{ _id: "orig", code: "PIZ" }, ...menuCodes.map((code, i) => ({ _id: `m${i}`, code }))] });
  Menu.updateMany = async (filter, update) => { state.shifted = { filter, update }; };
  Menu.prototype.save = async function save() { state.saved.push(this.toObject()); return this; };
  Item.find = (filter) => {
    if (filter.menuID === "orig") return { sort: async () => items };
    return { select: async () => itemCodes.map((code) => ({ code })) };
  };
  Item.countDocuments = async () => itemCount;
  Item.create = async (data) => { state.created.push(data); return { ...data, _id: `copy-${state.created.length}`, save: async () => {} }; };
  return state;
}

const run = async (user = { _id: USER, panelSettings: {} }, planName = "pro") => {
  const res = response();
  await duplicateMenu({ params: { menuID: "orig" }, user, plan: plan(planName) }, res);
  return res;
};

test("copia la categoría debajo de la original, en su sección, con sus productos en orden", async () => {
  const state = setup({
    items: [item("i1", "Muzza", "MUZ", 0), item("i2", "Fugazza", "", 1)],
    itemCodes: ["MUZ", "MUZ-COPIA"],
  });
  const res = await run();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.itemCount, 2);
  const [copy] = state.saved;
  assert.equal(copy.title, "Copia de Pizzas");
  assert.equal(copy.code, "PIZ-COPIA");
  assert.equal(copy.order, 3);
  assert.equal(String(copy.sectionID), SECTION);
  assert.equal(copy.description, "Al horno");
  assert.deepEqual(state.shifted.update, { $inc: { order: 1 } }, "se corren las que siguen");
  assert.deepEqual(state.shifted.filter.order, { $gt: 2 });

  assert.deepEqual(state.created.map((data) => [data.title, data.code, data.order]), [["Muzza", "MUZ-COPIA2", 0], ["Fugazza", "", 1]]);
  for (const data of state.created) {
    assert.equal(String(data.menuID), String(copy._id));
    assert.equal(data._id, undefined);
  }
});

test("respeta el límite de productos del plan: todo o nada", async () => {
  const limit = plan("free").features.item_limit;
  assert.ok(limit !== null, "el plan free tiene tope");
  const state = setup({ items: [item("i1", "Muzza", "", 0), item("i2", "Fugazza", "", 1)], itemCount: limit - 1 });
  const res = await run(undefined, "free");

  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /suma 2 productos/);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.created, []);
});

test("no duplica secciones ni categorías de otro local", async () => {
  setup({ category: { section: true } });
  assert.equal((await run()).statusCode, 400);

  setup({ category: { userID: { toString: () => "otro" } } });
  assert.equal((await run()).statusCode, 403);
});

test("con códigos automáticos, la copia sin código recibe uno", async () => {
  const state = setup({ category: { code: "" }, items: [item("i1", "Muzza", "", 0)] });
  const res = await run({ _id: USER, panelSettings: { autoGenerateCodes: true } });

  assert.equal(res.statusCode, 201);
  const final = state.saved.at(-1);
  assert.match(final.code, /^[A-Z0-9]{4}$/);
});
