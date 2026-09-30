const crypto = require("crypto");

// Secretos del módulo: tokens de los QR (mesa/general), códigos de acceso de
// los operadores y sesiones de sus dispositivos. Todos aleatorios y URL-safe.
const randomToken = (bytes = 18) => crypto.randomBytes(bytes).toString("base64url");

// Lo que se guarda de un secreto que viaja en manos del cliente (código de
// acceso, sesión): nunca el valor, solo su SHA-256.
const hashToken = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const isTokenShape = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);

// Código que se tipea a mano para vincular un dispositivo de un sector (una
// PC no escanea QR): 8 caracteres sin los que se confunden (0/O, 1/I/L), que
// se muestran como "ABCD-EFGH". 31^8 (~8,5 × 10^11) combinaciones, un solo uso, vence en
// minutos y el canje tiene tope de intentos por IP.
const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIRING_LENGTH = 8;

const randomPairingCode = () => {
  let code = "";
  for (let index = 0; index < PAIRING_LENGTH; index += 1) {
    code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
};

// Lo que tipeó la persona → el código canónico (o null si no puede serlo).
// Acepta minúsculas, guiones y espacios.
const normalizePairingCode = (value) => {
  if (typeof value !== "string" || value.length > 40) return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== PAIRING_LENGTH) return null;
  return [...code].every((char) => PAIRING_ALPHABET.includes(char)) ? code : null;
};

const formatPairingCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

module.exports = {
  randomToken, hashToken, isTokenShape, randomPairingCode, normalizePairingCode, formatPairingCode,
};
