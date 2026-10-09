// Conexión de la cuenta de Mercado Pago de cada local (OAuth).
//
// El local autoriza SU cuenta: el dinero de los pedidos se acredita ahí y la
// plataforma no cobra comisión ni administra fondos. Los tokens se guardan
// cifrados y nunca salen de este módulo hacia el frontend.

const crypto = require("crypto");
const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { getConfig, missingForOAuth } = require("./config");
const { encryptSecret, decryptSecret } = require("./crypto");
const mpApi = require("./mpApi");

const STATE_TTL_MS = 10 * 60 * 1000;
// El access token dura 180 días: se renueva con tiempo de sobra.
const REFRESH_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const UNIQUE_VIOLATION = "23505";

const hashState = (state) => crypto.createHash("sha256").update(state, "utf8").digest("hex");

const requireOAuthConfigured = () => {
  if (missingForOAuth().length > 0) {
    // El detalle de qué falta queda para quien administra, en el log.
    console.error(`[orders/payments] Falta configurar: ${missingForOAuth().join(", ")}`);
    throw new OrdersError(503, "Los pagos con Mercado Pago todavía no están disponibles.", "MP_NOT_CONFIGURED");
  }
};

const tokenExpiry = (data) => {
  const seconds = Number(data.expires_in);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TOKEN_TTL_MS;
  return new Date(Date.now() + ms);
};

const toStatusDTO = (row) => {
  const configured = missingForOAuth().length === 0;
  if (!row) return { configured, connected: false, status: "disconnected" };
  return {
    configured,
    connected: row.status === "active",
    status: row.status,
    mpUserId: row.mp_user_id,
    liveMode: row.live_mode,
    connectedAt: row.connected_at,
    tokenExpiresAt: row.token_expires_at,
    lastError: row.last_error,
  };
};

const findLiveConnection = async (ownerId) => {
  const { rows } = await query(
    `SELECT * FROM order_mp_connections
      WHERE owner_id = $1 AND status IN ('active', 'error')`,
    [ownerId],
  );
  return rows[0] || null;
};

const getStatus = async (ownerId) => toStatusDTO(await findLiveConnection(ownerId));

// Paso 1: devuelve la URL de Mercado Pago a la que hay que mandar al dueño.
const startConnection = async (ownerId) => {
  requireOAuthConfigured();
  const state = crypto.randomBytes(32).toString("hex");
  await query(
    `INSERT INTO order_mp_oauth_states (state_hash, owner_id, expires_at)
     VALUES ($1, $2, $3)`,
    [hashState(state), ownerId, new Date(Date.now() + STATE_TTL_MS)],
  );
  return { url: mpApi.buildAuthorizationUrl(state) };
};

