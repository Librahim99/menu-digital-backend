// Verificación de email post-registro: a diferencia de baja/arrepentimiento
// (públicos, identificados por requestId), acá el JWT ya prueba quién es el
// dueño de la cuenta — el pendiente se busca por userID, sin requestId de
// por medio. Ver claimPendingServiceAction en utils/serviceActionCodes.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const User = require("../src/models/User");
const PendingServiceAction = require("../src/models/PendingServiceAction");
const mailer = require("../src/utils/mailer");
const { hashCode } = require("../src/utils/serviceActionCodes");
const {
  verifyEmail,
  resendVerificationCode,
  getEmailVerificationStatus,
  changeUnverifiedEmail,
} = require("../src/controllers/userController");
const { protect, protectAllowUnverified } = require("../src/middleware/auth");

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

test("resendVerificationCode: respeta la espera mínima entre reenvíos", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t, {
    _id: "pending-verif-1",
    action: "verificacion_email",
    userID: "user-1",
    attempts: 0,
    consumed: false,
    codeHash: hashCode("123456"),
    createdAt: new Date(Date.now() - 5000),
    expiresAt: new Date(Date.now() + 60000),
  });
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => assert.fail("no debe mandar mail"));

  const req = {
    user: { _id: "user-1", emailVerified: false, contactInfo: { mail: "dueno-real@example.com" } },
  };
  const res = createResponse();
  await resendVerificationCode(req, res);

  assert.equal(res.statusCode, 429);
  assert.ok(res.body.retryAfterSeconds > 0 && res.body.retryAfterSeconds <= 30);
});

test("resendVerificationCode: pasada la espera manda un código nuevo aunque el anterior siga vigente", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t, {
    _id: "pending-verif-1",
    action: "verificacion_email",
    userID: "user-1",
    attempts: 0,
    consumed: false,
    codeHash: hashCode("123456"),
    createdAt: new Date(Date.now() - 31000),
    expiresAt: new Date(Date.now() + 60000),
  });
  let sent = 0;
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => { sent += 1; });

  const req = {
    user: { _id: "user-1", emailVerified: false, contactInfo: { mail: "dueno-real@example.com" } },
  };
  const res = createResponse();
  await resendVerificationCode(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(sent, 1);
});

test("getEmailVerificationStatus: informa el email y si hay un código vigente", async (t) => {
  silenceLogs(t);
  const expiresAt = new Date(Date.now() + 60000);
  mockPendingServiceAction(t, {
    _id: "pending-verif-1",
    action: "verificacion_email",
    userID: "user-1",
    consumed: false,
    expiresAt,
  });

  const req = {
    user: { _id: "user-1", emailVerified: false, contactInfo: { mail: "dueno-real@example.com" } },
  };
  const res = createResponse();
  await getEmailVerificationStatus(req, res);

  assert.deepEqual(res.body, {
    emailVerified: false,
    email: "dueno-real@example.com",
    codeActive: true,
    codeExpiresAt: expiresAt,
  });
});

test("getEmailVerificationStatus: sin código vigente (el mail del alta falló o venció) lo dice", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t);

  const req = {
    user: { _id: "user-1", emailVerified: false, contactInfo: { mail: "dueno-real@example.com" } },
  };
  const res = createResponse();
  await getEmailVerificationStatus(req, res);

  assert.equal(res.body.codeActive, false);
  assert.equal(res.body.codeExpiresAt, null);
});

test("changeUnverifiedEmail: guarda el email corregido en minúsculas y manda el código ahí", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t);
  t.mock.method(User, "findOne", () => ({ select: async () => null }));

  let updatedSet = null;
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => {
    updatedSet = update.$set;
  });
  let sentTo = null;
  t.mock.method(mailer, "sendConfirmationCodeEmail", async ({ to }) => { sentTo = to; });

  const req = {
    user: { _id: "user-1", emailVerified: false, contactInfo: { mail: "dueno@gmial.com" } },
    body: { mail: "Dueno@Gmail.com" },
  };
  const res = createResponse();
  await changeUnverifiedEmail(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.email, "dueno@gmail.com");
  assert.deepEqual(updatedSet, { "contactInfo.mail": "dueno@gmail.com" });
  assert.equal(sentTo, "dueno@gmail.com");
});

