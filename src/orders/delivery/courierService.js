// Repartidores de Delivery y el acceso de sus dispositivos al panel de reparto.
//
// Mismo mecanismo que los mozos (ver services/waiterService.js): sin usuario ni
// contraseña. Desde el panel del local se muestra un QR con un código que es de
// un solo uso, vence en minutos y se puede revocar. Al escanearlo, el celular lo
// canjea por un token de sesión (solo se guarda su hash) que el dueño puede cerrar.
//
// Vinculado (active) no significa disponible: `available` lo cambia el propio
// repartidor y es lo que cuenta para recibir entregas nuevas.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { LIMITS } = require("../constants");
const {
  randomToken, hashToken, isTokenShape, randomPairingCode, normalizePairingCode, formatPairingCode,
} = require("../utils/tokens");
const { cleanText } = require("../utils/validate");
const { deviceLabelOf } = require("../utils/device");
const realtime = require("./realtime");

const toSessionDTO = (row) => ({
  id: Number(row.id),
  deviceLabel: row.device_label,
  startedAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  endedAt: row.revoked_at,
  endedReason: row.ended_reason,
});

const toCourierDTO = (row, sessions = [], activeDeliveries = 0) => ({
  id: Number(row.id),
  name: row.name,
  phone: row.phone,
  notes: row.notes,
  active: row.active,
  available: row.available,
  activeDevices: sessions.length,
  sessions: sessions.map(toSessionDTO),
  // Entregas asignadas o en camino (impide desactivarlo sin resolverlas).
  activeDeliveries,
  createdAt: row.created_at,
});

const openSessionsByCourier = async (courierIds) => {
  if (courierIds.length === 0) return new Map();
  const { rows } = await query(
    "SELECT * FROM courier_sessions WHERE courier_id = ANY($1) AND revoked_at IS NULL ORDER BY created_at",
    [courierIds]
  );
  const byCourier = new Map();
  for (const row of rows) {
    const key = String(row.courier_id);
    if (!byCourier.has(key)) byCourier.set(key, []);
    byCourier.get(key).push(row);
  }
  return byCourier;
};

const activeCounts = async (courierIds) => {
  if (courierIds.length === 0) return new Map();
  const { rows } = await query(
    `SELECT courier_id, count(*)::int AS total FROM delivery_assignments
     WHERE courier_id = ANY($1) AND status IN ('assigned', 'picked_up') GROUP BY courier_id`,
    [courierIds]
  );
  return new Map(rows.map((row) => [String(row.courier_id), row.total]));
};

const listCouriers = async (ownerId) => {
  const { rows } = await query(
    "SELECT * FROM couriers WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY name",
    [ownerId]
  );
  const ids = rows.map((row) => row.id);
  const [sessions, counts] = await Promise.all([openSessionsByCourier(ids), activeCounts(ids)]);
  return rows.map((row) => toCourierDTO(row, sessions.get(String(row.id)) ?? [], counts.get(String(row.id)) ?? 0));
};

const withDetails = async (row) => {
  const [sessions, counts] = await Promise.all([openSessionsByCourier([row.id]), activeCounts([row.id])]);
  return toCourierDTO(row, sessions.get(String(row.id)) ?? [], counts.get(String(row.id)) ?? 0);
};

const readBody = (body = {}, { partial = false } = {}) => {
  const data = {};
  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, LIMITS.waiterNameLength);
    if (!name) throw new OrdersError(400, "El repartidor necesita un nombre.");
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

const getCourier = async (ownerId, courierId, runner = { query }) => {
  const { rows } = await runner.query(
    "SELECT * FROM couriers WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL",
    [ownerId, courierId]
  );
  if (!rows[0]) throw new OrdersError(404, "Repartidor no encontrado.");
  return rows[0];
};

const createCourier = async (ownerId, body) => {
  const data = readBody(body);
  const { rows } = await query(
    "INSERT INTO couriers (owner_id, name, phone, notes) VALUES ($1, $2, $3, $4) RETURNING *",
    [ownerId, data.name, data.phone, data.notes]
  );
  return toCourierDTO(rows[0]);
};

const closeOpenSessions = (runner, courierId, reason) =>
  runner.query(
    "UPDATE courier_sessions SET revoked_at = now(), ended_reason = $2 WHERE courier_id = $1 AND revoked_at IS NULL",
    [courierId, reason]
  );

/**
 * Cuántas entregas sin resolver tiene un repartidor, bloqueando sus filas.
 * Las "asignadas" se pueden pasar a otro; las "en camino" (ya retiradas)
 * exigen resolverse o reasignarse explícitamente.
 */
const countActiveDeliveries = async (runner, courierId) => {
  const { rows } = await runner.query(
    "SELECT count(*)::int AS total FROM delivery_assignments WHERE courier_id = $1 AND status IN ('assigned', 'picked_up')",
    [courierId]
  );
  return rows[0].total;
};

