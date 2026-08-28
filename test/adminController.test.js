const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const CrmProfile = require("../src/models/CrmProfile");
const { setActiveUser } = require("../src/controllers/adminController");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("setActiveUser rechaza estados que no sean booleanos", async (t) => {
  t.mock.method(User, "findById", () => {
    throw new Error("No debe consultar User con un payload inválido");
  });

  const req = {
    body: { active: "false" },
    params: { userID: "64f000000000000000000123" },
    user: { _id: { toString: () => "64f000000000000000000999" } },
  };
  const res = response();
  await setActiveUser(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "active debe ser un booleano" });
});

test("setActiveUser actualiza al cliente y registra el evento CRM", async (t) => {
  const clientID = "64f000000000000000000123";
  let saved = false;
  let eventUpdate;
  const user = {
    _id: clientID,
    username: "cliente-prueba",
    slug: "cliente-prueba",
    active: true,
    admin: false,
    contactInfo: { businessName: "Bar de prueba" },
    save: async () => { saved = true; },
  };

  t.mock.method(User, "findById", async () => user);
  t.mock.method(CrmProfile, "findOneAndUpdate", async (_filter, update) => {
    eventUpdate = update;
  });

  const req = {
    body: { active: false },
    params: { userID: clientID },
    user: { _id: { toString: () => "64f000000000000000000999" } },
  };
  const res = response();
  await setActiveUser(req, res);

  assert.equal(saved, true);
  assert.equal(user.active, false);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.user, {
    _id: clientID,
    username: "cliente-prueba",
    slug: "cliente-prueba",
    active: false,
    businessName: "Bar de prueba",
  });
  assert.equal(
    eventUpdate.$push.notes.$each[0].text,
    "Cuenta desactivada por el CEO"
  );
});
