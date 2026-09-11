const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const Plan = require("../src/models/Plan");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { getAuthUser, editUser } = require("../src/controllers/userController");

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("/me devuelve la última conexión persistida y solo actualiza ese campo", async (t) => {
  const user = new User({ subscription: "free", updatedAt: new Date("2026-09-01T12:00:00Z") });
  const originalUpdatedAt = user.updatedAt;
  const connections = [new Date("2026-09-11T18:30:00Z"), new Date("2026-09-11T19:00:00Z")];
  t.mock.method(User, "findByIdAndUpdate", async (id, update, options) => {
    assert.equal(id, user._id);
    assert.deepEqual(update, { $currentDate: { lastConnectionAt: true } });
    assert.deepEqual(options, { new: true, timestamps: false });
    user.lastConnectionAt = connections.shift(); // Valor que devuelve MongoDB.
    return user;
  });
  t.mock.method(Menu, "find", async () => []);
  t.mock.method(Item, "countDocuments", async () => 0);
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find(plan => plan.name === name)));

  for (const expected of ["2026-09-11T18:30:00.000Z", "2026-09-11T19:00:00.000Z"]) {
    const res = response();
    await getAuthUser({ user: { _id: user._id }, body: { lastConnectionAt: "2099-01-01" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.lastConnectionAt.toISOString(), expected);
    assert.deepEqual(res.body.updatedAt, originalUpdatedAt);
    assert.equal(res.body.subscription, "free");
    assert.equal(res.body.password, undefined);
  }
});

test("las cuentas sin actividad tienen última conexión desconocida", () => {
  assert.equal(new User().lastConnectionAt, null);
  assert.equal(User.schema.path("lastConnectionAt").instance, "Date");
});

test("/me conserva el 404 si el usuario ya no existe", async (t) => {
  t.mock.method(User, "findByIdAndUpdate", async () => null);
  const res = response();
  await getAuthUser({ user: { _id: "usuario-eliminado" } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, "Usuario no encontrado");
});

test("/me usa handleError si no puede persistir la conexión", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(User, "findByIdAndUpdate", async () => { throw new Error("falló la base"); });
  const res = response();
  await getAuthUser({ user: { _id: "usuario" } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, "Ocurrió un error interno. Intentá de nuevo.");
});

test("PUT /me no permite que el cliente cambie lastConnectionAt", async (t) => {
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    assert.deepEqual(update, { $set: { hasDelivery: true } });
    return update.$set;
  });
  const res = response();
  await editUser({
    user: { _id: "usuario" },
    body: { hasDelivery: true, lastConnectionAt: "2099-01-01T00:00:00Z" },
  }, res);
  assert.equal(res.statusCode, 200);
});
