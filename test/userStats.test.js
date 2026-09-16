const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const PageView = require("../src/models/PageView");
const ItemView = require("../src/models/ItemView");
const Item = require("../src/models/Item");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const { buildStatsPeriod } = require("../src/utils/statsPeriod");
const { fetchStats, fetchItemStats, trackItemViewEndpoint } = require("../src/controllers/userController");

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
  t.mock.method(ItemView, "aggregate", async pipeline => {
    assert.deepEqual(pipeline[0].$match, {
      userID: user._id, date: { $gte: "2026-09-02", $lte: "2026-09-15" },
    });
    assert.deepEqual(pipeline[1].$group.totalViews.$sum.$cond, [{ $gte: ["$date", "2026-09-09"] }, "$count", 0]);
    assert.deepEqual(pipeline[1].$group.previousViews.$sum.$cond, [{ $lt: ["$date", "2026-09-09"] }, "$count", 0]);
    assert.deepEqual(pipeline[2], { $match: { totalViews: { $gt: 0 } } });
    assert.deepEqual(pipeline.at(-1), { $limit: 10 });
    return [{ _id: itemId, totalViews: 20, previousViews: 8 }, { _id: deletedId, totalViews: 5, previousViews: 0 }];
  });
  t.mock.method(Item, "find", query => {
    assert.deepEqual(query._id.$in, [itemId, deletedId]);
    return { select: async () => [{ _id: itemId, title: "Empanadas", image: "" }] };
  });
  const res = response();
  await fetchItemStats({ user, query: { days: "7", userID: "otro-local" } }, res);
  assert.equal(res.body.topItems[0].previousViews, 8);
  assert.equal(res.body.topItems[1].title, "(producto eliminado)");
  assert.equal(res.body.windowDays, 7);
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
