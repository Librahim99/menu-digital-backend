const { OrdersError, route } = require("../errors");
const connections = require("./connectionService");

const ownerIdOf = (req) => String(req.user._id);

// Estado de la conexión (sin tokens).
const getConnection = route(async (req, res) => {
  res.json(await connections.getStatus(ownerIdOf(req)));
});

// Devuelve la URL de Mercado Pago; el frontend navega ahí (no se puede
// redirigir directo porque este endpoint requiere el JWT en un header).
const startConnection = route(async (req, res) => {
  res.json(await connections.startConnection(ownerIdOf(req)));
});

const disconnect = route(async (req, res) => {
  res.json(await connections.disconnect(ownerIdOf(req)));
});

const OUTCOME_BY_CODE = {
  MP_ACCOUNT_IN_USE: "in_use",
  MP_OAUTH_STATE_INVALID: "invalid",
  MP_OAUTH_INVALID: "invalid",
  MP_NOT_CONFIGURED: "unavailable",
};

// Vuelta desde Mercado Pago (pública: no hay JWT en una redirección del
// navegador). Quién es el local lo dice el `state`, nunca la URL. Siempre
// termina redirigiendo al panel con un resultado.
const oauthCallback = async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(connections.frontendRedirect("denied"));

  try {
    await connections.completeConnection({
      code: typeof code === "string" ? code : "",
      state: typeof state === "string" ? state : "",
    });
    return res.redirect(connections.frontendRedirect("connected"));
  } catch (err) {
    if (!(err instanceof OrdersError)) console.error("[orders/payments] callback OAuth:", err?.message);
    return res.redirect(connections.frontendRedirect(OUTCOME_BY_CODE[err?.code] || "error"));
  }
};

module.exports = { getConnection, startConnection, disconnect, oauthCallback };
