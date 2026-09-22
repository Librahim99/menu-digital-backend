const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Item = require("../src/models/Item");
const {
  MENU_ORDER_SORT,
  MAX_REORDER_IDS,
  sortByMenuOrder,
  flattenMenusInOrder,
  menuContainerKey,
  itemContainerKey,
  menuContainerFilter,
  getNextOrder,
  createOrderAllocator,
  parseReorderIds,
  buildReorder,
} = require("../src/utils/menuOrder");
const { mockQuery } = require("../test-support/queryMock");

// ──────────────────────────────────────────────
// utils/menuOrder.js: el criterio de orden de la carta y las piezas que usan
// las altas y los endpoints de reordenamiento.
// ──────────────────────────────────────────────

// ObjectId cuyo hex ordena igual que `n` (oid(1) < oid(2) < ...).
const oid = (n) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, "0"));
const numbers = (docs) => docs.map((doc) => Number.parseInt(String(doc._id), 16));

test("sin order primero y por creación; después por order; a igualdad, por _id", () => {
  const docs = [
    { _id: oid(5), order: 1 },
    { _id: oid(4) },
    { _id: oid(3), order: 0 },
    { _id: oid(2), order: 1 },
    { _id: oid(1) },
  ];
  assert.deepEqual(numbers(sortByMenuOrder(docs)), [1, 4, 3, 2, 5]);
  assert.deepEqual(numbers(docs), [5, 4, 3, 2, 1], "no toca el array original");
});

test("el orden en memoria es el mismo que pide MENU_ORDER_SORT a Mongo", async (t) => {
  const menuID = oid(100);
  const items = [
    new Item({ _id: oid(6), menuID, title: "F", order: 0 }),
    new Item({ _id: oid(5), menuID, title: "E" }),
    new Item({ _id: oid(4), menuID, title: "D", order: 2 }),
    new Item({ _id: oid(3), menuID, title: "C", order: 0 }),
    new Item({ _id: oid(2), menuID, title: "B" }),
    new Item({ _id: oid(1), menuID, title: "A", order: 1 }),
  ];
  mockQuery(t, Item, "find", items);

  const fromMongo = await Item.find({ menuID }).sort(MENU_ORDER_SORT).lean();

  assert.deepEqual(numbers(fromMongo), numbers(sortByMenuOrder(items)));
  assert.deepEqual(numbers(fromMongo), [2, 5, 3, 6, 1, 4]);
});

test("flattenMenusInOrder: cada sección con sus categorías, después las sueltas y al final las huérfanas", () => {
  const primera = { _id: oid(1), section: true, order: 1 };
  const segunda = { _id: oid(2), section: true, order: 0 };
  const deLaPrimeraB = { _id: oid(3), sectionID: primera._id, order: 1 };
  const deLaPrimeraA = { _id: oid(4), sectionID: primera._id, order: 0 };
  const deLaSegunda = { _id: oid(5), sectionID: segunda._id };
  const suelta = { _id: oid(6), sectionID: null };
  const huerfana = { _id: oid(7), sectionID: oid(99) };

  assert.deepEqual(
    flattenMenusInOrder([huerfana, suelta, deLaSegunda, deLaPrimeraA, deLaPrimeraB, segunda, primera]),
    [segunda, deLaSegunda, primera, deLaPrimeraA, deLaPrimeraB, suelta, huerfana],
  );
});

test("contenedores: las secciones comparten uno; cada categoría usa el de su sección", () => {
  assert.equal(menuContainerKey({ section: true, sectionID: oid(1) }), "sections");
  assert.equal(menuContainerKey({ section: false, sectionID: oid(1) }), `categories:${oid(1)}`);
  assert.equal(menuContainerKey({ sectionID: null }), "categories:loose");
  assert.equal(itemContainerKey({ menuID: oid(8) }), String(oid(8)));

  assert.deepEqual(menuContainerFilter("u1", { section: true, sectionID: oid(1) }), { userID: "u1", section: true });
  assert.deepEqual(
    menuContainerFilter("u1", { section: false }),
    { userID: "u1", section: { $ne: true }, sectionID: null },
  );
});

