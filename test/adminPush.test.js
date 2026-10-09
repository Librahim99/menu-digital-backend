const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const User = require("../src/models/User");
const AdminNotification = require("../src/models/AdminNotification");
const AdminPushToken = require("../src/models/AdminPushToken");
const AdminPushPreference = require("../src/models/AdminPushPreference");
const {
  notifyAdmins,
  isDeadToken,
  setMessagingForTests,
} = require("../src/services/adminPushService");
const {
  listDevices,
  removeDevice,
  updatePreferences,
  sendTestNotification,
} = require("../src/controllers/adminPushController");
const { buildSubscriptionNotices } = require("../src/services/adminSubscriptionNotices");

const ADMIN_A = "64f000000000000000000001";
const ADMIN_B = "64f000000000000000000002";
const DEVICE_ID = "64f000000000000000000201";

function response() {
  return {
    statusCode: 200,
    body: null,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

// Deja listo el escenario de un envío: admins, tokens por admin, quién
// silenció qué y un FCM simulado que responde según `results` (por token).
function setupSend(t, { tokensByAdmin, muted = {}, results = {}, existing = false }) {
  const sent = [];
  const state = { inserted: null, deletedTokens: null, tokenFilter: null };

  t.mock.method(User, "find", () => ({ distinct: async () => Object.keys(tokensByAdmin) }));
  t.mock.method(AdminNotification, "exists", async () => (existing ? { _id: "x" } : null));
  t.mock.method(AdminNotification, "insertMany", async (docs) => {
    state.inserted = docs;
    return docs;
  });
  t.mock.method(AdminPushPreference, "find", (filter) => ({
    distinct: async () => filter.userID.$in.filter((id) => (muted[id] || []).includes(filter.mutedTypes)),
  }));
  t.mock.method(AdminPushToken, "find", (filter) => {
    state.tokenFilter = filter;
    return { distinct: async () => filter.userID.$in.flatMap((id) => tokensByAdmin[id] || []) };
  });
  t.mock.method(AdminPushToken, "deleteMany", async (filter) => {
    state.deletedTokens = filter.token.$in;
    return { deletedCount: filter.token.$in.length };
  });
  t.mock.method(console, "error", () => {});

  setMessagingForTests({
    sendEachForMulticast: async (message) => {
      sent.push(message);
      return {
        responses: message.tokens.map((token) => (
          results[token] ? { success: false, error: results[token] } : { success: true }
        )),
      };
    },
  });
  t.after(() => setMessagingForTests(undefined));

  return { sent, state };
}

test("isDeadToken no confunde un mensaje inválido con un token muerto", () => {
  assert.equal(isDeadToken({ code: "messaging/registration-token-not-registered" }), true);
  assert.equal(isDeadToken({ code: "messaging/invalid-registration-token" }), true);
  assert.equal(isDeadToken({
    code: "messaging/invalid-argument",
    message: "The registration token is not a valid FCM registration token",
  }), true);
  assert.equal(isDeadToken({
    code: "messaging/invalid-argument",
    message: "Android message is too big",
  }), false);
  assert.equal(isDeadToken({ code: "messaging/internal-error" }), false);
  assert.equal(isDeadToken(undefined), false);
});

test("notifyAdmins manda la push con la ruta relativa y resume el resultado", async (t) => {
  const { sent, state } = setupSend(t, {
    tokensByAdmin: { [ADMIN_A]: ["tok-a1", "tok-a2"], [ADMIN_B]: ["tok-b1"] },
    results: {
      "tok-a2": { code: "messaging/registration-token-not-registered" },
      "tok-b1": { code: "messaging/invalid-argument", message: "Android message is too big" },
    },
  });

  const summary = await notifyAdmins({
    title: "💰 Pago aprobado",
    body: "cliente · pro",
    url: "/admin/payments",
    type: "payment",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tokens, ["tok-a1", "tok-a2", "tok-b1"]);
  // Sin FRONTEND_URL de por medio: el service worker resuelve la ruta.
  assert.equal(sent[0].data.url, "/admin/payments");
  assert.equal(sent[0].data.eventID, state.inserted[0].eventID);
  assert.equal(sent[0].notification, undefined);

  assert.equal(summary.recipients, 2);
  assert.deepEqual(summary.push, { enabled: true, devices: 3, delivered: 1, failed: 2, removed: 1 });
  // Solo se borra el token muerto: el otro falló por culpa del mensaje.
  assert.deepEqual(state.deletedTokens, ["tok-a2"]);
});

test("notifyAdmins no le manda push al admin que silenció ese tipo, pero sí le guarda el aviso", async (t) => {
  const { sent, state } = setupSend(t, {
    tokensByAdmin: { [ADMIN_A]: ["tok-a1"], [ADMIN_B]: ["tok-b1"] },
    muted: { [ADMIN_B]: ["registration"] },
  });

  const summary = await notifyAdmins({ title: "🆕 Nuevo registro", type: "registration" });

  assert.equal(state.inserted.length, 2);
  assert.deepEqual(state.tokenFilter.userID.$in, [ADMIN_A]);
  assert.deepEqual(sent[0].tokens, ["tok-a1"]);
  assert.equal(summary.push.delivered, 1);
});

test("la notificación de prueba ignora los tipos silenciados", async (t) => {
  const { sent } = setupSend(t, {
    tokensByAdmin: { [ADMIN_A]: ["tok-a1"] },
    muted: { [ADMIN_A]: ["test"] },
  });
  t.mock.method(AdminPushPreference, "find", () => {
    throw new Error("La prueba no debe consultar preferencias");
  });

  await notifyAdmins({ title: "🔔 Prueba", type: "test" });

  assert.deepEqual(sent[0].tokens, ["tok-a1"]);
});

test("notifyAdmins con dedupeKey no repite un aviso que ya existe", async (t) => {
  const { sent, state } = setupSend(t, {
    tokensByAdmin: { [ADMIN_A]: ["tok-a1"] },
    existing: true,
  });

  const summary = await notifyAdmins({ title: "↩️ Pago reembolsado", type: "refund", dedupeKey: "refund:123" });

  assert.equal(summary.duplicate, true);
  assert.equal(state.inserted, null);
  assert.equal(sent.length, 0);
});

test("notifyAdmins con dedupeKey no manda push si otro proceso ganó la carrera", async (t) => {
  const { sent } = setupSend(t, { tokensByAdmin: { [ADMIN_A]: ["tok-a1"] } });
  t.mock.method(AdminNotification, "insertMany", async () => {
    const error = new Error("E11000 duplicate key");
    error.writeErrors = [{ code: 11000 }];
    error.insertedDocs = [];
    throw error;
  });

  const summary = await notifyAdmins({ title: "↩️ Pago reembolsado", type: "refund", dedupeKey: "refund:123" });

  assert.equal(summary.duplicate, true);
  assert.equal(sent.length, 0);
});

test("notifyAdmins nunca lanza: devuelve el error en el resumen", async (t) => {
  t.mock.method(User, "find", () => {
    throw new Error("Mongo caído");
  });
  t.mock.method(console, "error", () => {});

  const summary = await notifyAdmins({ title: "x" });

  assert.equal(summary.error, "Mongo caído");
});

test("sendTestNotification devuelve a cuántos dispositivos llegó", async (t) => {
  setupSend(t, {
    tokensByAdmin: { [ADMIN_A]: ["tok-a1", "tok-a2"] },
    results: { "tok-a2": { code: "messaging/registration-token-not-registered" } },
  });
  const res = response();

  await sendTestNotification({ user: { _id: ADMIN_A, username: "ceo" } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { devices: 2, delivered: 1, failed: 1, removed: 1 });
});

test("sendTestNotification responde 503 si el servidor no tiene Firebase", async (t) => {
  setMessagingForTests(null);
  t.after(() => setMessagingForTests(undefined));
  const res = response();

  await sendTestNotification({ user: { _id: ADMIN_A, username: "ceo" } }, res);

  assert.equal(res.statusCode, 503);
});

test("listDevices devuelve solo los dispositivos propios, con huella y sin el token", async (t) => {
  let filter;
  t.mock.method(AdminPushToken, "find", (value) => {
    filter = value;
    return {
      sort: () => ({
        lean: async () => [{
          _id: DEVICE_ID,
          token: "token-secreto-del-navegador",
          userAgent: "Mozilla/5.0 (iPhone)",
          createdAt: new Date("2026-10-01T12:00:00.000Z"),
          lastSeenAt: new Date("2026-10-08T12:00:00.000Z"),
        }],
      }),
    };
  });
  const res = response();

  await listDevices({ user: { _id: ADMIN_A } }, res);

  assert.deepEqual(filter, { userID: ADMIN_A });
  assert.equal(res.body.devices.length, 1);
  const [device] = res.body.devices;
  assert.equal(device.id, DEVICE_ID);
  assert.equal(device.token, undefined);
  assert.equal(
    device.fingerprint,
    crypto.createHash("sha256").update("token-secreto-del-navegador").digest("hex")
  );
});

test("removeDevice solo borra dispositivos del admin logueado", async (t) => {
  let filter;
  t.mock.method(AdminPushToken, "deleteOne", async (value) => {
    filter = value;
    return { deletedCount: 0 };
  });

  const missing = response();
  await removeDevice({ user: { _id: ADMIN_A }, params: { id: DEVICE_ID } }, missing);
  assert.deepEqual(filter, { _id: DEVICE_ID, userID: ADMIN_A });
  assert.equal(missing.statusCode, 404);

  const invalid = response();
  await removeDevice({ user: { _id: ADMIN_A }, params: { id: "no-es-un-id" } }, invalid);
  assert.equal(invalid.statusCode, 404);
});

test("updatePreferences valida los tipos y guarda sin repetidos", async (t) => {
  let update;
  t.mock.method(AdminPushPreference, "findOneAndUpdate", async (filter, value) => {
    update = { filter, value };
    return null;
  });

  const invalid = response();
  await updatePreferences({ user: { _id: ADMIN_A }, body: { mutedTypes: ["test"] } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(update, undefined);

  const ok = response();
  await updatePreferences(
    { user: { _id: ADMIN_A }, body: { mutedTypes: ["registration", "registration", "refund"] } },
    ok
  );
  assert.deepEqual(update.filter, { userID: ADMIN_A });
  assert.deepEqual(update.value, { $set: { mutedTypes: ["registration", "refund"] } });
  assert.deepEqual(ok.body.mutedTypes, ["registration", "refund"]);
});

test("buildSubscriptionNotices avisa por vencer, vencido y prueba terminada", () => {
  const now = new Date("2026-10-09T15:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;
  const at = (offsetDays) => new Date(now.getTime() + offsetDays * day);

  const notices = buildSubscriptionNotices([
    { _id: "u1", username: "porvencer", subscription: "pro", subscriptionExpiresAt: at(2) },
    { _id: "u2", username: "vencido", subscription: "basic", subscriptionExpiresAt: at(-1) },
    { _id: "u3", username: "pruebaterminada", subscription: "pro", subscriptionExpiresAt: at(-1), trialActive: true },
    // No avisan: prueba todavía vigente, vencimiento lejano, vencido hace mucho, plan gratis.
    { _id: "u4", username: "pruebavigente", subscription: "pro", subscriptionExpiresAt: at(2), trialActive: true },
    { _id: "u5", username: "lejano", subscription: "pro", subscriptionExpiresAt: at(10) },
    { _id: "u6", username: "viejo", subscription: "pro", subscriptionExpiresAt: at(-10) },
    { _id: "u7", username: "gratis", subscription: "free", subscriptionExpiresAt: null },
  ], now);

  assert.deepEqual(notices.map((notice) => notice.dedupeKey.split(":")[0]), [
    "expiring",
    "expired",
    "trial-ended",
  ]);
  assert.ok(notices.every((notice) => notice.type === "subscription"));
  assert.match(notices[0].title, /Pro por vencer/);
  assert.match(notices[1].title, /Básico vencido/);
  assert.match(notices[0].body, /porvencer/);

  // La clave incluye la fecha: si la cuenta renueva, el próximo vencimiento avisa de nuevo.
  const renewed = buildSubscriptionNotices([
    { _id: "u1", username: "porvencer", subscription: "pro", subscriptionExpiresAt: at(2.5) },
  ], now);
  assert.notEqual(renewed[0].dedupeKey, notices[0].dedupeKey);
});
