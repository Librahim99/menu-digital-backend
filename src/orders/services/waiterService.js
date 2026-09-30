// Operadores (antes "mozos": en la base siguen como waiters) y el acceso de
// sus dispositivos al tomador de pedidos.
//
// Acceso sin usuario ni contraseña: desde el panel se muestra un QR por
// operador con un código que rota, es de un solo uso y vence en minutos. Al
// escanearlo, el dispositivo canjea el código por un token de sesión que
// queda en su localStorage. El dueño puede cerrar esas sesiones cuando
// quiera, y dar de baja o pausar al operador las invalida.
//
// Cada sesión guarda el dispositivo (user agent y un nombre legible), el
// inicio, la última actividad y el cierre (con su motivo): así el panel
// puede mostrar "Juan está conectado desde hace 3 h 24 min".

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { LIMITS } = require("../constants");
const { randomToken, hashToken, isTokenShape } = require("../utils/tokens");
const { cleanText } = require("../utils/validate");
const { deviceLabelOf } = require("../utils/device");

const toSessionDTO = (row) => ({
  id: Number(row.id),
  deviceLabel: row.device_label,
  startedAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  endedAt: row.revoked_at,
  endedReason: row.ended_reason,
});

const toWaiterDTO = (row, sessions = []) => ({
  id: Number(row.id),
  name: row.name,
  phone: row.phone,
  notes: row.notes,
  active: row.active,
  activeDevices: sessions.length,
  sessions: sessions.map(toSessionDTO),
  createdAt: row.created_at,
});

// Sesiones abiertas de varios operadores, agrupadas por operador.
const openSessionsByWaiter = async (waiterIds) => {
  if (waiterIds.length === 0) return new Map();
  const { rows } = await query(
    "SELECT * FROM waiter_sessions WHERE waiter_id = ANY($1) AND revoked_at IS NULL ORDER BY created_at",
    [waiterIds]
  );
  const byWaiter = new Map();
  for (const row of rows) {
    const key = String(row.waiter_id);
    if (!byWaiter.has(key)) byWaiter.set(key, []);
    byWaiter.get(key).push(row);
  }
  return byWaiter;
};

const listWaiters = async (ownerId) => {
  const { rows } = await query(
    "SELECT * FROM waiters WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY name",
    [ownerId]
  );
  const sessions = await openSessionsByWaiter(rows.map((row) => row.id));
  return rows.map((row) => toWaiterDTO(row, sessions.get(String(row.id)) ?? []));
};

const withOpenSessions = async (row) => {
  const sessions = await openSessionsByWaiter([row.id]);
  return toWaiterDTO(row, sessions.get(String(row.id)) ?? []);
};

const readWaiterBody = (body = {}, { partial = false } = {}) => {
  const data = {};
  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, LIMITS.waiterNameLength);
    if (!name) throw new OrdersError(400, "El operador necesita un nombre.");
    data.name = name;
  }
  if (!partial || body.phone !== undefined) data.phone = cleanText(body.phone, 30);
  if (!partial || body.notes !== undefined) data.notes = cleanText(body.notes, 200);
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw new OrdersError(400, "Estado inválido.");
    data.active = body.active;
  }
  return data;
};

const getWaiter = async (ownerId, waiterId) => {
  const { rows } = await query(
    "SELECT * FROM waiters WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL",
    [ownerId, waiterId]
  );
  if (!rows[0]) throw new OrdersError(404, "Operador no encontrado.");
  return rows[0];
};

const createWaiter = async (ownerId, body) => {
  const data = readWaiterBody(body);
  const { rows } = await query(
    "INSERT INTO waiters (owner_id, name, phone, notes) VALUES ($1, $2, $3, $4) RETURNING *",
    [ownerId, data.name, data.phone, data.notes]
  );
  return toWaiterDTO(rows[0]);
};

const closeOpenSessions = (runner, waiterId, reason) =>
  runner.query(
    "UPDATE waiter_sessions SET revoked_at = now(), ended_reason = $2 WHERE waiter_id = $1 AND revoked_at IS NULL",
    [waiterId, reason]
  );

const updateWaiter = async (ownerId, waiterId, body) => {
  const current = await getWaiter(ownerId, waiterId);
  const data = { ...current, ...readWaiterBody(body, { partial: true }) };
  const row = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE waiters SET name = $3, phone = $4, notes = $5, active = $6, updated_at = now()
       WHERE owner_id = $1 AND id = $2 RETURNING *`,
      [ownerId, waiterId, data.name, data.phone, data.notes, data.active]
    );
    // Pausar a un operador le cierra el acceso en todos sus dispositivos.
    if (!data.active) {
      await closeOpenSessions(client, waiterId, "paused");
      await client.query("UPDATE waiters SET pairing_code_hash = NULL, pairing_expires_at = NULL WHERE id = $1", [waiterId]);
    }
    return rows[0];
  });
  return withOpenSessions(row);
};

// Baja lógica: sus pedidos conservan el nombre en el historial.
const deleteWaiter = async (ownerId, waiterId) => {
  await getWaiter(ownerId, waiterId);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE waiters SET deleted_at = now(), active = false, pairing_code_hash = NULL,
         pairing_expires_at = NULL, updated_at = now() WHERE owner_id = $1 AND id = $2`,
      [ownerId, waiterId]
    );
    await closeOpenSessions(client, waiterId, "deleted");
  });
};

