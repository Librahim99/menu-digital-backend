// Sectores del local (cocina, barra, postres…), a qué sector va cada parte
// del menú y los dispositivos de cada sector.
//
// Sin sectores el local trabaja como siempre: todo el pedido en el panel.
// Con sectores, cada pedido confirmado se parte en comandas (ver
// ticketService) y cada sector ve solo lo suyo.
//
// Los dispositivos de un sector (una PC en la cocina, una tablet en la barra)
// se vinculan con un código corto que se tipea: el dueño lo genera desde el
// panel, es de un solo uso y vence a los pocos minutos. El equipo lo canjea
// por un token que queda en su localStorage; nunca tiene la sesión del dueño.

const mongoose = require("mongoose");
const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { LIMITS, PRINT_MODES, PAPER_WIDTHS } = require("../constants");
const {
  randomToken, hashToken, isTokenShape, randomPairingCode, normalizePairingCode, formatPairingCode,
} = require("../utils/tokens");
const { cleanText } = require("../utils/validate");
const { deviceLabelOf } = require("../utils/device");
const { TARGET_TYPES, buildRouting } = require("../utils/sectorRouting");

const toSessionDTO = (row) => ({
  id: Number(row.id),
  deviceLabel: row.device_label,
  startedAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  endedAt: row.revoked_at,
  endedReason: row.ended_reason,
});

const toSectorDTO = (row, sessions = []) => ({
  id: Number(row.id),
  name: row.name,
  isDefault: row.is_default,
  position: row.position,
  printMode: row.print_mode,
  paperWidth: row.paper_width,
  printCopies: row.print_copies,
  activeDevices: sessions.length,
  sessions: sessions.map(toSessionDTO),
  createdAt: row.created_at,
});

const toAssignmentDTO = (row) => ({
  targetType: row.target_type,
  targetId: row.target_id,
  sectorId: Number(row.sector_id),
});

// Activos, en el orden en que los ve el dueño.
const listActiveSectorRows = async (runner, ownerId) => {
  const { rows } = await runner.query(
    "SELECT * FROM order_sectors WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY position, id",
    [ownerId]
  );
  return rows;
};

const openSessionsBySector = async (sectorIds) => {
  if (sectorIds.length === 0) return new Map();
  const { rows } = await query(
    "SELECT * FROM sector_sessions WHERE sector_id = ANY($1) AND revoked_at IS NULL ORDER BY created_at",
    [sectorIds]
  );
  const bySector = new Map();
  for (const row of rows) {
    const key = String(row.sector_id);
    if (!bySector.has(key)) bySector.set(key, []);
    bySector.get(key).push(row);
  }
  return bySector;
};

const listSectors = async (ownerId) => {
  const rows = await listActiveSectorRows({ query }, ownerId);
  const sessions = await openSessionsBySector(rows.map((row) => row.id));
  return rows.map((row) => toSectorDTO(row, sessions.get(String(row.id)) ?? []));
};

const listAssignments = async (ownerId) => {
  const { rows } = await query(
    `SELECT a.* FROM order_sector_assignments a
     JOIN order_sectors s ON s.id = a.sector_id AND s.deleted_at IS NULL
     WHERE a.owner_id = $1`,
    [ownerId]
  );
  return rows.map(toAssignmentDTO);
};

// Lo que necesita ticketService para repartir un pedido. `runner` puede ser
// el client de una transacción.
const loadRouting = async (runner, ownerId) => {
  const sectors = await listActiveSectorRows(runner, ownerId);
  if (sectors.length === 0) return { sectors, routing: null };
  const { rows } = await runner.query(
    "SELECT target_type, target_id, sector_id FROM order_sector_assignments WHERE owner_id = $1",
    [ownerId]
  );
  return { sectors, routing: buildRouting(sectors, rows) };
};

const getSector = async (runner, ownerId, sectorId) => {
  const { rows } = await runner.query(
    "SELECT * FROM order_sectors WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL",
    [ownerId, sectorId]
  );
  if (!rows[0]) throw new OrdersError(404, "Sector no encontrado.");
  return rows[0];
};

const withOpenSessions = async (row) => {
  const sessions = await openSessionsBySector([row.id]);
  return toSectorDTO(row, sessions.get(String(row.id)) ?? []);
};

const readName = (value) => {
  const name = cleanText(value, LIMITS.sectorNameLength);
  if (!name) throw new OrdersError(400, "El sector necesita un nombre.");
  return name;
};

// Dos sectores activos con el mismo nombre chocan con el índice único.
const rethrowDuplicateName = (error) => {
  if (error.code === "23505" && String(error.constraint ?? "").includes("unique_name")) {
    throw new OrdersError(409, "Ya tenés un sector con ese nombre.");
  }
  throw error;
};

