const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const MIN_SECRET_LENGTH = 32;

const getKey = () => {
  const secret = process.env.PENDING_REGISTRATION_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `PENDING_REGISTRATION_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres`
    );
  }
  return crypto.createHash("sha256").update(secret, "utf8").digest();
};

const encryptPendingPassword = (password) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);

  return {
    passwordCiphertext: encrypted.toString("base64"),
    passwordIV: iv.toString("base64"),
    passwordAuthTag: cipher.getAuthTag().toString("base64"),
  };
};

const decryptPendingPassword = (pending) => {
  // Compatibilidad temporal con altas creadas antes de incorporar cifrado.
  if (typeof pending?.password === "string" && pending.password) {
    return pending.password;
  }

  if (
    typeof pending?.passwordCiphertext !== "string" ||
    typeof pending?.passwordIV !== "string" ||
    typeof pending?.passwordAuthTag !== "string"
  ) {
    throw new Error("El registro pendiente no contiene credenciales recuperables");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(pending.passwordIV, "base64")
  );
  decipher.setAuthTag(Buffer.from(pending.passwordAuthTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(pending.passwordCiphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
};

module.exports = { decryptPendingPassword, encryptPendingPassword };
