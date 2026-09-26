const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const PageView = require("../src/models/PageView");
const ItemView = require("../src/models/ItemView");
const Item = require("../src/models/Item");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const { buildStatsPeriod } = require("../src/utils/statsPeriod");
const { fetchStats, fetchItemStats, trackItemViewEndpoint, trackMenuEvent } = require("../src/controllers/userController");
const { summarizeWindow } = require("../src/utils/menuAnalytics");

const user = { _id: new mongoose.Types.ObjectId(), createdAt: new Date("2026-01-01T12:00:00Z") };
const now = new Date("2026-09-16T15:00:00Z").getTime();
const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  sendStatus(code) { this.statusCode = code; return this; },
});

test("7/30 días: ventanas adyacentes completas al corte de medianoche BA", () => {
  for (const size of [7, 30]) {
    const before = buildStatsPeriod(size, user.createdAt, new Date("2026-09-16T02:59:59Z").getTime());
    const after = buildStatsPeriod(size, user.createdAt, new Date("2026-09-16T03:00:00Z").getTime());
    assert.equal(before.todayDate, "2026-09-15");
    assert.equal(before.periodEnd, "2026-09-14");
    assert.equal(after.todayDate, "2026-09-16");
    assert.equal(after.periodEnd, "2026-09-15");
    assert.equal(after.dates.length, size);
    assert.equal(after.previousDates.length, size);
    assert.equal(new Set([...after.dates, ...after.previousDates]).size, size * 2);
    assert.equal((new Date(after.periodStart) - new Date(after.previousEnd)) / 86400000, 1);
  }
});

test("el alta parcial, desconocida o reciente impide comparar ventanas", () => {
  for (const createdAt of [undefined, "invalid", "2026-09-02T12:00:00Z", "2026-09-15T12:00:00Z"]) {
    assert.equal(buildStatsPeriod(7, createdAt, now).comparisonAvailable, false);
  }
  assert.equal(buildStatsPeriod(7, user.createdAt, now).comparisonAvailable, true);
});

test("visitas: ceros, total actual/anterior y hoy separados, consulta solo el usuario autenticado", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(PageView, "find", async query => {
    assert.equal(query.userID, user._id);
    assert.deepEqual(query.date, { $gte: "2026-07-18", $lte: "2026-09-16" });
    return [
      { date: "2026-08-16", count: 5 }, { date: "2026-08-17", count: 10 },
      { date: "2026-09-15", count: 20 }, { date: "2026-09-16", count: 999 },
    ];
  });
  const res = response();
  await fetchStats({ user, query: { days: "30", userID: "otro-local" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalViews, 30);
  assert.equal(res.body.previousTotalViews, 5);
  assert.equal(res.body.todayViews, 999);
  assert.equal(res.body.days.length, 30);
  assert.equal(res.body.previousDays.length, 30);
  assert.equal(res.body.days[1].count, 0);
  assert.equal(res.body.periodStart, "2026-08-17");
});

test("ranking: agrupa ambos períodos del mismo local, excluye hoy y conserva productos eliminados", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const itemId = new mongoose.Types.ObjectId();
  const deletedId = new mongoose.Types.ObjectId();
  const orderedOnlyId = new mongoose.Types.ObjectId();
  t.mock.method(ItemView, "aggregate", async pipeline => {
    assert.deepEqual(pipeline[0].$match, {
      userID: user._id, date: { $gte: "2026-09-02", $lte: "2026-09-15" },
    });
    assert.deepEqual(pipeline[1].$group.totalViews.$sum.$cond, [{ $gte: ["$date", "2026-09-09"] }, "$count", 0]);
    assert.deepEqual(pipeline[1].$group.previousViews.$sum.$cond, [{ $lt: ["$date", "2026-09-09"] }, "$count", 0]);
    assert.deepEqual(pipeline[1].$group.orders.$sum.$cond, [{ $gte: ["$date", "2026-09-09"] }, { $ifNull: ["$orders", 0] }, 0]);
    assert.deepEqual(pipeline.at(-1), { $limit: 10 });
    if (pipeline[2].$match.orders) {
      assert.deepEqual(pipeline[3], { $sort: { orders: -1, totalViews: -1, _id: 1 } });
      return [{ _id: orderedOnlyId, totalViews: 0, previousViews: 0, orders: 4 }, { _id: itemId, totalViews: 20, previousViews: 8, orders: 3 }];
    }
    assert.deepEqual(pipeline[2], { $match: { totalViews: { $gt: 0 } } });
    return [{ _id: itemId, totalViews: 20, previousViews: 8, orders: 3 }, { _id: deletedId, totalViews: 5, previousViews: 0, orders: 0 }];
  });
  t.mock.method(Item, "find", query => {
    // Una sola búsqueda para los dos rankings, sin repetir productos.
    assert.deepEqual(query._id.$in, [itemId, deletedId, orderedOnlyId]);
    return { select: async () => [
      { _id: itemId, title: "Empanadas", image: "" },
      { _id: orderedOnlyId, title: "Flan", image: "flan.jpg" },
    ] };
  });
  const res = response();
  await fetchItemStats({ user, query: { days: "7", userID: "otro-local" } }, res);
  assert.equal(res.body.topItems[0].previousViews, 8);
  assert.equal(res.body.topItems[0].orders, 3);
  assert.equal(res.body.topItems[1].title, "(producto eliminado)");
  assert.deepEqual(res.body.topOrdered.map(item => [item.title, item.orders]), [["Flan", 4], ["Empanadas", 3]]);
  assert.equal(res.body.windowDays, 7);
});

