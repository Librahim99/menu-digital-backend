// Cifrado de las credenciales de MP de cada local (AES-256-GCM).
//
// Clave propia (ORDERS_CREDENTIALS_KEY): no se reutiliza ningún otro secreto de
// la plataforma. Formato guardado: "iv.authTag.ciphertext", todo en base64.
// Si se rota la clave, las conexiones existentes dejan de descifrar y los
// locales tienen que volver a conectar su cuenta.

const crypto = require("crypto");
const { getConfig, MIN_KEY_LENGTH } = require("./config");

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

const getKey = () => {
  const { credentialsKey } = getConfig();
  if (credentialsKey.length < MIN_KEY_LENGTH) {
    throw new Error(`ORDERS_CREDENTIALS_KEY debe tener al menos ${MIN_KEY_LENGTH} caracteres`);
  }
  return crypto.createHash("sha256").update(credentialsKey, "utf8").digest();
};

const encryptSecret = (plain) => {
  if (typeof plain !== "string" || !plain) throw new Error("No hay nada para cifrar");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
};

const decryptSecret = (packed) => {
  const parts = typeof packed === "string" ? packed.split(".") : [];
  if (parts.length !== 3) throw new Error("Credencial cifrada con formato inválido");
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};

module.exports = { encryptSecret, decryptSecret };