const createSector = async (ownerId, body = {}) => {
  const name = readName(body.name);
  const row = await withTransaction(async (client) => {
    const existing = await listActiveSectorRows(client, ownerId);
    if (existing.length >= LIMITS.maxSectors) {
      throw new OrdersError(409, `Podés tener hasta ${LIMITS.maxSectors} sectores.`);
    }
    const position = existing.reduce((max, sector) => Math.max(max, sector.position + 1), 0);
    const { rows } = await client.query(
      `INSERT INTO order_sectors (owner_id, name, is_default, position) VALUES ($1, $2, $3, $4) RETURNING *`,
      // El primero recibe todo lo que no tenga sector: es el "por defecto".
      [ownerId, name, existing.length === 0, position]
    );
    return rows[0];
  }).catch(rethrowDuplicateName);
  return toSectorDTO(row);
};

const updateSector = async (ownerId, sectorId, body = {}) => {
  const current = await getSector({ query }, ownerId, sectorId);
  const next = {
    name: current.name,
    print_mode: current.print_mode,
    paper_width: current.paper_width,
    print_copies: current.print_copies,
  };
  if (body.name !== undefined) next.name = readName(body.name);
  if (body.printMode !== undefined) {
    if (!PRINT_MODES.includes(body.printMode)) throw new OrdersError(400, "Modo de impresión inválido.");
    next.print_mode = body.printMode;
  }
  if (body.paperWidth !== undefined) {
    if (!PAPER_WIDTHS.includes(Number(body.paperWidth))) throw new OrdersError(400, "Ancho de papel inválido.");
    next.paper_width = Number(body.paperWidth);
  }
  if (body.printCopies !== undefined) {
    const copies = Number(body.printCopies);
    if (!Number.isSafeInteger(copies) || copies < 1 || copies > 3) throw new OrdersError(400, "Copias inválidas (1 a 3).");
    next.print_copies = copies;
  }
  if (body.isDefault !== undefined && body.isDefault !== true) {
    // Siempre hay uno por defecto: se cambia marcando otro.
    throw new OrdersError(400, "Para cambiar el sector por defecto, marcá otro sector.");
  }

  const row = await withTransaction(async (client) => {
    if (body.isDefault === true && !current.is_default) {
      await client.query(
        "UPDATE order_sectors SET is_default = false, updated_at = now() WHERE owner_id = $1 AND is_default AND deleted_at IS NULL",
        [ownerId]
      );
      await client.query("UPDATE order_sectors SET is_default = true WHERE id = $1", [sectorId]);
    }
    const { rows } = await client.query(
      `UPDATE order_sectors SET name = $3, print_mode = $4, paper_width = $5, print_copies = $6, updated_at = now()
       WHERE owner_id = $1 AND id = $2 RETURNING *`,
      [ownerId, sectorId, next.name, next.print_mode, next.paper_width, next.print_copies]
    );
    return rows[0];
  }).catch(rethrowDuplicateName);
  return withOpenSessions(row);
};

const closeOpenSessions = (runner, sectorId, reason) =>
  runner.query(
    "UPDATE sector_sessions SET revoked_at = now(), ended_reason = $2 WHERE sector_id = $1 AND revoked_at IS NULL",
    [sectorId, reason]
  );

// Baja lógica. Lo asignado a este sector vuelve a heredar; sus dispositivos
// quedan desvinculados y, si era el sector por defecto, pasa a serlo el
// primero que quede. Las comandas que ya tenía siguen en el historial.
const deleteSector = async (ownerId, sectorId) => {
  const sector = await getSector({ query }, ownerId, sectorId);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE order_sectors SET deleted_at = now(), is_default = false, pairing_code_hash = NULL,
         pairing_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [sectorId]
    );
    await client.query("DELETE FROM order_sector_assignments WHERE owner_id = $1 AND sector_id = $2", [ownerId, sectorId]);
    await closeOpenSessions(client, sectorId, "deleted");
    if (sector.is_default) {
      await client.query(
        `UPDATE order_sectors SET is_default = true, updated_at = now()
         WHERE id = (SELECT id FROM order_sectors WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY position, id LIMIT 1)`,
        [ownerId]
      );
    }
  });
};

/**
 * Asigna (o saca, con sectorId null) el sector de una sección, categoría o
 * producto del menú. Los ids son de Mongo; solo se valida la forma: una
 * asignación a algo que no es del local no tiene efecto sobre nadie más.
 */
