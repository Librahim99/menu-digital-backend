const crypto = require("crypto");
const admin = require("firebase-admin");
const User = require("../models/User");
const AdminPushToken = require("../models/AdminPushToken");
const AdminNotification = require("../models/AdminNotification");
const AdminPushPreference = require("../models/AdminPushPreference");

// ──────────────────────────────────────────────
// Notificaciones push (Firebase Cloud Messaging) SOLO para usuarios admin.
// Cada aviso además queda guardado en la bandeja de cada admin
// (AdminNotification), haya o no Firebase configurado.
//
// La push es opcional, igual que Postgres: si falta FIREBASE_SERVICE_ACCOUNT
// la API funciona igual y solo se llena la bandeja. Nunca debe romper el flujo que
// la dispara (registro, webhook de MercadoPago), por eso atrapa sus propios
// errores en vez de propagarlos.
// ──────────────────────────────────────────────

// Códigos con los que FCM indica que el token ya no sirve (app desinstalada,
// permiso revocado, token rotado): esos registros se borran.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

// FCM devuelve "invalid-argument" tanto por un token mal formado como por un
// mensaje inválido (payload muy grande, campo mal armado). Solo el primer
// caso es culpa del token: si se borrara por el código a secas, un aviso
// defectuoso daría de baja a todos los dispositivos de una sola vez.
const isDeadToken = (error) => {
  if (!error) return false;
  if (DEAD_TOKEN_CODES.has(error.code)) return true;
  return error.code === "messaging/invalid-argument"
    && /registration token/i.test(error.message || "");
};

// FCM acepta hasta 500 tokens por sendEachForMulticast.
const MULTICAST_LIMIT = 500;

let messaging = null;
let initialized = false;

const getMessaging = () => {
  if (initialized) return messaging;
  initialized = true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.warn("⚠️  FIREBASE_SERVICE_ACCOUNT no configurada: notificaciones push deshabilitadas.");
    return null;
  }

  try {
    // Acepta el JSON de la cuenta de servicio tal cual o en base64 (más
    // cómodo para pegarlo como variable de entorno en Koyeb).
    const json = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    const app = admin.initializeApp(
      { credential: admin.credential.cert(JSON.parse(json)) },
      "admin-push"
    );
    messaging = admin.messaging(app);
    console.log("✅ Firebase Cloud Messaging listo");
  } catch (error) {
    console.error(`❌ No se pudo inicializar Firebase: ${error.message}`);
    messaging = null;
  }

  return messaging;
};

const isPushEnabled = () => getMessaging() !== null;

// Solo para tests: permite inyectar un cliente de FCM simulado (o volver al
// estado inicial pasando undefined).
const setMessagingForTests = (fake) => {
  messaging = fake ?? null;
  initialized = fake !== undefined;
};

const isDuplicateKeyError = (error) => (
  error?.code === 11000
  || (Array.isArray(error?.writeErrors) && error.writeErrors.length > 0
    && error.writeErrors.every((writeError) => (writeError.code ?? writeError.err?.code) === 11000))
);

// Guarda una copia del aviso en la bandeja de cada admin y devuelve cuántas
// se guardaron (null si no se pudo saber). Atrapa sus errores para que una
// falla de Mongo no impida mandar la push (y viceversa).
const saveToInboxes = async (adminIDs, { eventID, type, title, body, url, dedupeKey }) => {
  try {
    const docs = await AdminNotification.insertMany(
      adminIDs.map((userID) => ({
        userID, eventID, type, title, body, url,
        ...(dedupeKey ? { dedupeKey } : {}),
      })),
      { ordered: false }
    );
    return docs.length;
  } catch (error) {
    // Otro proceso guardó el mismo aviso al mismo tiempo: el índice único
    // rechaza las copias repetidas y solo cuentan las que entraron.
    if (dedupeKey && isDuplicateKeyError(error)) {
      return error.insertedDocs?.length ?? error.result?.insertedCount ?? 0;
    }
    console.error("No se pudo guardar la notificación en la bandeja de los admins:", error);
    return null;
  }
};

