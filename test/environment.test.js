const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getExpectedPaymentLiveMode,
  validateEnvironment,
} = require("../src/config/environment");

const validEnvironment = (overrides = {}) => ({
  NODE_ENV: "production",
  MONGODB_URI: "mongodb+srv://user:password@example.mongodb.net/menu-digital",
  JWT_SECRET: "jwt-secret-de-prueba-con-mas-de-32-caracteres",
  PENDING_REGISTRATION_SECRET: "pending-secret-de-prueba-con-mas-de-32-caracteres",
  ACCEPTED_TERMS_VERSION: "2026-08",
  FRONTEND_URL: "https://menudigitalapp.com.ar",
  MP_ENV: "production",
  MP_ACCESS_TOKEN: "access-token-productivo-de-prueba",
  MP_WEBHOOK_URL: "https://api.menudigitalapp.com.ar/api/payments/webhook",
  MP_WEBHOOK_SECRET: "webhook-secret-de-prueba",
  ...overrides,
});

test("la configuración productiva válida exige pagos live", () => {
  const result = validateEnvironment(validEnvironment());

  assert.equal(result.nodeEnvironment, "production");
  assert.equal(result.paymentEnvironment, "production");
  assert.equal(result.expectedPaymentLiveMode, true);
});

test("la configuración de desarrollo válida exige pagos de prueba", () => {
  const env = validEnvironment({
    NODE_ENV: "development",
    MP_ENV: "test",
    FRONTEND_URL: "http://localhost:5173",
  });

  assert.equal(validateEnvironment(env).expectedPaymentLiveMode, false);
  assert.equal(getExpectedPaymentLiveMode(env), false);
});

test("la aplicación no inicia sin el secreto del webhook", () => {
  assert.throws(
    () => validateEnvironment(validEnvironment({ MP_WEBHOOK_SECRET: "" })),
    /MP_WEBHOOK_SECRET es obligatoria/
  );
});

test("NODE_ENV productivo no acepta Mercado Pago en modo test", () => {
  assert.throws(
    () => validateEnvironment(validEnvironment({ MP_ENV: "test" })),
    /NODE_ENV y MP_ENV deben apuntar al mismo ambiente de producción/
  );
});

test("las URLs de producción deben usar HTTPS y el webhook correcto", () => {
  assert.throws(
    () => validateEnvironment(validEnvironment({
      FRONTEND_URL: "http://menudigitalapp.com.ar",
      MP_WEBHOOK_URL: "http://api.example.com/webhook",
    })),
    /FRONTEND_URL debe usar HTTPS en producción[\s\S]*MP_WEBHOOK_URL debe usar HTTPS[\s\S]*MP_WEBHOOK_URL debe apuntar a \/api\/payments\/webhook/
  );
});