const setAssignment = async (ownerId, body = {}) => {
  const { targetType, targetId } = body;
  if (!TARGET_TYPES.includes(targetType)) throw new OrdersError(400, "Elemento del menú inválido.");
  if (typeof targetId !== "string" || !mongoose.isValidObjectId(targetId)) {
    throw new OrdersError(400, "Elemento del menú inválido.");
  }
  if (body.sectorId === null || body.sectorId === undefined || body.sectorId === "") {
    await query(
      "DELETE FROM order_sector_assignments WHERE owner_id = $1 AND target_type = $2 AND target_id = $3",
      [ownerId, targetType, targetId]
    );
    return { targetType, targetId, sectorId: null };
  }
  const sectorId = Number(body.sectorId);
  if (!Number.isSafeInteger(sectorId) || sectorId < 1) throw new OrdersError(400, "Sector inválido.");
  await getSector({ query }, ownerId, sectorId);
  const { rows } = await query(
    `INSERT INTO order_sector_assignments (owner_id, target_type, target_id, sector_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_id, target_type, target_id) DO UPDATE SET sector_id = EXCLUDED.sector_id, updated_at = now()
     RETURNING *`,
    [ownerId, targetType, targetId, sectorId]
  );
  return toAssignmentDTO(rows[0]);
};

// ── Dispositivos ─────────────────────────────

// Genera el código para vincular un equipo. Cada llamada invalida el anterior.
const issuePairingCode = async (ownerId, sectorId) => {
  await getSector({ query }, ownerId, sectorId);
  const code = randomPairingCode();
  const expiresAt = new Date(Date.now() + LIMITS.sectorPairingTtlMs);
  await query(
    "UPDATE order_sectors SET pairing_code_hash = $2, pairing_expires_at = $3 WHERE id = $1",
    [sectorId, hashToken(code), expiresAt]
  );
  return { code: formatPairingCode(code), expiresAt };
};

// Canje del código tipeado por una sesión del dispositivo.
const pairDevice = async (rawCode, { userAgent = null } = {}) => {
  const code = normalizePairingCode(rawCode);
  if (!code) throw new OrdersError(400, "El código tiene 8 letras y números, como ABCD-2345.");
  const ua = typeof userAgent === "string" ? userAgent.slice(0, 400) : null;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM order_sectors WHERE pairing_code_hash = $1 AND pairing_expires_at > now()
         AND deleted_at IS NULL FOR UPDATE`,
      [hashToken(code)]
    );
    const sector = rows[0];
    if (!sector) {
      throw new OrdersError(401, "El código venció o ya se usó. Generá uno nuevo desde el panel.", "PAIRING_EXPIRED");
    }
    const token = randomToken(32);
    await client.query("UPDATE order_sectors SET pairing_code_hash = NULL, pairing_expires_at = NULL WHERE id = $1", [sector.id]);
    await client.query(
      `INSERT INTO sector_sessions (sector_id, owner_id, token_hash, user_agent, device_label)
       VALUES ($1, $2, $3, $4, $5)`,
      [sector.id, sector.owner_id, hashToken(token), ua, deviceLabelOf(ua)]
    );
    return { token, sector: toSectorDTO(sector), ownerId: sector.owner_id };
  });
};

// Sesión de un dispositivo a partir de su token (null si no es válida). Cada
// uso actualiza la última actividad.
const authenticateSession = async (token) => {
  if (!isTokenShape(token)) return null;
  const { rows } = await query(
    `UPDATE sector_sessions ss SET last_seen_at = now()
     FROM order_sectors s
     WHERE ss.token_hash = $1 AND ss.revoked_at IS NULL AND s.id = ss.sector_id AND s.deleted_at IS NULL
     RETURNING ss.id AS session_id, ss.created_at AS started_at, s.*`,
    [hashToken(token)]
  );
  const row = rows[0];
  return row
    ? { sessionId: Number(row.session_id), startedAt: row.started_at, ownerId: row.owner_id, sector: toSectorDTO(row) }
    : null;
};

const endSession = (sessionId) =>
  query("UPDATE sector_sessions SET revoked_at = now(), ended_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL", [sessionId]);

const revokeSessions = async (ownerId, sectorId) => {
  await getSector({ query }, ownerId, sectorId);
  await closeOpenSessions({ query }, sectorId, "revoked");
};

const revokeSession = async (ownerId, sectorId, sessionId) => {
  await getSector({ query }, ownerId, sectorId);
  const { rowCount } = await query(
    `UPDATE sector_sessions SET revoked_at = now(), ended_reason = 'revoked'
     WHERE id = $1 AND sector_id = $2 AND owner_id = $3 AND revoked_at IS NULL`,
    [sessionId, sectorId, ownerId]
  );
  if (rowCount === 0) throw new OrdersError(404, "Ese dispositivo ya no está vinculado.");
};

module.exports = {
  toSectorDTO,
  listSectors,
  listAssignments,
  loadRouting,
  getSector,
  createSector,
  updateSector,
  deleteSector,
  setAssignment,
  issuePairingCode,
  pairDevice,
  authenticateSession,
  endSession,
  revokeSessions,
  revokeSession,
};
