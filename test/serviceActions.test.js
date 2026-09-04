// Baja de servicio y arrepentimiento son públicos y sin login: el email por
// sí solo NO prueba titularidad de la cuenta, así que el pedido inicial
// nunca ejecuta nada — solo un código de confirmación mandado al email REAL
// de la cuenta cierra el flujo. Estos tests verifican esa propiedad de
// seguridad, no solo el happy path.
const test = require("node:test");
const assert = require("node:assert/strict");
const { PaymentRefund } = require("mercadopago");

const User = require("../src/models/User");
const PaymentTransaction = require("../src/models/PaymentTransaction");
const PendingServiceAction = require("../src/models/PendingServiceAction");
const CrmProfile = require("../src/models/CrmProfile");
const mailer = require("../src/utils/mailer");

process.env.MP_ACCESS_TOKEN = "TEST-token";
process.env.MP_WEBHOOK_URL = "https://backend.test/api/payments/webhook";
process.env.FRONTEND_URL = "https://frontend.test";
process.env.PENDING_REGISTRATION_SECRET = "test-secret-with-at-least-32-characters";

const paymentRouter = require("../src/routes/paymentRoutes");

const getHandler = (path) => {
  const routeLayer = paymentRouter.stack.find(
    (layer) => layer.route?.path === path
  );
  assert.ok(routeLayer, `No se encontró la ruta ${path}`);
  return routeLayer.route.stack.at(-1).handle;
};

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
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(CrmProfile, "findOneAndUpdate", async () => null);
};

