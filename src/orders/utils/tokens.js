const crypto = require("crypto");

// Secretos del módulo: tokens de los QR (mesa/general), códigos de acceso de
// los mozos y sesiones de sus dispositivos. Todos aleatorios y URL-safe.
const randomToken = (bytes = 18) => crypto.randomBytes(bytes).toString("base64url");

// Lo que se guarda de un secreto que viaja en manos del cliente (código de
// acceso, sesión): nunca el valor, solo su SHA-256.
const hashToken = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const isTokenShape = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);

module.exports = { randomToken, hashToken, isTokenShape };
