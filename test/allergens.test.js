const test = require("node:test");
const assert = require("node:assert/strict");
const Item = require("../src/models/Item");
const Menu = require("../src/models/Menu");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { editItem, getAllergens } = require("../src/controllers/itemController");
const { validateAllergenFields, getAllergenCatalog, ALLERGEN_CODES } = require("../src/utils/allergens");
const { toPublicItem } = require("../src/utils/publicMenu");

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
  headers: {},
  set(name, value) { this.headers[name] = value; return this; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

// ── validateAllergenFields ──────────────────────

test("ordena según el catálogo y saca repetidos", () => {
  const { updates, error } = validateAllergenFields({ allergens: ["soja", "gluten", "soja"] });
  assert.equal(error, undefined);
  assert.deepEqual(updates, { allergens: ["gluten", "soja"] });
});

test("rechaza códigos desconocidos y valores que no son lista", () => {
  assert.match(validateAllergenFields({ allergens: ["TACC"] }).error, /código desconocido "TACC"/);
  assert.match(validateAllergenFields({ dietary: "vegano" }).error, /debe ser una lista/);
  assert.match(validateAllergenFields({ mayContain: [1] }).error, /debe ser una lista/);
});

test("null vacía el campo y undefined no lo toca", () => {
  assert.deepEqual(validateAllergenFields({ allergens: null }).updates, { allergens: [] });
  assert.deepEqual(validateAllergenFields({}).updates, {});
});

test("lo que el producto contiene se saca de 'puede contener'", () => {
  const { updates } = validateAllergenFields({ allergens: ["huevo"], mayContain: ["huevo", "mani"] });
  assert.deepEqual(updates.mayContain, ["mani"]);
});

test("agregar un alérgeno que estaba como traza lo saca de las trazas guardadas", () => {
  const { updates } = validateAllergenFields({ allergens: ["mani"] }, { mayContain: ["mani", "soja"] });
  assert.deepEqual(updates, { allergens: ["mani"], mayContain: ["soja"] });
});

test("Sin TACC no convive con gluten, ni como traza", () => {
  assert.match(validateAllergenFields({ dietary: ["sin_tacc"], allergens: ["gluten"] }).error, /Sin TACC no puede contener gluten/);
  assert.match(validateAllergenFields({ dietary: ["sin_tacc"], mayContain: ["gluten"] }).error, /Sin TACC/);
});

test("vegano no convive con lácteos guardados", () => {
  const { error } = validateAllergenFields({ dietary: ["vegano"] }, { allergens: ["lacteos"] });
  assert.match(error, /Vegano no puede contener lácteos/);
});

test("combinación válida pasa", () => {
  const { error, updates } = validateAllergenFields({ dietary: ["vegano", "sin_tacc"], allergens: ["soja"], mayContain: ["mani"] });
  assert.equal(error, undefined);
  assert.deepEqual(updates, { allergens: ["soja"], mayContain: ["mani"], dietary: ["sin_tacc", "vegano"] });
});

// ── Catálogo ────────────────────────────────────

test("GET /api/items/allergens devuelve el catálogo con cache", () => {
  const res = makeResponse();
  getAllergens({}, res);
  assert.deepEqual(res.body, getAllergenCatalog());
  assert.equal(res.body.allergens.length, 14);
  assert.ok(res.body.dietary.find((d) => d.code === "sin_tacc").excludes.includes("gluten"));
  assert.match(res.headers["Cache-Control"], /max-age/);
});

// ── Modelo ──────────────────────────────────────

test("el modelo rechaza códigos fuera del catálogo y por defecto deja listas vacías", () => {
  const empty = new Item({ menuID: "64f000000000000000000001", title: "Agua" });
  assert.equal(empty.validateSync(), undefined);
  assert.deepEqual([...empty.allergens], []);

  const bad = new Item({ menuID: "64f000000000000000000001", title: "Pan", allergens: ["trigo"] });
  assert.ok(bad.validateSync()?.errors["allergens.0"]);

  const ok = new Item({ menuID: "64f000000000000000000001", title: "Pan", allergens: ALLERGEN_CODES });
  assert.equal(ok.validateSync(), undefined);
});

// ── editItem ────────────────────────────────────

const mockOwnedItem = (stored = {}) => {
  const userID = { toString: () => "user-1" };
  const menuID = { toString: () => "menu-1" };
  Item.findById = async () => ({
    _id: { toString: () => "item-1" },
    menuID,
    price: 1000,
    offerPrice: null,
    offerRange: { from: null, to: null },
    ...stored,
  });
  Menu.findById = () => ({ select: async () => ({ userID }) });
  return userID;
};

const editRequest = (userID, body) => ({
  params: { itemID: "item-1" },
  plan: INITIAL_PLANS.find((plan) => plan.name === "free"),
  user: { _id: userID, subscription: "free" },
  body,
});

test("editItem guarda alérgenos normalizados", async () => {
  const userID = mockOwnedItem();
  let received;
  Item.findByIdAndUpdate = async (_id, update) => { received = update.$set; return update.$set; };

  const res = makeResponse();
  await editItem(editRequest(userID, { allergens: ["lacteos", "gluten"], dietary: ["vegetariano"] }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, { allergens: ["gluten", "lacteos"], dietary: ["vegetariano"] });
});

test("editItem rechaza Sin TACC en un producto que ya tiene gluten", async () => {
  const userID = mockOwnedItem({ allergens: ["gluten"] });
  let updateCalled = false;
  Item.findByIdAndUpdate = async () => { updateCalled = true; };

  const res = makeResponse();
  await editItem(editRequest(userID, { dietary: ["sin_tacc"] }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Sin TACC/);
  assert.equal(updateCalled, false);
});

// ── Carta pública v2 ────────────────────────────

test("la carta v2 manda los códigos y omite las listas vacías", () => {
  const withData = toPublicItem({
    _id: "a", title: "Pan", allergens: ["gluten"], mayContain: ["sesamo"], dietary: ["vegano"],
  });
  assert.deepEqual(withData.allergens, ["gluten"]);
  assert.deepEqual(withData.mayContain, ["sesamo"]);
  assert.deepEqual(withData.dietary, ["vegano"]);

  const empty = toPublicItem({ _id: "b", title: "Agua", allergens: [], dietary: [] });
  assert.equal("allergens" in empty, false);
  assert.equal("mayContain" in empty, false);
  assert.equal("dietary" in empty, false);
});
