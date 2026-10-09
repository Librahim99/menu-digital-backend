// Cliente mínimo de la API de Mercado Pago para el OAuth de los locales.
//
// Se usa fetch directo (Node 20) porque el SDK `mercadopago` que ya usan las
// suscripciones está atado a un access token fijo. Todas las funciones se
// llaman a través de este módulo para poder mockearlas en los tests.
//
// Nunca se loguean cuerpos de respuesta: pueden traer tokens.

const { getConfig } = require("./config");
const { OrdersError } = require("../errors");

const API_BASE = "https://api.mercadopago.com";
const AUTH_BASE = "https://auth.mercadopago.com";
const REQUEST_TIMEOUT_MS = 15000;

// Error de la API de MP: solo status y código; nunca el cuerpo.
class MpApiError extends Error {
  constructor(status, code) {
    super(`Mercado Pago respondió ${status}${code ? ` (${code})` : ""}`);
    this.name = "MpApiError";
    this.status = status;
    this.mpCode = code || null;
  }
}

const postToken = async (body) => {
  let response;
  try {
    response = await fetch(`${API_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OrdersError(502, "No pudimos comunicarnos con Mercado Pago. Intentá de nuevo en unos minutos.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new MpApiError(response.status, typeof data?.error === "string" ? data.error : null);
  if (typeof data?.access_token !== "string" || !data.access_token || data?.user_id == null) {
    throw new MpApiError(502, "invalid_token_response");
  }
  return data;
};

const buildAuthorizationUrl = (state) => {
  const { clientId, redirectUri } = getConfig();
  const url = new URL(`${AUTH_BASE}/authorization`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("platform_id", "mp");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
};

const exchangeCode = (code) => {
  const { clientId, clientSecret, redirectUri } = getConfig();
  return postToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
};

const refreshAccessToken = (refreshToken) => {
  const { clientId, clientSecret } = getConfig();
  return postToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
};

// Crea la preferencia de Checkout Pro EN LA CUENTA del local (con su token).
// Sin marketplace_fee: la plataforma no cobra comisión ni toca el dinero.
const createPreference = async (accessToken, body, idempotencyKey) => {
  let response;
  try {
    response = await fetch(`${API_BASE}/checkout/preferences`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OrdersError(502, "No pudimos comunicarnos con Mercado Pago. Intentá de nuevo en unos minutos.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new MpApiError(response.status, typeof data?.error === "string" ? data.error : null);
  if (typeof data?.id !== "string" || typeof data?.init_point !== "string") {
    throw new MpApiError(502, "invalid_preference_response");
  }
  return { id: data.id, initPoint: data.init_point, sandboxInitPoint: data.sandbox_init_point ?? null };
};

// Pago consultado con el token del local. Fuente de verdad del resultado:
// nunca se confía en el cuerpo de la notificación ni en la URL de retorno.
const getPayment = async (accessToken, paymentId) => {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OrdersError(502, "No pudimos comunicarnos con Mercado Pago.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new MpApiError(response.status, typeof data?.error === "string" ? data.error : null);
  return data;
};

// Devolución total (sin amount) o parcial. La X-Idempotency-Key hace seguro
// reintentar: MP devuelve la misma operación en vez de crear otra.
const createRefund = async (accessToken, paymentId, amount, idempotencyKey) => {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(amount == null ? {} : { amount }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // No se sabe si MP llegó a procesarla: quien llama la deja pendiente.
    throw new MpApiError(0, "network_error");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new MpApiError(response.status, typeof data?.error === "string" ? data.error : null);
  return { id: data?.id == null ? null : String(data.id), amount: Number(data?.amount) || null, status: data?.status ?? null };
};

module.exports = {
  MpApiError, buildAuthorizationUrl, exchangeCode, refreshAccessToken, createPreference, getPayment, createRefund,
};
