// Verificación de email post-registro: a diferencia de baja/arrepentimiento
// (públicos, identificados por requestId), acá el JWT ya prueba quién es el
// dueño de la cuenta — el pendiente se busca por userID, sin requestId de
// por medio. Ver claimPendingServiceAction en utils/serviceActionCodes.js.
const test = require("node:test");
const assert = require("node:assert/strict");

const User = require("../src/models/User");
const PendingServiceAction = require("../src/models/PendingServiceAction");
const mailer = require("../src/utils/mailer");
const { hashCode } = require("../src/utils/serviceActionCodes");
const { verifyEmail, resendVerificationCode } = require("../src/controllers/userController");

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

// Mismo enfoque que serviceActions.test.js: un único documento en memoria
// alcanza porque cada test ejercita a lo sumo un código pendiente a la vez.
const mockPendingServiceAction = (t, initialDoc = null) => {
  const store = { doc: initialDoc };

  t.mock.method(PendingServiceAction, "deleteMany", async () => ({ deletedCount: 0 }));

  t.mock.method(PendingServiceAction, "create", async (data) => {
    const doc = { _id: "pending-verif-1", attempts: 0, consumed: false, ...data };
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

test("verifyEmail: código correcto marca emailVerified=true", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t, {
    _id: "pending-verif-1",
    action: "verificacion_email",
    userID: "user-1",
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
  });

  const req = { user: { _id: "user-1", emailVerified: false }, body: { code: "123456" } };
  const res = createResponse();
  await verifyEmail(req, res);

  assert.equal(res.body.emailVerified, true);
  assert.equal(updatedID, "user-1");
  assert.deepEqual(updatedSet, { emailVerified: true });
});

test("verifyEmail: código incorrecto no marca la cuenta como verificada", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t, {
    _id: "pending-verif-1",
    action: "verificacion_email",
    userID: "user-1",
    attempts: 0,
    consumed: false,
    codeHash: hashCode("123456"),
    expiresAt: new Date(Date.now() + 60000),
  });

  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe marcar la cuenta como verificada"));

  const req = { user: { _id: "user-1", emailVerified: false }, body: { code: "000000" } };
  const res = createResponse();
  await verifyEmail(req, res);

  assert.equal(res.statusCode, 400);
});

test("verifyEmail: código de otra cuenta no sirve (el pendiente se busca por userID, no por el código solo)", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t, {
    _id: "pending-verif-1",
    action: "verificacion_email",
    userID: "user-otro",
    attempts: 0,
    consumed: false,
    codeHash: hashCode("123456"),
    expiresAt: new Date(Date.now() + 60000),
  });

  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe marcar la cuenta como verificada"));

  const req = { user: { _id: "user-1", emailVerified: false }, body: { code: "123456" } };
  const res = createResponse();
  await verifyEmail(req, res);

  assert.equal(res.statusCode, 400);
});

test("verifyEmail: cuenta ya verificada responde ok sin tocar el código pendiente", async (t) => {
  silenceLogs(t);
  t.mock.method(PendingServiceAction, "findOne", async () => assert.fail("no debe consultar códigos pendientes"));

  const req = { user: { _id: "user-1", emailVerified: true }, body: {} };
  const res = createResponse();
  await verifyEmail(req, res);

  assert.equal(res.body.emailVerified, true);
});

test("resendVerificationCode: manda un código nuevo al email real de la cuenta", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t);

  let sentTo = null;
  let sentAction = null;
  t.mock.method(mailer, "sendConfirmationCodeEmail", async ({ to, action }) => {
    sentTo = to;
    sentAction = action;
  });

  const req = {
    user: { _id: "user-1", emailVerified: false, contactInfo: { mail: "dueno-real@example.com" } },
  };
  const res = createResponse();
  await resendVerificationCode(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(sentTo, "dueno-real@example.com");
  assert.equal(sentAction, "verificacion_email");
});

test("resendVerificationCode: cuenta ya verificada no manda mail", async (t) => {
  silenceLogs(t);
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => assert.fail("no debe mandar mail"));

  const req = { user: { _id: "user-1", emailVerified: true } };
  const res = createResponse();
  await resendVerificationCode(req, res);

  assert.equal(res.body.emailVerified, true);
});
