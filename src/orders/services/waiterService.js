// Mozos / camareros y el acceso de sus dispositivos al tomador de pedidos.
//
// Acceso sin usuario ni contraseña: desde el panel se muestra un QR por mozo
// con un código que rota, es de un solo uso y vence en minutos. Al
// escanearlo, el dispositivo canjea el código por un token de sesión que
// queda en su localStorage. El dueño puede cerrar esas sesiones cuando
// quiera, y dar de baja o pausar al mozo las invalida.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { LIMITS } = require("../constants");
const { randomToken, hashToken, isTokenShape } = require("../utils/tokens");
const { cleanText } = require("../utils/validate");

const toWaiterDTO = (row) => ({
  id: Number(row.id),
  name: row.name,
  phone: row.phone,
  notes: row.notes,
  active: row.active,
  activeDevices: row.active_devices ?? 0,
  createdAt: row.created_at,
});

const listWaiters = async (ownerId) => {
  const { rows } = await query(
    `SELECT w.*, (SELECT count(*)::int FROM waiter_sessions s WHERE s.waiter_id = w.id AND s.revoked_at IS NULL) AS active_devices
     FROM waiters w WHERE w.owner_id = $1 AND w.deleted_at IS NULL ORDER BY w.name`,
    [ownerId]
  );
  return rows.map(toWaiterDTO);
};

const readWaiterBody = (body = {}, { partial = false } = {}) => {
  const data = {};
  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, LIMITS.waiterNameLength);
    if (!name) throw new OrdersError(400, "El mozo necesita un nombre.");
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
  if (!rows[0]) throw new OrdersError(404, "Mozo no encontrado.");
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

const updateWaiter = async (ownerId, waiterId, body) => {
  const current = await getWaiter(ownerId, waiterId);
  const data = { ...current, ...readWaiterBody(body, { partial: true }) };
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE waiters SET name = $3, phone = $4, notes = $5, active = $6, updated_at = now()
       WHERE owner_id = $1 AND id = $2 RETURNING *`,
      [ownerId, waiterId, data.name, data.phone, data.notes, data.active]
    );
    // Pausar a un mozo le cierra el acceso en todos sus dispositivos.
    if (!data.active) {
      await client.query("UPDATE waiter_sessions SET revoked_at = now() WHERE waiter_id = $1 AND revoked_at IS NULL", [waiterId]);
      await client.query("UPDATE waiters SET pairing_code_hash = NULL, pairing_expires_at = NULL WHERE id = $1", [waiterId]);
    }
    return toWaiterDTO(rows[0]);
  });
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
    await client.query("UPDATE waiter_sessions SET revoked_at = now() WHERE waiter_id = $1 AND revoked_at IS NULL", [waiterId]);
  });
};

const revokeSessions = async (ownerId, waiterId) => {
  await getWaiter(ownerId, waiterId);
  await query("UPDATE waiter_sessions SET revoked_at = now() WHERE waiter_id = $1 AND revoked_at IS NULL", [waiterId]);
};

// Genera el código del QR de acceso. Cada llamada invalida el anterior.
const issuePairingCode = async (ownerId, waiterId) => {
  const waiter = await getWaiter(ownerId, waiterId);
  if (!waiter.active) throw new OrdersError(409, "El mozo está pausado. Activalo para generar su QR.");
  const code = randomToken(18);
  const expiresAt = new Date(Date.now() + LIMITS.pairingCodeTtlMs);
  await query(
    "UPDATE waiters SET pairing_code_hash = $2, pairing_expires_at = $3 WHERE id = $1",
    [waiterId, hashToken(code), expiresAt]
  );
  return { code, expiresAt };
};

// Canje del código escaneado por una sesión del dispositivo.
const pairDevice = async (code) => {
  if (!isTokenShape(code)) throw new OrdersError(400, "El código QR no es válido.");
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
      "INSERT INTO waiter_sessions (waiter_id, owner_id, token_hash) VALUES ($1, $2, $3)",
      [waiter.id, waiter.owner_id, hashToken(token)]
    );
    return { token, waiter: { id: Number(waiter.id), name: waiter.name }, ownerId: waiter.owner_id };
  });
};

// Sesión de un dispositivo a partir de su token. null si no es válida.
const authenticateSession = async (token) => {
  if (!isTokenShape(token)) return null;
  const { rows } = await query(
    `UPDATE waiter_sessions s SET last_seen_at = now()
     FROM waiters w
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND w.id = s.waiter_id
       AND w.active AND w.deleted_at IS NULL
     RETURNING s.id AS session_id, w.id AS waiter_id, w.name, w.owner_id`,
    [hashToken(token)]
  );
  const row = rows[0];
  return row ? { sessionId: Number(row.session_id), waiterId: Number(row.waiter_id), name: row.name, ownerId: row.owner_id } : null;
};

const endSession = (sessionId) =>
  query("UPDATE waiter_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);

module.exports = {
  listWaiters,
  getWaiter,
  createWaiter,
  updateWaiter,
  deleteWaiter,
  revokeSessions,
  issuePairingCode,
  pairDevice,
  authenticateSession,
  endSession,
};