// Simula PendingServiceAction con un único documento en memoria — alcanza
// porque cada test ejercita a lo sumo un pedido de confirmación a la vez.
const mockPendingServiceAction = (t) => {
  const store = { doc: null };

  t.mock.method(PendingServiceAction, "deleteMany", async () => ({ deletedCount: 0 }));

  t.mock.method(PendingServiceAction, "create", async (data) => {
    const doc = { _id: "pending-action-1", attempts: 0, consumed: false, ...data };
    store.doc = doc;
    return doc;
  });

  t.mock.method(PendingServiceAction, "findOne", async (filter) => {
    const doc = store.doc;
    if (!doc) return null;
    if (filter._id && String(filter._id) !== String(doc._id)) return null;
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

// ──────────────────────────────────────────────
// Baja de servicio
// ──────────────────────────────────────────────

test("POST /baja: el pedido no baja el plan — solo manda un código al email real de la cuenta", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t);

  const user = {
    _id: "user-1",
    username: "milocal",
    subscription: "pro",
    contactInfo: { mail: "dueno-real@example.com" },
  };
  t.mock.method(User, "findOne", () => ({ select: async () => user }));

  let downgraded = false;
  t.mock.method(User, "findByIdAndUpdate", async () => {
    downgraded = true;
  });

  let sentTo = null;
  let sentCode = null;
  t.mock.method(mailer, "sendConfirmationCodeEmail", async ({ to, code, action }) => {
    sentTo = to;
    sentCode = code;
    assert.equal(action, "baja");
  });

  const res = createResponse();
  // El atacante conoce el email de contacto público del negocio, no el de la cuenta.
  await getHandler("/baja")({ body: { email: "atacante@example.com" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.requiresConfirmation, true);
  assert.ok(res.body.requestId);
  assert.equal(downgraded, false, "no debe bajar el plan sin confirmar el código");
  assert.equal(sentTo, "dueno-real@example.com", "el código va al email real de la cuenta");
  assert.match(sentCode, /^\d{6}$/);
});

test("POST /baja: busca el username sin importar mayúsculas (cuentas viejas guardadas con mayúsculas)", async (t) => {
  silenceLogs(t);
  let receivedFilter;
  t.mock.method(User, "findOne", (filter) => {
    receivedFilter = filter;
    return { select: async () => null };
  });

  const res = createResponse();
  // Alguien escribe distinto a como podría estar guardado ("MiLocal").
  await getHandler("/baja")({ body: { username: "milocal" } }, res);

  const usernameCondition = receivedFilter.$or.find((c) => "username" in c);
  assert.ok(usernameCondition.username instanceof RegExp, "debe buscar con un patrón case-insensitive");
  assert.equal(usernameCondition.username.flags, "i");
  assert.equal(usernameCondition.username.source, "^milocal$");
});

test("POST /baja: cuenta inexistente o ya en free responde 404 genérico y no manda mail", async (t) => {
  silenceLogs(t);
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => assert.fail("no debe mandar mail"));
  t.mock.method(PendingServiceAction, "create", async () => assert.fail("no debe crear un pedido pendiente"));

  const res = createResponse();
  await getHandler("/baja")({ body: { email: "nadie@example.com" } }, res);

  assert.equal(res.statusCode, 404);
});

test("POST /baja: email de contacto con formato inválido responde 400 y no intenta mandar mail", async (t) => {
  silenceLogs(t);
  const user = {
    _id: "user-1",
    username: "ididi",
    subscription: "basic",
    // Dato real visto en producción: una cuenta con basura en contactInfo.mail
    // (nunca se valida el formato al dar de alta). Antes de este fix, esto
    // llegaba a nodemailer y fallaba con "No recipients defined" (503 confuso).
    contactInfo: { mail: "ididid" },
  };
  t.mock.method(User, "findOne", () => ({ select: async () => user }));
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => assert.fail("no debe intentar mandar mail a un email inválido"));
  t.mock.method(PendingServiceAction, "create", async () => assert.fail("no debe crear un pedido pendiente"));

  const res = createResponse();
  await getHandler("/baja")({ body: { username: "ididi" } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /no es válido/);
});

test("POST /baja/confirmar: código incorrecto no baja el plan y cuenta el intento", async (t) => {
  silenceLogs(t);
  const store = mockPendingServiceAction(t);
  store.doc = {
    _id: "pending-action-1",
    action: "baja",
    userID: "user-1",
    codeHash: "hash-de-otro-codigo",
    attempts: 0,
    consumed: false,
    expiresAt: new Date(Date.now() + 60000),
  };

  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe bajar el plan con código incorrecto"));

  const res = createResponse();
  await getHandler("/baja/confirmar")({ body: { requestId: "pending-action-1", code: "000000" } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(store.doc.attempts, 1);
  assert.equal(store.doc.consumed, false);
});

test("POST /baja/confirmar: reenviar el mismo código dos veces solo ejecuta la baja una vez", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t);

  const user = {
    _id: "user-1",
    username: "milocal",
    subscription: "pro",
    contactInfo: { mail: "dueno-real@example.com" },
  };
  t.mock.method(User, "findOne", () => ({ select: async () => user }));

  let downgrades = 0;
  t.mock.method(User, "findByIdAndUpdate", async () => {
    downgrades += 1;
  });
  t.mock.method(User, "findById", () => ({ select: async () => user }));

  let capturedCode = null;
  t.mock.method(mailer, "sendConfirmationCodeEmail", async ({ code }) => {
    capturedCode = code;
  });

  const solicitarRes = createResponse();
  await getHandler("/baja")({ body: { email: "atacante@example.com" } }, solicitarRes);
  const { requestId } = solicitarRes.body;

  const primeraConfirmacion = createResponse();
  await getHandler("/baja/confirmar")({ body: { requestId, code: capturedCode } }, primeraConfirmacion);
  assert.equal(primeraConfirmacion.statusCode, 200);
  assert.equal(downgrades, 1);

  const segundaConfirmacion = createResponse();
  await getHandler("/baja/confirmar")({ body: { requestId, code: capturedCode } }, segundaConfirmacion);
  assert.equal(segundaConfirmacion.statusCode, 400, "el segundo intento no debe volver a ejecutar la baja");
  assert.equal(downgrades, 1, "la baja solo se ejecuta una vez aunque se reenvíe el mismo código");
});

// ──────────────────────────────────────────────
// Arrepentimiento
// ──────────────────────────────────────────────

test("POST /arrepentimiento: el pedido no reembolsa — manda el código al email real del titular, no al que mandó quien pide", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t);

  const transaction = {
    userID: "user-1",
    paymentID: "1234567890",
    amount: 5000,
    status: "approved",
    paymentApprovedAt: new Date(),
  };
  t.mock.method(PaymentTransaction, "findOne", async () => transaction);
  t.mock.method(User, "findById", () => ({
    select: async () => ({ contactInfo: { mail: "dueno-real@example.com" } }),
  }));

  let refundCalled = false;
  t.mock.method(PaymentRefund.prototype, "create", async () => {
    refundCalled = true;
    return { id: "refund-1" };
  });

  let sentTo = null;
  t.mock.method(mailer, "sendConfirmationCodeEmail", async ({ to, action }) => {
    sentTo = to;
    assert.equal(action, "arrepentimiento");
  });

  const res = createResponse();
  await getHandler("/arrepentimiento")({ body: { orderId: "1234567890", email: "atacante@example.com" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.requiresConfirmation, true);
  assert.equal(refundCalled, false, "no debe reembolsar sin confirmar el código");
  assert.equal(sentTo, "dueno-real@example.com");
});

test("POST /arrepentimiento: fuera del plazo de 10 días no crea pedido de confirmación", async (t) => {
  silenceLogs(t);
  t.mock.method(PaymentTransaction, "findOne", async () => ({
    userID: "user-1",
    paymentID: "1234567890",
    paymentApprovedAt: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000),
  }));
  t.mock.method(PendingServiceAction, "create", async () => assert.fail("no debe crear un pedido pendiente"));
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => assert.fail("no debe mandar mail"));

  const res = createResponse();
  await getHandler("/arrepentimiento")({ body: { orderId: "1234567890" } }, res);

  assert.equal(res.statusCode, 400);
});

