// Cambio de mail de contacto: a diferencia de verificacion_email, acá el
// mail NUEVO nunca se guarda hasta confirmarlo con el código — la cuenta
// sigue verificada durante todo el proceso (ver requestEmailChange /
// confirmEmailChange en userController.js).
const test = require("node:test");
const assert = require("node:assert/strict");

const User = require("../src/models/User");
const PendingServiceAction = require("../src/models/PendingServiceAction");
const mailer = require("../src/utils/mailer");
const { hashCode } = require("../src/utils/serviceActionCodes");
const { requestEmailChange, confirmEmailChange } = require("../src/controllers/userController");

const createResponse = () => ({
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
});

const silenceLogs = (t) => {
  t.mock.method(console, "error", () => {});
};

const mockPendingServiceAction = (t, initialDoc = null) => {
  const store = { doc: initialDoc };

  t.mock.method(PendingServiceAction, "deleteMany", async () => ({ deletedCount: 0 }));

  t.mock.method(PendingServiceAction, "create", async (data) => {
    const doc = { _id: "pending-cambio-1", attempts: 0, consumed: false, ...data };
    store.doc = doc;
    return doc;
  });

  t.mock.method(PendingServiceAction, "findOne", async (filter) => {
    const doc = store.doc;
    if (!doc) return null;
    if (filter.userID && String(filter.userID) !== String(doc.userID)) return null;
    if (filter.action && filter.action !== doc.action) return null;
    if (filter.consumed === false && doc.consumed !== false) return null;
    if (filter.expiresAt?.$gt && doc.expiresAt <= filter.expiresAt.$gt) return null;
    return doc;
  });

  t.mock.method(PendingServiceAction, "findOneAndUpdate", async (filter) => {
    const doc = store.doc;
    if (!doc) return null;
    if (filter._id && String(filter._id) !== String(doc._id)) return null;
    if (filter.consumed === false && doc.consumed !== false) return null;
    doc.consumed = true;
    return doc;
  });

  t.mock.method(PendingServiceAction, "updateOne", async (filter, update) => {
    const doc = store.doc;
    if (!doc) return { matchedCount: 0 };
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$inc) {
      for (const [key, delta] of Object.entries(update.$inc)) {
        doc[key] = (doc[key] || 0) + delta;
      }
    }
    return { matchedCount: 1 };
  });

  return store;
};

test("requestEmailChange: manda el código al mail NUEVO y no toca al usuario todavía", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t);
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe guardar el mail todavía"));

  let sentTo = null;
  let sentAction = null;
  t.mock.method(mailer, "sendConfirmationCodeEmail", async ({ to, action }) => {
    sentTo = to;
    sentAction = action;
  });

  const req = {
    user: { _id: "user-1", contactInfo: { mail: "viejo@example.com" } },
    body: { mail: "Nuevo@Example.com" },
  };
  const res = createResponse();
  await requestEmailChange(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(sentTo, "nuevo@example.com", "se normaliza a minúsculas antes de mandar el código");
  assert.equal(sentAction, "cambio_email");
});

test("requestEmailChange: rechaza pedir el cambio al mismo mail que ya tiene la cuenta", async (t) => {
  t.mock.method(PendingServiceAction, "create", async () => assert.fail("no debe crear un pedido"));

  const req = {
    user: { _id: "user-1", contactInfo: { mail: "actual@example.com" } },
    body: { mail: "actual@example.com" },
  };
  const res = createResponse();
  await requestEmailChange(req, res);

  assert.equal(res.statusCode, 400);
});

test("requestEmailChange: rechaza un mail ya usado por otra cuenta", async (t) => {
  t.mock.method(User, "findOne", () => ({ select: async () => ({ _id: "otro-user" }) }));
  t.mock.method(PendingServiceAction, "create", async () => assert.fail("no debe crear un pedido"));

  const req = {
    user: { _id: "user-1", contactInfo: { mail: "viejo@example.com" } },
    body: { mail: "de-otro@example.com" },
  };
  const res = createResponse();
  await requestEmailChange(req, res);

  assert.equal(res.statusCode, 409);
});

test("confirmEmailChange: código correcto recién ahí guarda el mail nuevo", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t, {
    _id: "pending-cambio-1",
    action: "cambio_email",
    userID: "user-1",
    email: "nuevo@example.com",
    attempts: 0,
    consumed: false,
    codeHash: hashCode("123456"),
    expiresAt: new Date(Date.now() + 60000),
  });

  let updatedID = null;
  let updatedSet = null;
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => {
    updatedID = id;
    updatedSet = update.$set;
    return { contactInfo: { mail: "nuevo@example.com" } };
  });

  const req = { user: { _id: "user-1" }, body: { code: "123456" } };
  const res = createResponse();
  await confirmEmailChange(req, res);

  assert.equal(res.body.contactInfo.mail, "nuevo@example.com");
  assert.equal(updatedID, "user-1");
  assert.deepEqual(updatedSet, { "contactInfo.mail": "nuevo@example.com" });
});

test("confirmEmailChange: código incorrecto no guarda ningún mail", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t, {
    _id: "pending-cambio-1",
    action: "cambio_email",
    userID: "user-1",
    email: "nuevo@example.com",
    attempts: 0,
    consumed: false,
    codeHash: hashCode("123456"),
    expiresAt: new Date(Date.now() + 60000),
  });
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe guardar el mail"));

  const req = { user: { _id: "user-1" }, body: { code: "000000" } };
  const res = createResponse();
  await confirmEmailChange(req, res);

  assert.equal(res.statusCode, 400);
});