// Paso 2 (callback de MP): el `state` identifica al local; nunca se confía en
// un id que venga en la URL. Devuelve el ownerId al que quedó asociada la cuenta.
const completeConnection = async ({ code, state }) => {
  requireOAuthConfigured();
  if (typeof code !== "string" || !code || typeof state !== "string" || !state) {
    throw new OrdersError(400, "La autorización de Mercado Pago es inválida.", "MP_OAUTH_INVALID");
  }

  // Un solo uso, atómico: un callback repetido no vuelve a entrar.
  const { rows } = await query(
    `UPDATE order_mp_oauth_states SET used_at = now()
      WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING owner_id`,
    [hashState(state)],
  );
  if (rows.length === 0) {
    throw new OrdersError(400, "La autorización venció o ya se usó. Volvé a conectar.", "MP_OAUTH_STATE_INVALID");
  }
  const ownerId = rows[0].owner_id;

  const tokens = await mpApi.exchangeCode(code);
  const mpUserId = String(tokens.user_id);

  try {
    await withTransaction(async (client) => {
      const taken = await client.query(
        `SELECT 1 FROM order_mp_connections
          WHERE mp_user_id = $1 AND owner_id <> $2 AND status IN ('active', 'error')`,
        [mpUserId, ownerId],
      );
      if (taken.rows.length > 0) {
        throw new OrdersError(409, "Esa cuenta de Mercado Pago ya está conectada a otro local.", "MP_ACCOUNT_IN_USE");
      }

      // Reconectar reemplaza la conexión anterior del local.
      await client.query(
        `UPDATE order_mp_connections
            SET status = 'disconnected', disconnected_at = now(), updated_at = now(),
                access_token_enc = '', refresh_token_enc = NULL
          WHERE owner_id = $1 AND status IN ('active', 'error')`,
        [ownerId],
      );
      await client.query(
        `INSERT INTO order_mp_connections
           (owner_id, mp_user_id, access_token_enc, refresh_token_enc, scope, live_mode, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ownerId,
          mpUserId,
          encryptSecret(tokens.access_token),
          tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
          typeof tokens.scope === "string" ? tokens.scope : null,
          tokens.live_mode !== false,
          tokenExpiry(tokens),
        ],
      );
    });
  } catch (error) {
    if (error?.code === UNIQUE_VIOLATION) {
      throw new OrdersError(409, "Esa cuenta de Mercado Pago ya está conectada a otro local.", "MP_ACCOUNT_IN_USE");
    }
    throw error;
  }

  return { ownerId };
};

// Baja lógica: se borran los tokens (ya no se puede operar con la cuenta) pero
// queda el registro de que existió, porque los pagos lo referencian.
const disconnect = async (ownerId) => {
  const { rowCount } = await query(
    `UPDATE order_mp_connections
        SET status = 'disconnected', disconnected_at = now(), updated_at = now(),
            access_token_enc = '', refresh_token_enc = NULL
      WHERE owner_id = $1 AND status IN ('active', 'error')`,
    [ownerId],
  );
  return { disconnected: rowCount > 0 };
};

// Access token vigente del local para operar en su nombre (crear checkouts,
// consultar pagos, devolver). Renueva si está por vencer; el refresh token
// rota en cada renovación, por eso la fila se bloquea mientras tanto.
const getAccessToken = async (ownerId) => withTransaction(async (client) => {
  const { rows } = await client.query(
    `SELECT * FROM order_mp_connections
      WHERE owner_id = $1 AND status IN ('active', 'error')
      FOR UPDATE`,
    [ownerId],
  );
  const connection = rows[0];
  if (!connection || !connection.access_token_enc) {
    throw new OrdersError(409, "El local no tiene Mercado Pago conectado.", "MP_NOT_CONNECTED");
  }

  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  const needsRefresh = connection.refresh_token_enc && expiresAt - Date.now() < REFRESH_BEFORE_MS;

  if (needsRefresh) {
    try {
      const tokens = await mpApi.refreshAccessToken(decryptSecret(connection.refresh_token_enc));
      await client.query(
        `UPDATE order_mp_connections
            SET access_token_enc = $2, refresh_token_enc = $3, token_expires_at = $4,
                status = 'active', last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [
          connection.id,
          encryptSecret(tokens.access_token),
          tokens.refresh_token ? encryptSecret(tokens.refresh_token) : connection.refresh_token_enc,
          tokenExpiry(tokens),
        ],
      );
      return {
        connectionId: connection.id,
        mpUserId: connection.mp_user_id,
        liveMode: connection.live_mode,
        accessToken: tokens.access_token,
      };
    } catch (error) {
      const revoked = error instanceof mpApi.MpApiError && (error.status === 400 || error.status === 401);
      if (revoked) {
        // El vendedor revocó el acceso o el refresh token ya no sirve.
        await client.query(
          `UPDATE order_mp_connections
              SET status = 'revoked', disconnected_at = now(), updated_at = now(),
                  last_error = 'El acceso fue revocado o venció. Volvé a conectar la cuenta.',
                  access_token_enc = '', refresh_token_enc = NULL
            WHERE id = $1`,
          [connection.id],
        );
        // Se devuelve una marca en vez de lanzar para que la transacción haga
        // COMMIT del cambio de estado; el error se lanza después, abajo.
        return { revoked: true };
      }
      // Falla transitoria: si el token actual todavía sirve, se usa.
      if (expiresAt <= Date.now()) {
        await client.query(
          `UPDATE order_mp_connections SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`,
          [connection.id, "No se pudo renovar el acceso a Mercado Pago."],
        );
        return { transientFailure: true };
      }
    }
  }

  return {
    connectionId: connection.id,
    mpUserId: connection.mp_user_id,
    liveMode: connection.live_mode,
    accessToken: decryptSecret(connection.access_token_enc),
  };
}).then((result) => {
  if (result.revoked) {
    throw new OrdersError(409, "El acceso a Mercado Pago fue revocado. Volvé a conectar la cuenta.", "MP_NOT_CONNECTED");
  }
  if (result.transientFailure) {
    throw new OrdersError(502, "No pudimos renovar el acceso a Mercado Pago. Intentá de nuevo.", "MP_REFRESH_FAILED");
  }
  return result;
});

const frontendRedirect = (outcome) => {
  const { frontendUrl } = getConfig();
  return `${frontendUrl}/pedidos/configuracion?mp=${encodeURIComponent(outcome)}`;
};

module.exports = {
  getStatus,
  startConnection,
  completeConnection,
  disconnect,
  getAccessToken,
  frontendRedirect,
};