const updateCourier = async (ownerId, courierId, body, { reassignActive = null } = {}) => {
  const current = await getCourier(ownerId, courierId);
  const data = { ...current, ...readBody(body, { partial: true }) };
  const deactivating = current.active && !data.active;
  let moved = [];

  const row = await withTransaction(async (client) => {
    if (deactivating) moved = await resolveBeforeLeaving(client, ownerId, current, reassignActive);
    const { rows } = await client.query(
      `UPDATE couriers SET name = $3, phone = $4, notes = $5, active = $6,
         available = CASE WHEN $6 THEN available ELSE false END, updated_at = now()
       WHERE owner_id = $1 AND id = $2 RETURNING *`,
      [ownerId, courierId, data.name, data.phone, data.notes, data.active]
    );
    // Pausar a un repartidor le cierra el acceso en todos sus dispositivos.
    if (!data.active) {
      await closeOpenSessions(client, courierId, "paused");
      await client.query("UPDATE couriers SET pairing_code_hash = NULL, pairing_manual_hash = NULL, pairing_expires_at = NULL WHERE id = $1", [courierId]);
    }
    return rows[0];
  });
  for (const event of moved) realtime.emit({ ownerId, ...event });
  realtime.emit({ ownerId, event: "courier_updated", courierIds: [courierId], openList: true });
  return withDetails(row);
};

// Dar de baja o pausar a alguien con entregas sin resolver no deja pedidos
// huérfanos: o se pasan a otro repartidor (reassignTo) o la operación se rechaza.
const resolveBeforeLeaving = async (client, ownerId, courier, reassignTo) => {
  const pending = await countActiveDeliveries(client, courier.id);
  if (pending === 0) return [];
  if (!reassignTo) {
    throw new OrdersError(
      409,
      `${courier.name} tiene ${pending} ${pending === 1 ? "entrega sin resolver" : "entregas sin resolver"}. Reasignalas o resolvelas antes de desactivarlo.`,
      "COURIER_HAS_ACTIVE_DELIVERIES",
    );
  }
  // Devuelve los avisos: se emiten recién cuando la transacción se confirma.
  const { reassignAll } = require("./deliveryService");
  return reassignAll(client, ownerId, { fromCourier: courier, toCourierId: reassignTo });
};

// Baja lógica: sus entregas conservan el nombre en el historial.
const deleteCourier = async (ownerId, courierId, { reassignActive = null } = {}) => {
  const current = await getCourier(ownerId, courierId);
  let moved = [];
  await withTransaction(async (client) => {
    moved = await resolveBeforeLeaving(client, ownerId, current, reassignActive);
    await client.query(
      `UPDATE couriers SET deleted_at = now(), active = false, available = false, pairing_code_hash = NULL,
         pairing_expires_at = NULL, updated_at = now() WHERE owner_id = $1 AND id = $2`,
      [ownerId, courierId]
    );
    await closeOpenSessions(client, courierId, "deleted");
  });
  for (const event of moved) realtime.emit({ ownerId, ...event });
  realtime.emit({ ownerId, event: "courier_updated", courierIds: [courierId], openList: true });
};

const revokeSessions = async (ownerId, courierId) => {
  await getCourier(ownerId, courierId);
  await withTransaction(async (client) => {
    await closeOpenSessions(client, courierId, "revoked");
    await client.query("UPDATE couriers SET available = false, updated_at = now() WHERE id = $1", [courierId]);
  });
  realtime.emit({ ownerId, event: "courier_updated", courierIds: [courierId], openList: true });
};

const revokeSession = async (ownerId, courierId, sessionId) => {
  await getCourier(ownerId, courierId);
  const { rowCount } = await query(
    `UPDATE courier_sessions SET revoked_at = now(), ended_reason = 'revoked'
     WHERE id = $1 AND courier_id = $2 AND owner_id = $3 AND revoked_at IS NULL`,
    [sessionId, courierId, ownerId]
  );
  if (rowCount === 0) throw new OrdersError(404, "Esa sesión ya no está abierta.");
  realtime.emit({ ownerId, event: "courier_updated", courierIds: [courierId] });
};

const listSessions = async (ownerId, courierId) => {
  await getCourier(ownerId, courierId);
  const { rows } = await query(
    `SELECT * FROM courier_sessions WHERE courier_id = $1 AND owner_id = $2
     ORDER BY (revoked_at IS NULL) DESC, coalesce(revoked_at, created_at) DESC LIMIT 30`,
    [courierId, ownerId]
  );
  return rows.map(toSessionDTO);
};

