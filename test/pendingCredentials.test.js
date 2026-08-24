const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decryptPendingPassword,
  encryptPendingPassword,
} = require("../src/utils/pendingCredentials");

const withSecret = (t) => {
  const previous = process.env.PENDING_REGISTRATION_SECRET;
  process.env.PENDING_REGISTRATION_SECRET = "secret-de-prueba-con-mas-de-32-caracteres";
  t.after(() => {
    if (previous === undefined) delete process.env.PENDING_REGISTRATION_SECRET;
    else process.env.PENDING_REGISTRATION_SECRET = previous;
  });
};

test("cifra y recupera una contraseña temporal sin guardarla legible", (t) => {
  withSecret(t);
  const encrypted = encryptPendingPassword("password-seguro");

  assert.equal(JSON.stringify(encrypted).includes("password-seguro"), false);
  assert.equal(decryptPendingPassword(encrypted), "password-seguro");
});

test("rechaza credenciales temporales manipuladas", (t) => {
  withSecret(t);
  const encrypted = encryptPendingPassword("password-seguro");
  const tampered = {
    ...encrypted,
    passwordCiphertext: `${encrypted.passwordCiphertext.slice(0, -2)}AA`,
  };

  assert.throws(() => decryptPendingPassword(tampered));
});

test("mantiene compatibilidad con registros legacy todavía pendientes", () => {
  assert.equal(
    decryptPendingPassword({ password: "password-legacy" }),
    "password-legacy"
  );
});

test("rechaza crear altas cifradas sin un secreto suficientemente largo", (t) => {
  const previous = process.env.PENDING_REGISTRATION_SECRET;
  delete process.env.PENDING_REGISTRATION_SECRET;
  t.after(() => {
    if (previous !== undefined) process.env.PENDING_REGISTRATION_SECRET = previous;
  });

  assert.throws(
    () => encryptPendingPassword("password-seguro"),
    /PENDING_REGISTRATION_SECRET/
  );
});
