const admin = require("firebase-admin");
const User = require("../models/User");
const AdminPushToken = require("../models/AdminPushToken");

// ──────────────────────────────────────────────
// Notificaciones push (Firebase Cloud Messaging) SOLO para usuarios admin.
//
// Es opcional, igual que Postgres: si falta FIREBASE_SERVICE_ACCOUNT la API
// funciona igual y notifyAdmins no hace nada. Nunca debe romper el flujo que
// la dispara (registro, webhook de MercadoPago), por eso atrapa sus propios
// errores en vez de propagarlos.
// ──────────────────────────────────────────────

// Códigos con los que FCM indica que el token ya no sirve (app desinstalada,
// permiso revocado, token rotado): esos registros se borran.
const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

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

/**
 * Manda una notificación a todos los dispositivos registrados de usuarios
 * con admin: true. `url` es la ruta del frontend que se abre al tocarla.
 */
const notifyAdmins = async ({ title, body, url = "/admin" }) => {
  try {
    const fcm = getMessaging();
    if (!fcm) return;

    // Se filtra por el flag admin vigente en cada envío: si a alguien le
    // sacan el rol, sus tokens viejos dejan de recibir sin tener que
    // limpiarlos a mano.
    const adminIDs = await User.find({ admin: true }).distinct("_id");
    if (adminIDs.length === 0) return;

    const tokens = await AdminPushToken.find({ userID: { $in: adminIDs } }).distinct("token");
    if (tokens.length === 0) return;

    const link = new URL(url, process.env.FRONTEND_URL).toString();
    const invalidTokens = [];

    for (let i = 0; i < tokens.length; i += MULTICAST_LIMIT) {
      const batch = tokens.slice(i, i + MULTICAST_LIMIT);
      const response = await fcm.sendEachForMulticast({
        tokens: batch,
        // Mensaje "data-only" a propósito: el service worker del frontend
        // arma la notificación. Si mandáramos también `notification`, el SDK
        // web la mostraría solo y el click no respetaría el link.
        data: { title, body, url: link },
        webpush: { headers: { Urgency: "high" } },
      });

      response.responses.forEach((result, index) => {
        if (!result.success && INVALID_TOKEN_CODES.has(result.error?.code)) {
          invalidTokens.push(batch[index]);
        }
      });
    }

    if (invalidTokens.length > 0) {
      await AdminPushToken.deleteMany({ token: { $in: invalidTokens } });
    }
  } catch (error) {
    console.error("No se pudo enviar la notificación push a los admins:", error);
  }
};

module.exports = { notifyAdmins, isPushEnabled };
