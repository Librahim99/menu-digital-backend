const REQUIRED_ENV_VARS = Object.freeze([
  "NODE_ENV",
  "MONGODB_URI",
  "JWT_SECRET",
  "PENDING_REGISTRATION_SECRET",
  "ACCEPTED_TERMS_VERSION",
  "FRONTEND_URL",
  "MP_ENV",
  "MP_ACCESS_TOKEN",
  "MP_WEBHOOK_URL",
  "MP_WEBHOOK_SECRET",
]);

const VALID_NODE_ENVIRONMENTS = new Set(["development", "test", "production"]);
const VALID_MP_ENVIRONMENTS = new Set(["test", "production"]);

const isNonEmptyString = (value) => (
  typeof value === "string" && value.trim().length > 0
);

const parseUrl = (name, value, errors) => {
  try {
    return new URL(value);
  } catch {
    errors.push(`${name} debe ser una URL absoluta válida`);
    return null;
  }
};

const getExpectedPaymentLiveMode = (env = process.env) => {
  if (env.MP_ENV === "production") return true;
  if (env.MP_ENV === "test") return false;
  throw new Error("MP_ENV debe ser 'test' o 'production'");
};

const validateEnvironment = (env = process.env) => {
  const errors = [];

  REQUIRED_ENV_VARS.forEach((name) => {
    if (!isNonEmptyString(env[name])) {
      errors.push(`${name} es obligatoria`);
    }
  });

  if (
    isNonEmptyString(env.NODE_ENV)
    && !VALID_NODE_ENVIRONMENTS.has(env.NODE_ENV)
  ) {
    errors.push("NODE_ENV debe ser 'development', 'test' o 'production'");
  }

  if (
    isNonEmptyString(env.MP_ENV)
    && !VALID_MP_ENVIRONMENTS.has(env.MP_ENV)
  ) {
    errors.push("MP_ENV debe ser 'test' o 'production'");
  }

  if (
    VALID_NODE_ENVIRONMENTS.has(env.NODE_ENV)
    && VALID_MP_ENVIRONMENTS.has(env.MP_ENV)
    && (env.NODE_ENV === "production") !== (env.MP_ENV === "production")
  ) {
    errors.push("NODE_ENV y MP_ENV deben apuntar al mismo ambiente de producción");
  }

  if (
    isNonEmptyString(env.MONGODB_URI)
    && !/^mongodb(?:\+srv)?:\/\//.test(env.MONGODB_URI)
  ) {
    errors.push("MONGODB_URI debe comenzar con mongodb:// o mongodb+srv://");
  }

  if (isNonEmptyString(env.JWT_SECRET) && env.JWT_SECRET.length < 32) {
    errors.push("JWT_SECRET debe tener al menos 32 caracteres");
  }

  if (
    isNonEmptyString(env.PENDING_REGISTRATION_SECRET)
    && env.PENDING_REGISTRATION_SECRET.length < 32
  ) {
    errors.push("PENDING_REGISTRATION_SECRET debe tener al menos 32 caracteres");
  }

  const frontendUrl = isNonEmptyString(env.FRONTEND_URL)
    ? parseUrl("FRONTEND_URL", env.FRONTEND_URL, errors)
    : null;
  const webhookUrl = isNonEmptyString(env.MP_WEBHOOK_URL)
    ? parseUrl("MP_WEBHOOK_URL", env.MP_WEBHOOK_URL, errors)
    : null;

  if (env.NODE_ENV === "production") {
    if (frontendUrl && frontendUrl.protocol !== "https:") {
      errors.push("FRONTEND_URL debe usar HTTPS en producción");
    }
    if (webhookUrl && webhookUrl.protocol !== "https:") {
      errors.push("MP_WEBHOOK_URL debe usar HTTPS en producción");
    }
  }

  if (
    webhookUrl
    && webhookUrl.pathname.replace(/\/$/, "") !== "/api/payments/webhook"
  ) {
    errors.push("MP_WEBHOOK_URL debe apuntar a /api/payments/webhook");
  }

  if (errors.length > 0) {
    throw new Error(`Configuración de entorno inválida:\n- ${errors.join("\n- ")}`);
  }

  return Object.freeze({
    nodeEnvironment: env.NODE_ENV,
    paymentEnvironment: env.MP_ENV,
    expectedPaymentLiveMode: getExpectedPaymentLiveMode(env),
  });
};

module.exports = {
  REQUIRED_ENV_VARS,
  getExpectedPaymentLiveMode,
  validateEnvironment,
};
