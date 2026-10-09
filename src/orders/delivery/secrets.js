// Código de entrega de Delivery: 6 dígitos que recibe el cliente al salir el
// pedido y que el repartidor tipea al entregar.
//
//  · Se genera con crypto.randomInt (CSPRNG), nunca Math.random.
//  · Nunca se guarda en claro: se guarda un HMAC-SHA256 (con clave del servidor y
//    el id del pedido, para que dos pedidos con el mismo código no tengan el mismo
//    hash; el código pertenece al pedido y sobrevive a una reasignación) y una copia cifrada con AES-256-GCM, solo para poder mostrárselo
//    al cliente en su seguimiento.
//  · La clave es DELIVERY_CODE_KEY; si no está, se usa ORDERS_CREDENTIALS_KEY y,
//    en último caso, JWT_SECRET (que la API ya exige para arrancar).
//  · Es distinto del código de vinculación del repartidor (token largo de un solo uso).

const crypto = require("crypto");

const CODE_LENGTH = 6;
const MIN_KEY_LENGTH = 16;
const IV_BYTES = 12;

const readKeyMaterial = () => {
  for (const name of ["DELIVERY_CODE_KEY", "ORDERS_CREDENTIALS_KEY", "JWT_SECRET"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length >= MIN_KEY_LENGTH) return value.trim();
  }
  throw new Error("Falta una clave para el código de entrega (DELIVERY_CODE_KEY, ORDERS_CREDENTIALS_KEY o JWT_SECRET)");
};

const keyFor = (purpose) =>
  crypto.createHmac("sha256", readKeyMaterial()).update(`delivery-code:${purpose}`).digest();

// "000000".."999999", uniforme y con ceros a la izquierda.
const generateCode = () => String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");

// Lo que tipeó la persona → 6 dígitos (o null). Acepta espacios y guiones.
const normalizeCode = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const code = String(value).replace(/[\s-]/g, "");
  return /^\d{6}$/.test(code) ? code : null;
};

const hashCode = (orderId, code) =>
  crypto.createHmac("sha256", keyFor("hash")).update(`${orderId}:${code}`).digest("hex");

// Comparación en tiempo constante.
const codeMatches = (orderId, code, storedHash) => {
  if (typeof storedHash !== "string" || storedHash.length === 0) return false;
  const expected = Buffer.from(hashCode(orderId, code), "hex");
  const actual = Buffer.from(storedHash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

const encryptCode = (orderId, code) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor("encrypt"), iv);
  cipher.setAAD(Buffer.from(String(orderId)));
  const data = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
};

// null si no se puede descifrar (clave rotada, dato corrupto): el cliente no lo
// ve, pero nunca rompe el seguimiento.
const decryptCode = (orderId, packed) => {
  try {
    const parts = typeof packed === "string" ? packed.split(".") : [];
    if (parts.length !== 3) return null;
    const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor("encrypt"), iv);
    decipher.setAAD(Buffer.from(String(orderId)));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
};

module.exports = { CODE_LENGTH, generateCode, normalizeCode, hashCode, codeMatches, encryptCode, decryptCode };