test("resumen del período: horas y embudo solo de días completos del período, con desde cuándo se miden", () => {
  const dates = ["2026-09-13", "2026-09-14", "2026-09-15"];
  const summary = summarizeWindow([
    // Día anterior al período y hoy: no entran.
    { date: "2026-09-12", count: 9, hours: { 20: 9 }, tracked: 9, visitors: 9 },
    { date: "2026-09-16", count: 4, hours: { 12: 4 }, tracked: 4 },
    // Día viejo, sin horas ni protocolo nuevo.
    { date: "2026-09-13", count: 7 },
    // Horas de un bundle anterior (sin tracked) y claves basura.
    { date: "2026-09-14", count: 3, hours: { 20: 2, 21: 1, 24: 5, x: 1, 13: -2 } },
    { date: "2026-09-15", count: 6, hours: { "20": 4, "13": 2 }, tracked: 5, visitors: 4, returning: 1, qr: 3, engaged: 3, carts: 2, orders: 1 },
  ], dates);
  assert.equal(summary.hours.length, 24);
  assert.equal(summary.hours[20], 6);
  assert.equal(summary.hours[21], 1);
  assert.equal(summary.hours[13], 2);
  assert.equal(summary.hours.reduce((a, b) => a + b, 0), 9);
  assert.equal(summary.hoursFrom, "2026-09-14");
  assert.deepEqual(summary.audience, {
    from: "2026-09-15", visits: 5, visitors: 4, returning: 1, qr: 3, engaged: 3, carts: 2, orders: 1,
  });

  const empty = summarizeWindow([{ date: "2026-09-14", count: 3 }], dates);
  assert.equal(empty.hoursFrom, null);
  assert.equal(empty.audience.from, null);
});

test("estadísticas: la respuesta suma horas y embudo del período", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(PageView, "find", async () => [
    { date: "2026-09-15", count: 3, hours: { 21: 3 }, tracked: 3, visitors: 2, qr: 1 },
    { date: "2026-09-16", count: 5, hours: { 11: 5 }, tracked: 5 },
  ]);
  const res = response();
  await fetchStats({ user, query: { days: "7" } }, res);
  assert.equal(res.body.hours[21], 3);
  assert.equal(res.body.hours[11], 0);
  assert.equal(res.body.hoursFrom, "2026-09-15");
  assert.equal(res.body.audience.visits, 3);
  assert.equal(res.body.audience.qr, 1);
});

const eventUser = { _id: new mongoose.Types.ObjectId() };
const mockEventUser = (t, found = eventUser) => t.mock.method(User, "findOne", query => {
  assert.equal(query.active, true);
  return { select: async () => found };
});

test("eventos del embudo: suma el campo del día y siempre responde 204", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  mockEventUser(t);
  const update = t.mock.method(PageView, "findOneAndUpdate", async () => ({}));
  t.mock.method(Menu, "find", () => assert.fail("sin productos no consulta menús"));
  for (const [type, field] of [["engaged", "engaged"], ["cart", "carts"], ["order", "orders"]]) {
    const res = response();
    await trackMenuEvent({ params: { slug: "Local" }, body: { type } }, res);
    assert.equal(res.statusCode, 204);
    const [filter, inc, options] = update.mock.calls.at(-1).arguments;
    assert.deepEqual(filter, { userID: eventUser._id, date: "2026-09-16" });
    assert.deepEqual(inc, { $inc: { [field]: 1 } });
    assert.deepEqual(options, { upsert: true });
  }
  assert.equal(update.mock.callCount(), 3);
});

