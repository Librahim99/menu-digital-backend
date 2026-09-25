const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const { editUser } = require("../src/controllers/userController");

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const scheduleWith = (hours, closed = { enabled: false }) => Object.fromEntries(
  DAYS.map(day => [day, day === "fri" ? hours : closed]),
);
const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("editUser guarda horarios diurnos, nocturnos y de 24 horas como un turno", async (t) => {
  let saved;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update, options) => {
    assert.equal(options.runValidators, true);
    saved = update.$set.schedule;
    return { schedule: saved };
  });
  for (const [open, close] of [["09:00", "18:00"], ["15:30", "01:00"], ["15:30", "00:00"], ["00:00", "00:00"], ["09:00", "09:00"]]) {
    const res = response();
    await editUser({ user: { _id: "local" }, body: { schedule: scheduleWith({ enabled: true, open, close }) } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(saved, scheduleWith(
      { enabled: true, open, close, ranges: [{ from: open, to: close }] },
      { enabled: false, ranges: [] },
    ));
    assert.deepEqual(res.body.schedule, saved);
  }
});

test("editUser guarda turnos cortados y copia el primero en open/close", async (t) => {
  let saved;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    saved = update.$set.schedule;
    return { schedule: saved };
  });
  const ranges = [{ from: "12:00", to: "15:00" }, { from: "20:00", to: "01:00" }];
  const res = response();
  await editUser({
    user: { _id: "local" },
    // open/close viejos se pisan con el primer turno; un día cerrado
    // conserva sus horas pero no sus turnos.
    body: { schedule: scheduleWith(
      { enabled: true, open: "08:00", close: "09:00", ranges },
      { enabled: false, open: "10:00", close: "11:00", ranges: [{ from: "10:00", to: "11:00" }] },
    ) },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(saved.fri, { enabled: true, open: "12:00", close: "15:00", ranges });
  assert.deepEqual(saved.mon, { enabled: false, open: "10:00", close: "11:00", ranges: [] });
});

test("editUser rechaza horarios inválidos antes de persistir", async (t) => {
  const update = t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe persistir"));
  for (const hours of [
    { enabled: true, open: "", close: "01:00" },
    { enabled: true, open: "15:30", close: "24:00" },
    { enabled: true, open: "15:30", close: "01:60" },
    { enabled: true, open: ["15:30"], close: "01:00" },
    { enabled: true, open: "15:30" },
    { enabled: "true", open: "15:30", close: "01:00" },
    { enabled: true, ranges: [] },
    { enabled: true, ranges: "12:00-15:00" },
    { enabled: true, ranges: [{ from: "12:00", to: "25:00" }] },
    { enabled: true, ranges: [{ from: "12:00", to: "16:00" }, { from: "15:00", to: "18:00" }] },
    { enabled: true, ranges: Array.from({ length: 5 }, (_, i) => ({ from: `0${i}:00`, to: `0${i}:30` })) },
  ]) {
    const res = response();
    await editUser({ user: { _id: "local" }, body: { schedule: scheduleWith(hours) } }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(hours));
  }
  assert.equal(update.mock.callCount(), 0);
});

test("editUser rechaza un turno nocturno que se pisa con el del día siguiente", async (t) => {
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("No debe persistir"));
  const schedule = scheduleWith({ enabled: true, ranges: [{ from: "20:00", to: "03:00" }] });
  schedule.sat = { enabled: true, ranges: [{ from: "02:00", to: "10:00" }] };
  const res = response();
  await editUser({ user: { _id: "local" }, body: { schedule } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /superponerse/);
});
