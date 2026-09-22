const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Item = require("../src/models/Item");
const User = require("../src/models/User");
const { mockQuery, parseProjection, applyProjection } = require("../test-support/queryMock");

// ──────────────────────────────────────────────
// test-support/queryMock.js es lo que hace confiables los tests del handler v2
// (aplica la proyección, el filtro y el orden de verdad), así que su propio
// comportamiento también se fija.
// ──────────────────────────────────────────────

const id = () => new mongoose.Types.ObjectId();

const rows = () => [
  { _id: id(), menuID: "a", title: "B", price: 20, hidden: false, nested: { x: 1, y: 2 } },
  { _id: id(), menuID: "b", title: "A", price: 10, hidden: true, nested: { x: 3, y: 4 } },
  { _id: id(), menuID: "a", title: "C", price: 30, hidden: false, nested: { x: 5, y: 6 } },
];

test("registra filtro, select, sort, lean y batchSize de lo que pidió el handler", async (t) => {
  const calls = mockQuery(t, Item, "find", rows());

  await Item.find({ menuID: "a" }).select("title price").sort({ title: 1 }).lean().batchSize(500).limit(5);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filter, { menuID: "a" });
  assert.equal(calls[0].select, "title price");
  assert.deepEqual(calls[0].sort, { title: 1 });
  assert.equal(calls[0].lean, true);
  assert.equal(calls[0].batchSize, 500);
  assert.equal(calls[0].limit, 5);
  assert.deepEqual(calls[0].projection.include, ["title", "price"]);
});

test("aplica el filtro: igualdad, $in, $ne y null (que también cubre lo ausente)", async (t) => {
  const data = [
    { _id: id(), tag: "x", n: 1 },
    { _id: id(), tag: "y", n: 2 },
    { _id: id(), n: 3 },
  ];
  mockQuery(t, Item, "find", data);

  assert.equal((await Item.find({ tag: "x" })).length, 1);
  assert.equal((await Item.find({ tag: { $in: ["x", "y"] } })).length, 2);
  assert.equal((await Item.find({ tag: { $ne: "x" } })).length, 2);
  assert.equal((await Item.find({ tag: null })).length, 1);
  assert.equal((await Item.find({ _id: { $in: [data[0]._id, String(data[1]._id)] } })).length, 2, "ObjectId y su hex son lo mismo");
  assert.equal((await Item.find({})).length, 3);
  await assert.rejects(async () => Item.find({ n: { $gt: 1 } }), /operador no soportado/);
});

test("aplica el orden y el límite", async (t) => {
  mockQuery(t, Item, "find", rows());

  assert.deepEqual((await Item.find({}).sort({ title: 1 })).map((row) => row.title), ["A", "B", "C"]);
  assert.deepEqual((await Item.find({}).sort({ price: -1 })).map((row) => row.price), [30, 20, 10]);
  assert.deepEqual((await Item.find({}).sort({ title: 1 }).limit(2)).map((row) => row.title), ["A", "B"]);
});

test("la proyección de inclusión conserva _id y quita el resto, con rutas con punto", async (t) => {
  const data = rows();
  mockQuery(t, Item, "find", data);

  const [first] = await Item.find({ menuID: "a" }).select("title nested.x").lean();

  assert.deepEqual(first, { _id: data[0]._id, title: "B", nested: { x: 1 } });
  assert.equal("price" in first, false, "un campo olvidado en el select desaparece del resultado");
  assert.equal("hidden" in first, false);
});

test("la proyección de exclusión quita solo lo indicado y no muta el original", async (t) => {
  const data = rows();
  mockQuery(t, Item, "find", data);

  const [first] = await Item.find({ menuID: "a" }).select("-price -nested.y -_id").lean();

  assert.deepEqual(first, { menuID: "a", title: "B", hidden: false, nested: { x: 1 } });
  assert.equal(data[0].price, 20);
  assert.equal(data[0].nested.y, 2);
});

test("no permite mezclar inclusión y exclusión (Mongo tampoco)", () => {
  assert.throws(() => parseProjection(["title -price"]), /no se puede mezclar/);
  assert.deepEqual(parseProjection(["title", { price: 1 }]).include, ["title", "price"]);
  assert.deepEqual(applyProjection({ a: 1, b: 2 }, parseProjection(["a"])), { a: 1 });
});

test("lean devuelve objetos planos con los Map aplanados; sin lean, documentos hidratados", async (t) => {
  const doc = new Item({ menuID: id(), title: "Con variantes", price: 10, options: { Chica: 1, Grande: 2 } });
  mockQuery(t, Item, "find", [doc]);

  const [lean] = await Item.find({}).lean();
  assert.equal(typeof lean.toObject, "undefined");
  assert.deepEqual(lean.options, { Chica: 1, Grande: 2 });
  assert.equal(lean.options instanceof Map, false);

  const [hydrated] = await Item.find({});
  assert.equal(typeof hydrated.toObject, "function");
  assert.ok(hydrated.options instanceof Map);
});

test("sin lean y con select, el documento hidratado conserva su _id y solo los campos pedidos (con sus defaults)", async (t) => {
  const user = new User({
    slug: "cafe",
    template: 4,
    password: "secreto-123",
    contactInfo: { businessName: "Café", mail: "a@b.co", number: 5 },
  });
  mockQuery(t, User, "findOne", user);

  const found = await User.findOne({ slug: "cafe" }).select("contactInfo.businessName template hasDelivery");

  assert.equal(String(found._id), String(user._id), "hydrate no debe perder el _id");
  assert.equal(found.template, 4);
  assert.equal(found.hasDelivery, false, "el default aplica a un campo seleccionado");
  assert.equal(found.contactInfo.businessName, "Café");
  assert.equal(found.password, undefined);
  assert.equal(found.contactInfo.mail, undefined);
  assert.equal(found.slug, undefined);
});

test("findOne y findById devuelven un documento o null, y son thenables (sirven en Promise.all)", async (t) => {
  const data = rows();
  mockQuery(t, Item, "findOne", data);
  const byId = mockQuery(t, Item, "findById", data);

  const [found, missing, third] = await Promise.all([
    Item.findOne({ menuID: "b" }).lean(),
    Item.findOne({ menuID: "zzz" }).lean(),
    Item.findById(data[2]._id).lean(),
  ]);

  assert.equal(found.title, "A");
  assert.equal(missing, null);
  assert.equal(third.title, "C");
  assert.deepEqual(byId[0].filter, { _id: data[2]._id });
});

test("rows como función recibe el filtro y puede tirar para simular una caída de Mongo", async (t) => {
  mockQuery(t, Item, "find", (filter) => {
    if (filter.boom) throw new Error("mongo caído");
    return [{ _id: id(), title: String(filter.q) }];
  });

  assert.equal((await Item.find({ q: 7 }).lean())[0].title, "7");
  await assert.rejects(async () => Item.find({ boom: true }).lean(), /mongo caído/);
  await assert.rejects(Item.find({ boom: true }).lean().exec(), /mongo caído/);
});

test("el mock se restaura solo al terminar el test", async (t) => {
  const original = Item.find;
  await t.test("dentro", (inner) => {
    mockQuery(inner, Item, "find", []);
    assert.notEqual(Item.find, original);
  });
  assert.equal(Item.find, original);
});