test("eventos del embudo: tipos desconocidos, sin body o de un local inexistente no escriben", async (t) => {
  const update = t.mock.method(PageView, "findOneAndUpdate", () => assert.fail("no debe escribir"));
  mockEventUser(t, null);
  for (const body of [undefined, {}, { type: "toString" }, { type: "__proto__" }, { type: ["order"] }, { type: "order" }]) {
    const res = response();
    await trackMenuEvent({ params: { slug: "local" }, body }, res);
    assert.equal(res.statusCode, 204);
  }
  assert.equal(update.mock.callCount(), 0);
});

test("pedido: suma solo los productos del local, sin repetir, e ignora ids inválidos", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  mockEventUser(t);
  t.mock.method(PageView, "findOneAndUpdate", async () => ({}));
  const menuId = new mongoose.Types.ObjectId();
  const mine = new mongoose.Types.ObjectId();
  const foreign = new mongoose.Types.ObjectId();
  t.mock.method(Menu, "find", query => {
    assert.equal(query.userID, eventUser._id);
    return { select: async () => [{ _id: menuId }] };
  });
  t.mock.method(Item, "find", query => {
    assert.deepEqual(query._id.$in, [mine.toString(), foreign.toString()]);
    assert.deepEqual(query.menuID.$in, [menuId]);
    return { select: async () => [{ _id: mine }] };
  });
  const bulk = t.mock.method(ItemView, "bulkWrite", async () => ({}));
  const res = response();
  await trackMenuEvent({ params: { slug: "local" }, body: {
    type: "order",
    items: [mine.toString(), mine.toString(), foreign.toString(), "aaaaaaaaaaaa", { $gt: "" }, 7],
  } }, res);
  assert.equal(res.statusCode, 204);
  const [ops, options] = bulk.mock.calls[0].arguments;
  assert.deepEqual(ops, [{ updateOne: {
    filter: { userID: eventUser._id, itemID: mine, date: "2026-09-16" },
    update: { $inc: { orders: 1 } },
    upsert: true,
  } }]);
  assert.deepEqual(options, { ordered: false });
});

test("pedido: un error de base no se propaga a la carta", async (t) => {
  mockEventUser(t);
  t.mock.method(PageView, "findOneAndUpdate", async () => { throw new Error("caído"); });
  const res = response();
  await trackMenuEvent({ params: { slug: "local" }, body: { type: "order", items: [] } }, res);
  assert.equal(res.statusCode, 204);
});

test("períodos inválidos se rechazan sin consultar datos", async (t) => {
  t.mock.method(PageView, "find", () => assert.fail("no debe consultar"));
  t.mock.method(ItemView, "aggregate", () => assert.fail("no debe consultar"));
  for (const days of ["0", "90", "7x", 7, ["7", "30"], { $gt: 0 }]) {
    for (const controller of [fetchStats, fetchItemStats]) {
      const res = response();
      await controller({ user, query: { days } }, res);
      assert.equal(res.statusCode, 400);
    }
  }
});

test("el contrato anterior sin days sigue disponible", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(PageView, "find", async () => [{ date: "2026-09-16", count: 9 }]);
  t.mock.method(ItemView, "aggregate", async () => []);
  t.mock.method(Item, "find", () => ({ select: async () => [] }));
  const visits = response(), items = response();
  await fetchStats({ user }, visits);
  await fetchItemStats({ user }, items);
  assert.equal(visits.body.last30Days.length, 30);
  assert.equal(visits.body.totalViews, 9);
  assert.deepEqual(items.body, { topItems: [], windowDays: 30 });
});

test("errores de DB pasan por handleError sin exponer detalles", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(PageView, "find", async () => { throw new Error("private-db-info"); });
  t.mock.method(ItemView, "aggregate", async () => { throw new Error("private-db-info"); });
  for (const controller of [fetchStats, fetchItemStats]) {
    const res = response();
    await controller({ user, query: { days: "7" } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.stringify(res.body).includes("private-db-info"), false);
  }
});

test("no registra interacción con un producto de otro local", async (t) => {
  t.mock.method(User, "findOne", () => ({ select: async () => user }));
  t.mock.method(Item, "findById", () => ({ select: async () => ({ menuID: new mongoose.Types.ObjectId() }) }));
  t.mock.method(Menu, "findOne", query => {
    assert.equal(query.userID, user._id);
    return { select: async () => null };
  });
  t.mock.method(ItemView, "findOneAndUpdate", () => assert.fail("producto ajeno"));
  const res = response();
  await trackItemViewEndpoint({ params: { slug: "local", itemID: new mongoose.Types.ObjectId().toString() } }, res);
  assert.equal(res.statusCode, 204);
});