test("getNextOrder: el order más alto del contenedor + 1", async (t) => {
  const menuID = oid(10);
  const calls = mockQuery(t, Item, "findOne", [
    new Item({ menuID, title: "Con order", order: 3 }),
    new Item({ menuID, title: "El último", order: 7 }),
    new Item({ menuID, title: "Anterior al campo" }),
    new Item({ menuID: oid(11), title: "De otra categoría", order: 50 }),
  ]);

  assert.equal(await getNextOrder(Item, { menuID }), 8);
  assert.deepEqual(calls[0].sort, { order: -1 });
  assert.equal(calls[0].lean, true);
});

test("getNextOrder: 0 si nadie en el contenedor tiene order (lo nuevo queda después de lo viejo)", async (t) => {
  const menuID = oid(10);
  mockQuery(t, Item, "findOne", [new Item({ menuID, title: "Anterior al campo" })]);
  assert.equal(await getNextOrder(Item, { menuID }), 0);
});

test("createOrderAllocator reparte posiciones al final de cada contenedor, de a una", () => {
  const next = createOrderAllocator([
    { menuID: "a", order: 4 },
    { menuID: "a", order: 1 },
    { menuID: "b" },
  ], itemContainerKey);

  assert.equal(next("a"), 5);
  assert.equal(next("a"), 6);
  assert.equal(next("b"), 0, "sin order en el contenedor: lo nuevo va después");
  assert.equal(next("c"), 0, "contenedor vacío");
  assert.equal(next("c"), 1);
});

test("parseReorderIds: ObjectIds en texto, sin repetir; cualquier otra cosa es null", () => {
  const a = String(oid(1));
  const b = String(oid(2));
  assert.deepEqual(parseReorderIds([a, b]), [a, b]);
  assert.deepEqual(parseReorderIds([a.toUpperCase()]), [a]);

  const tooMany = Array.from({ length: MAX_REORDER_IDS + 1 }, (_, index) => String(oid(index + 1)));
  for (const invalid of [undefined, null, "abc", {}, [], [a, a], [a, a.toUpperCase()], [a, "no-es-un-id"], [a, 12], tooMany]) {
    assert.equal(parseReorderIds(invalid), null, `debe rechazar ${JSON.stringify(invalid)?.slice(0, 40)}`);
  }
});

test("buildReorder: 0, 1, 2... en el orden pedido, escribiendo solo lo que cambia", () => {
  const a = { _id: oid(1), order: 0 };
  const b = { _id: oid(2), order: 1 };
  const c = { _id: oid(3), order: 2 };

  const { orderedIds, operations } = buildReorder({
    requestedIds: [a, c, b].map((doc) => String(doc._id)),
    containerDocs: [a, b, c],
    docsById: new Map([a, b, c].map((doc) => [String(doc._id), doc])),
    containerPatch: { menuID: "no-se-usa" },
  });

  assert.deepEqual(orderedIds, [a, c, b].map((doc) => String(doc._id)));
  assert.deepEqual(operations, [
    { updateOne: { filter: { _id: c._id }, update: { $set: { order: 1 } } } },
    { updateOne: { filter: { _id: b._id }, update: { $set: { order: 2 } } } },
  ]);
});

test("buildReorder: lo que llega de otro contenedor se muda; lo que el pedido no nombra queda al final", () => {
  const a = { _id: oid(1), order: 0 };
  const b = { _id: oid(2), order: 1 };
  const deAfuera = { _id: oid(9), order: 0 };
  const viejo = { _id: oid(3) }; // anterior al campo

  const { orderedIds, operations } = buildReorder({
    requestedIds: [String(deAfuera._id), String(a._id)],
    containerDocs: [a, b, viejo],
    docsById: new Map([a, b, deAfuera, viejo].map((doc) => [String(doc._id), doc])),
    containerPatch: { menuID: "destino" },
  });

  // Los no nombrados, en su orden actual: primero el que no tiene order.
  assert.deepEqual(orderedIds, [deAfuera, a, viejo, b].map((doc) => String(doc._id)));
  assert.deepEqual(operations, [
    { updateOne: { filter: { _id: deAfuera._id }, update: { $set: { order: 0, menuID: "destino" } } } },
    { updateOne: { filter: { _id: a._id }, update: { $set: { order: 1 } } } },
    { updateOne: { filter: { _id: viejo._id }, update: { $set: { order: 2 } } } },
    { updateOne: { filter: { _id: b._id }, update: { $set: { order: 3 } } } },
  ]);
});