const revokeSessions = async (ownerId, waiterId) => {
  await getWaiter(ownerId, waiterId);
  await closeOpenSessions({ query }, waiterId, "revoked");
};

// Cierra un solo dispositivo del operador.
const revokeSession = async (ownerId, waiterId, sessionId) => {
  await getWaiter(ownerId, waiterId);
  const { rowCount } = await query(
    `UPDATE waiter_sessions SET revoked_at = now(), ended_reason = 'revoked'
     WHERE id = $1 AND waiter_id = $2 AND owner_id = $3 AND revoked_at IS NULL`,
    [sessionId, waiterId, ownerId]
  );
  if (rowCount === 0) throw new OrdersError(404, "Esa sesión ya no está abierta.");
};

// Historial de sesiones de un operador: las abiertas y las últimas cerradas.
const listSessions = async (ownerId, waiterId) => {
  await getWaiter(ownerId, waiterId);
  const { rows } = await query(
    `SELECT * FROM waiter_sessions WHERE waiter_id = $1 AND owner_id = $2
     ORDER BY (revoked_at IS NULL) DESC, coalesce(revoked_at, created_at) DESC LIMIT 30`,
    [waiterId, ownerId]
  );
  return rows.map(toSessionDTO);
};

// Genera el código del QR de acceso. Cada llamada invalida el anterior.
const issuePairingCode = async (ownerId, waiterId) => {
  const waiter = await getWaiter(ownerId, waiterId);
  if (!waiter.active) throw new OrdersError(409, "El operador está pausado. Activalo para generar su QR.");
  const code = randomToken(18);
  const expiresAt = new Date(Date.now() + LIMITS.pairingCodeTtlMs);
  await query(
    "UPDATE waiters SET pairing_code_hash = $2, pairing_expires_at = $3 WHERE id = $1",
    [waiterId, hashToken(code), expiresAt]
  );
  return { code, expiresAt };
};

// Canje del código escaneado por una sesión del dispositivo.
const pairDevice = async (code, { userAgent = null } = {}) => {
  if (!isTokenShape(code)) throw new OrdersError(400, "El código QR no es válido.");
  const ua = typeof userAgent === "string" ? userAgent.slice(0, 400) : null;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM waiters WHERE pairing_code_hash = $1 AND pairing_expires_at > now()
         AND active AND deleted_at IS NULL FOR UPDATE`,
      [hashToken(code)]
    );
    const waiter = rows[0];
    if (!waiter) throw new OrdersError(401, "El QR venció o ya se usó. Pedí que te muestren uno nuevo.", "PAIRING_EXPIRED");

    const token = randomToken(32);
    await client.query("UPDATE waiters SET pairing_code_hash = NULL, pairing_expires_at = NULL WHERE id = $1", [waiter.id]);
    await client.query(
      `INSERT INTO waiter_sessions (waiter_id, owner_id, token_hash, user_agent, device_label, waiter_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [waiter.id, waiter.owner_id, hashToken(token), ua, deviceLabelOf(ua), waiter.name]
    );
    return { token, waiter: { id: Number(waiter.id), name: waiter.name }, ownerId: waiter.owner_id };
  });
};

// Sesión de un dispositivo a partir de su token. null si no es válida.
// Cada uso actualiza la última actividad.
const authenticateSession = async (token) => {
  if (!isTokenShape(token)) return null;
  const { rows } = await query(
    `UPDATE waiter_sessions s SET last_seen_at = now()
     FROM waiters w
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND w.id = s.waiter_id
       AND w.active AND w.deleted_at IS NULL
     RETURNING s.id AS session_id, s.created_at AS started_at, w.id AS waiter_id, w.name, w.owner_id`,
    [hashToken(token)]
  );
  const row = rows[0];
  return row
    ? {
      sessionId: Number(row.session_id),
      startedAt: row.started_at,
      waiterId: Number(row.waiter_id),
      name: row.name,
      ownerId: row.owner_id,
    }
    : null;
};

const endSession = (sessionId) =>
  query("UPDATE waiter_sessions SET revoked_at = now(), ended_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL", [sessionId]);

module.exports = {
  listWaiters,
  getWaiter,
  createWaiter,
  updateWaiter,
  deleteWaiter,
  revokeSessions,
  revokeSession,
  listSessions,
  issuePairingCode,
  pairDevice,
  authenticateSession,
  endSession,
};