// Invitación de vinculación: el QR (`code`, token largo) y un código corto para
// tipear (`manualCode`, "ABCD-EFGH") por si la cámara no anda. Son dos formas de la
// misma invitación: vencen juntas, se usan una sola vez (canjear una invalida la otra)
// y cada llamada invalida la anterior. También se puede revocar sin emitir otra.
const issuePairingCode = async (ownerId, courierId) => {
  const courier = await getCourier(ownerId, courierId);
  if (!courier.active) throw new OrdersError(409, "El repartidor está pausado. Activalo para generar su QR.");
  const code = randomToken(18);
  const manual = randomPairingCode();
  const expiresAt = new Date(Date.now() + LIMITS.pairingCodeTtlMs);
  await query(
    "UPDATE couriers SET pairing_code_hash = $2, pairing_manual_hash = $4, pairing_expires_at = $3, updated_at = now() WHERE id = $1",
    [courierId, hashToken(code), expiresAt, hashToken(manual)]
  );
  return { code, manualCode: formatPairingCode(manual), expiresAt };
};

const revokePairingCode = async (ownerId, courierId) => {
  await getCourier(ownerId, courierId);
  await query(
    "UPDATE couriers SET pairing_code_hash = NULL, pairing_manual_hash = NULL, pairing_expires_at = NULL, updated_at = now() WHERE id = $1",
    [courierId]
  );
};

// Canje del código (escaneado o tipeado) por una sesión del dispositivo.
const pairDevice = async (rawCode, { userAgent = null } = {}) => {
  // El QR trae un token largo; a mano se tipean 8 caracteres (con o sin guion).
  const manual = isTokenShape(rawCode) ? null : normalizePairingCode(rawCode);
  if (!manual && !isTokenShape(rawCode)) throw new OrdersError(400, "El código no es válido.");
  const column = manual ? "pairing_manual_hash" : "pairing_code_hash";
  const code = manual ?? rawCode;
  const ua = typeof userAgent === "string" ? userAgent.slice(0, 400) : null;
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM couriers WHERE ${column} = $1 AND pairing_expires_at > now()
         AND active AND deleted_at IS NULL FOR UPDATE`,
      [hashToken(code)]
    );
    const courier = rows[0];
    if (!courier) throw new OrdersError(401, "El código venció o ya se usó. Pedí que te muestren uno nuevo.", "PAIRING_EXPIRED");

    const token = randomToken(32);
    // Un solo uso: se consume en la misma transacción que crea la sesión.
    await client.query("UPDATE couriers SET pairing_code_hash = NULL, pairing_manual_hash = NULL, pairing_expires_at = NULL WHERE id = $1", [courier.id]);
    await client.query(
      `INSERT INTO courier_sessions (courier_id, owner_id, token_hash, user_agent, device_label, courier_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [courier.id, courier.owner_id, hashToken(token), ua, deviceLabelOf(ua), courier.name]
    );
    return { token, courier: { id: Number(courier.id), name: courier.name }, ownerId: courier.owner_id };
  });
  realtime.emit({ ownerId: result.ownerId, event: "courier_updated", courierIds: [result.courier.id] });
  return result;
};

// Sesión de un dispositivo a partir de su token. null si no es válida.
const authenticateSession = async (token) => {
  if (!isTokenShape(token)) return null;
  const { rows } = await query(
    `UPDATE courier_sessions s SET last_seen_at = now()
     FROM couriers c
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND c.id = s.courier_id
       AND c.active AND c.deleted_at IS NULL
     RETURNING s.id AS session_id, s.created_at AS started_at, c.id AS courier_id, c.name, c.owner_id, c.available`,
    [hashToken(token)]
  );
  const row = rows[0];
  return row
    ? {
      sessionId: Number(row.session_id),
      startedAt: row.started_at,
      courierId: Number(row.courier_id),
      name: row.name,
      ownerId: row.owner_id,
      available: row.available,
    }
    : null;
};

const endSession = async (session) => {
  await query("UPDATE courier_sessions SET revoked_at = now(), ended_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL", [session.sessionId]);
  // Sin ningún dispositivo abierto no puede estar disponible.
  await query(
    `UPDATE couriers SET available = false, updated_at = now()
     WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM courier_sessions WHERE courier_id = $1 AND revoked_at IS NULL)`,
    [session.courierId]
  );
  realtime.emit({ ownerId: session.ownerId, event: "courier_updated", courierIds: [session.courierId], openList: true });
};

// El repartidor se marca disponible / no disponible para recibir entregas.
const setAvailability = async (session, available) => {
  if (typeof available !== "boolean") throw new OrdersError(400, "Disponibilidad inválida.");
  await query("UPDATE couriers SET available = $2, updated_at = now() WHERE id = $1", [session.courierId, available]);
  realtime.emit({ ownerId: session.ownerId, event: "courier_updated", courierIds: [session.courierId], openList: true });
  return available;
};

module.exports = {
  listCouriers,
  getCourier,
  createCourier,
  updateCourier,
  deleteCourier,
  revokeSessions,
  revokeSession,
  listSessions,
  issuePairingCode,
  revokePairingCode,
  pairDevice,
  authenticateSession,
  endSession,
  setAvailability,
};