// Admins que silenciaron este tipo de aviso: lo ven en la bandeja pero no
// les llega la push. La prueba no se puede silenciar.
const withoutMuted = async (adminIDs, type) => {
  if (type === "test") return adminIDs;
  try {
    const muted = await AdminPushPreference.find({
      userID: { $in: adminIDs },
      mutedTypes: type,
    }).distinct("userID");
    if (muted.length === 0) return adminIDs;
    const mutedSet = new Set(muted.map(String));
    return adminIDs.filter((id) => !mutedSet.has(String(id)));
  } catch (error) {
    // Ante la duda, avisar: es peor perder un aviso que recibir uno de más.
    console.error("No se pudieron leer las preferencias de push de los admins:", error);
    return adminIDs;
  }
};

const sendPush = async (fcm, adminIDs, { eventID, title, body, url }) => {
  const result = { devices: 0, delivered: 0, failed: 0, removed: 0 };
  if (adminIDs.length === 0) return result;

  const tokens = await AdminPushToken.find({ userID: { $in: adminIDs } }).distinct("token");
  result.devices = tokens.length;
  if (tokens.length === 0) return result;

  const deadTokens = [];

  for (let i = 0; i < tokens.length; i += MULTICAST_LIMIT) {
    const batch = tokens.slice(i, i + MULTICAST_LIMIT);
    const response = await fcm.sendEachForMulticast({
      tokens: batch,
      // Mensaje "data-only" a propósito: el service worker del frontend
      // arma la notificación. Si mandáramos también `notification`, el SDK
      // web la mostraría solo y el click no respetaría el link.
      // `url` viaja como ruta relativa: el service worker la resuelve contra
      // su propio origen, así el aviso no depende de FRONTEND_URL.
      // `eventID` le permite al panel marcar el aviso como leído al tocarla.
      data: { title, body, url, eventID },
      webpush: { headers: { Urgency: "high" } },
    });

    response.responses.forEach((sent, index) => {
      if (sent.success) {
        result.delivered += 1;
        return;
      }
      result.failed += 1;
      if (isDeadToken(sent.error)) {
        deadTokens.push(batch[index]);
      } else {
        console.error(`Push a un admin falló (${sent.error?.code || "sin código"}): ${sent.error?.message || ""}`);
      }
    });
  }

  if (deadTokens.length > 0) {
    await AdminPushToken.deleteMany({ token: { $in: deadTokens } });
    result.removed = deadTokens.length;
  }

  return result;
};

/**
 * Avisa a todos los usuarios con admin: true: guarda el aviso en la bandeja
 * de cada uno y, si Firebase está configurado, manda la push a todos sus
 * dispositivos. `url` es la ruta del frontend que se abre al tocarla y
 * `type` agrupa los avisos en la bandeja (ver NOTIFICATION_TYPES).
 *
 * Con `dedupeKey`, el mismo hecho avisa una sola vez aunque el disparador
 * se repita.
 *
 * Nunca lanza. Devuelve un resumen de lo que pasó:
 * { recipients, duplicate, push: { enabled, devices, delivered, failed, removed }, error }
 */
const notifyAdmins = async ({ title, body = "", url = "/admin", type = "other", dedupeKey = null }) => {
  const summary = {
    recipients: 0,
    duplicate: false,
    push: { enabled: false, devices: 0, delivered: 0, failed: 0, removed: 0 },
    error: null,
  };

  try {
    // Se filtra por el flag admin vigente en cada envío: si a alguien le
    // sacan el rol, deja de recibir avisos (bandeja y push) sin tener que
    // limpiar sus tokens a mano.
    const adminIDs = await User.find({ admin: true }).distinct("_id");
    summary.recipients = adminIDs.length;
    if (adminIDs.length === 0) return summary;

    if (dedupeKey && await AdminNotification.exists({ dedupeKey })) {
      summary.duplicate = true;
      return summary;
    }

    const notification = { eventID: crypto.randomUUID(), type, title, body, url, dedupeKey };
    const saved = await saveToInboxes(adminIDs, notification);
    if (dedupeKey && saved === 0) {
      summary.duplicate = true;
      return summary;
    }

    const fcm = getMessaging();
    summary.push.enabled = Boolean(fcm);
    if (fcm) {
      const recipients = await withoutMuted(adminIDs, type);
      Object.assign(summary.push, await sendPush(fcm, recipients, notification));
    }
  } catch (error) {
    console.error("No se pudo enviar la notificación push a los admins:", error);
    summary.error = error.message || "error desconocido";
  }

  return summary;
};

module.exports = { notifyAdmins, isPushEnabled, isDeadToken, setMessagingForTests };