test("changeUnverifiedEmail: rechaza un email que ya usa otra cuenta", async (t) => {
  silenceLogs(t);
  t.mock.method(User, "findOne", () => ({ select: async () => ({ _id: "otra-cuenta" }) }));
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe guardar el email"));
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => assert.fail("no debe mandar mail"));

  const req = {
    user: { _id: "user-1", emailVerified: false, contactInfo: { mail: "dueno@gmial.com" } },
    body: { mail: "ocupado@example.com" },
  };
  const res = createResponse();
  await changeUnverifiedEmail(req, res);

  assert.equal(res.statusCode, 409);
});

test("changeUnverifiedEmail: una cuenta ya verificada no puede saltearse el cambio con código", async (t) => {
  silenceLogs(t);
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe guardar el email"));

  const req = {
    user: { _id: "user-1", emailVerified: true, contactInfo: { mail: "dueno@example.com" } },
    body: { mail: "otro@example.com" },
  };
  const res = createResponse();
  await changeUnverifiedEmail(req, res);

  assert.equal(res.statusCode, 400);
});

test("changeUnverifiedEmail: si el mail falla, el email nuevo queda guardado y avisa que reenvíe", async (t) => {
  silenceLogs(t);
  const store = mockPendingServiceAction(t);
  t.mock.method(PendingServiceAction, "deleteOne", async () => { store.doc = null; });
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  let saved = false;
  t.mock.method(User, "findByIdAndUpdate", async () => { saved = true; });
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => { throw new Error("smtp caído"); });

  const req = {
    user: { _id: "user-1", emailVerified: false, contactInfo: { mail: "dueno@gmial.com" } },
    body: { mail: "dueno@gmail.com" },
  };
  const res = createResponse();
  await changeUnverifiedEmail(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.email, "dueno@gmail.com");
  assert.equal(saved, true);
  assert.equal(store.doc, null);
});

// El bloqueo de cuentas sin verificar vivía solo en el frontend: con el token
// se podía usar toda la API. Ver buildProtect en middleware/auth.js.
const runProtect = async (t, middleware, user) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "jwt-secret-de-prueba";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  t.mock.method(User, "findById", () => ({ select: async () => user }));

  const token = jwt.sign({ id: "user-1" }, process.env.JWT_SECRET, { algorithm: "HS256" });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = createResponse();
  let passed = false;
  await middleware(req, res, () => { passed = true; });
  return { res, passed };
};

test("protect corta con 403 EMAIL_NOT_VERIFIED a una cuenta sin verificar", async (t) => {
  const { res, passed } = await runProtect(t, protect, { _id: "user-1", active: true, emailVerified: false });

  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "EMAIL_NOT_VERIFIED");
});

test("protectAllowUnverified deja pasar a una cuenta sin verificar (GET /me y verify-email)", async (t) => {
  const { passed } = await runProtect(t, protectAllowUnverified, { _id: "user-1", active: true, emailVerified: false });

  assert.equal(passed, true);
});

test("protect deja pasar a una cuenta verificada", async (t) => {
  const verified = await runProtect(t, protect, { _id: "user-1", active: true, emailVerified: true });
  assert.equal(verified.passed, true);
});

test("protect deja pasar a una cuenta vieja sin el campo emailVerified", async (t) => {
  const legacy = await runProtect(t, protect, { _id: "user-1", active: true });
  assert.equal(legacy.passed, true);
});

test("protect no bloquea a un admin aunque figure sin verificar", async (t) => {
  const admin = await runProtect(t, protect, { _id: "user-1", active: true, admin: true, emailVerified: false });
  assert.equal(admin.passed, true);
});
