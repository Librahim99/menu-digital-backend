// Configuración de los pagos de pedidos con Mercado Pago (OAuth por local).
//
// Es una aplicación de MP APARTE de la que cobra las suscripciones: tiene su
// propio client_id / client_secret y su propia clave de cifrado. Ninguna de
// estas variables es obligatoria para levantar la API: si faltan, solo el
// módulo de pagos de pedidos responde "no disponible".

const MIN_KEY_LENGTH = 32;

const read = (name) => {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
};

const getConfig = () => ({
  clientId: read("MP_ORDERS_CLIENT_ID"),
  clientSecret: read("MP_ORDERS_CLIENT_SECRET"),
  // URL del backend registrada en "URLs de redireccionamiento" de la app de MP:
  // https://<backend>/api/orders/payments/oauth/callback
  redirectUri: read("MP_ORDERS_REDIRECT_URI"),
  // Webhook propio de pedidos: https://<backend>/api/orders/payments/webhook
  webhookUrl: read("MP_ORDERS_WEBHOOK_URL"),
  webhookSecret: read("MP_ORDERS_WEBHOOK_SECRET"),
  credentialsKey: read("ORDERS_CREDENTIALS_KEY"),
  frontendUrl: read("FRONTEND_URL").replace(/\/$/, ""),
});

// Qué falta para poder conectar cuentas (sin exponer valores).
const missingForOAuth = (config = getConfig()) => {
  const missing = [];
  if (!config.clientId) missing.push("MP_ORDERS_CLIENT_ID");
  if (!config.clientSecret) missing.push("MP_ORDERS_CLIENT_SECRET");
  if (!config.redirectUri) missing.push("MP_ORDERS_REDIRECT_URI");
  if (config.credentialsKey.length < MIN_KEY_LENGTH) missing.push("ORDERS_CREDENTIALS_KEY");
  return missing;
};

// Además de lo anterior, para cobrar hace falta recibir las notificaciones.
const missingForCheckout = (config = getConfig()) => {
  const missing = missingForOAuth(config);
  if (!config.webhookUrl) missing.push("MP_ORDERS_WEBHOOK_URL");
  if (!config.webhookSecret) missing.push("MP_ORDERS_WEBHOOK_SECRET");
  return missing;
};

module.exports = { MIN_KEY_LENGTH, getConfig, missingForOAuth, missingForCheckout };