test("POST /arrepentimiento: email de contacto del titular con formato inválido responde 400 y no intenta mandar mail", async (t) => {
  silenceLogs(t);
  t.mock.method(PaymentTransaction, "findOne", async () => ({
    userID: "user-1",
    paymentID: "1234567890",
    amount: 5000,
    status: "approved",
    paymentApprovedAt: new Date(),
  }));
  t.mock.method(User, "findById", () => ({
    select: async () => ({ contactInfo: { mail: "ididid" } }),
  }));
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => assert.fail("no debe intentar mandar mail a un email inválido"));
  t.mock.method(PendingServiceAction, "create", async () => assert.fail("no debe crear un pedido pendiente"));

  const res = createResponse();
  await getHandler("/arrepentimiento")({ body: { orderId: "1234567890" } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /no es válido/);
});

test("POST /arrepentimiento/confirmar: reembolsa una sola vez aunque se confirme dos veces", async (t) => {
  silenceLogs(t);
  mockPendingServiceAction(t);

  const transaction = {
    userID: "user-1",
    paymentID: "1234567890",
    amount: 5000,
    status: "approved",
    refunded: false,
    paymentApprovedAt: new Date(),
  };
  // El re-chequeo en confirmar busca refunded:{$ne:true} — una vez que el
  // lock atómico marca refunded:true, esta misma query deja de encontrarla.
  t.mock.method(PaymentTransaction, "findOne", async (filter) => (
    filter.refunded?.$ne === true && !transaction.refunded ? transaction : null
  ));
  t.mock.method(PaymentTransaction, "findOneAndUpdate", async (filter) => {
    if (transaction.refunded) return null; // ya reembolsada: el lock no vuelve a tomarla
    transaction.refunded = true;
    return transaction;
  });
  t.mock.method(PaymentTransaction, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(User, "findById", () => ({
    select: async () => ({ contactInfo: { mail: "dueno-real@example.com" } }),
  }));
  t.mock.method(User, "findByIdAndUpdate", async () => {});

  let refundCalls = 0;
  t.mock.method(PaymentRefund.prototype, "create", async (_body, options) => {
    refundCalls += 1;
    assert.equal(options?.requestOptions?.idempotencyKey, "refund-1234567890");
    return { id: "refund-1" };
  });

  let capturedCode = null;
  t.mock.method(mailer, "sendConfirmationCodeEmail", async ({ code }) => {
    capturedCode = code;
  });

  const solicitarRes = createResponse();
  await getHandler("/arrepentimiento")({ body: { orderId: "1234567890" } }, solicitarRes);
  const { requestId } = solicitarRes.body;

  const primeraConfirmacion = createResponse();
  await getHandler("/arrepentimiento/confirmar")({ body: { requestId, code: capturedCode } }, primeraConfirmacion);
  assert.equal(primeraConfirmacion.statusCode, 200);
  assert.equal(refundCalls, 1);

  const segundaConfirmacion = createResponse();
  await getHandler("/arrepentimiento/confirmar")({ body: { requestId, code: capturedCode } }, segundaConfirmacion);
  assert.equal(segundaConfirmacion.statusCode, 400, "el código ya fue consumido por la primera confirmación");
  assert.equal(refundCalls, 1, "el reembolso en Mercado Pago no debe dispararse dos veces");
});
