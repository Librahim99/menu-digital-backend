const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const { editUser } = require("../src/controllers/userController");

const scheduleWith = (hours) => Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => [
    day, day === "fri" ? hours : { enabled: false },
  ]),
);
const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("editUser guarda horarios diurnos, nocturnos y de 24 horas sin alterar los valores", async (t) => {
  let saved;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update, options) => {
    assert.equal(options.runValidators, true);
    saved = update.$set.schedule;
    return { schedule: saved };
  });
  for (const [open, close] of [["09:00", "18:00"], ["15:30", "01:00"], ["15:30", "00:00"], ["00:00", "00:00"], ["09:00", "09:00"]]) {
    const schedule = scheduleWith({ enabled: true, open, close });
    const res = response();
    await editUser({ user: { _id: "local" }, body: { schedule } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(saved, schedule);
    assert.deepEqual(res.body.schedule, schedule);
  }
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
  ]) {
    const res = response();
    await editUser({ user: { _id: "local" }, body: { schedule: scheduleWith(hours) } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(update.mock.callCount(), 0);
});
