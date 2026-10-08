// Reservas: acceso a Postgres, reglas de negocio y notificación en vivo.
//
// El estado de cada reserva cambia siempre por acá (panel del local o
// cliente con su código). Cada cambio se avisa por WebSocket (realtime.js) a
// las pantallas abiertas. Las consultas pasan por `db.query` (y no por una
// función suelta) para poder simularlas en los tests.

const db = require("../db/sql");
const realtime = require("../realtime");
const { randomPairingCode, normalizePairingCode, formatPairingCode } = require("../../orders/utils/tokens");
const { ReservationsError } = require("../errors");
const { LIMITS } = require("../constants");
const {
  requiredText, cleanText, parseDate, parseTime, parsePartySize, parsePhone, parseSettingsPatch,
  assertBookable,
} = require("../utils/validate");
const { ownerAction, customerAction } = require("../utils/transitions");

// Fecha y hora salen como texto ("YYYY-MM-DD", "HH:MM") para no pasar por la
// conversión a Date del driver (corre la fecha según la zona del servidor).
const COLUMNS = `
  id, owner_id, code, customer_name, customer_phone, party_size,
  to_char(reserve_date, 'YYYY-MM-DD') AS reserve_date,
  to_char(reserve_time, 'HH24:MI') AS reserve_time,
  status, source, table_label,
  to_char(alt_date, 'YYYY-MM-DD') AS alt_date,
  to_char(alt_time, 'HH24:MI') AS alt_time,
  message, notes, internal_notes, created_at, updated_at
`;

// Columnas que `applyUpdate` acepta (nada que venga del cliente se
// interpola en el SQL: los nombres salen de esta lista).
const UPDATABLE = [
  "status", "customer_name", "customer_phone", "party_size", "reserve_date", "reserve_time",
  "table_label", "alt_date", "alt_time", "message", "notes", "internal_notes",
];

// ── Configuración ────────────────────────────

const toSettingsDTO = (row) => ({
  enabled: row.enabled,
  phoneMode: row.phone_mode,
  maxPartySize: row.max_party_size,
  maxDaysAhead: row.max_days_ahead,
  minNoticeMinutes: row.min_notice_minutes,
});

const SETTINGS_COLUMNS = {
  enabled: "enabled",
  phoneMode: "phone_mode",
  maxPartySize: "max_party_size",
  maxDaysAhead: "max_days_ahead",
  minNoticeMinutes: "min_notice_minutes",
};

const findSettings = async (ownerId) => {
  const { rows } = await db.query("SELECT * FROM reservation_settings WHERE owner_id = $1", [ownerId]);
  return rows[0] ?? null;
};

const getOrCreateSettings = async (ownerId) => {
  const existing = await findSettings(ownerId);
  if (existing) return existing;
  await db.query("INSERT INTO reservation_settings (owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING", [ownerId]);
  return findSettings(ownerId);
};

const updateSettings = async (ownerId, body) => {
  const patch = parseSettingsPatch(body);
  await getOrCreateSettings(ownerId);
  const entries = Object.entries(patch);
  if (entries.length === 0) return findSettings(ownerId);

  const sets = entries.map(([key], index) => `${SETTINGS_COLUMNS[key]} = $${index + 2}`);
  const { rows } = await db.query(
    `UPDATE reservation_settings SET ${sets.join(", ")}, updated_at = now() WHERE owner_id = $1 RETURNING *`,
    [ownerId, ...entries.map(([, value]) => value)]
  );
  return rows[0];
};

// ── DTOs ─────────────────────────────────────

// Lo que ve el local: todo.
const toOwnerDTO = (row) => ({
  id: Number(row.id),
  code: formatPairingCode(row.code),
  name: row.customer_name,
  phone: row.customer_phone,
  partySize: row.party_size,
  date: row.reserve_date,
  time: row.reserve_time,
  status: row.status,
  source: row.source,
  tableLabel: row.table_label,
  altDate: row.alt_date,
  altTime: row.alt_time,
  message: row.message,
  notes: row.notes,
  internalNotes: row.internal_notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// Lo que ve el cliente con su código: sin teléfono ni notas internas.
const toCustomerDTO = (row) => ({
  code: formatPairingCode(row.code),
  name: row.customer_name,
  partySize: row.party_size,
  date: row.reserve_date,
  time: row.reserve_time,
  status: row.status,
  // La mesa solo se muestra una vez confirmada.
  tableLabel: row.status === "confirmed" ? row.table_label : null,
  altDate: row.status === "rejected" ? row.alt_date : null,
  altTime: row.status === "rejected" ? row.alt_time : null,
  message: row.message,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const notify = (row) => {
  try {
    realtime.publish(row.owner_id, row.code, toOwnerDTO(row), toCustomerDTO(row));
  } catch (error) {
    // El tiempo real es un plus: si falla, la reserva ya quedó guardada.
    console.error(`⚠️  Reservas (tiempo real): ${error.message}`);
  }
};

// ── Lecturas ─────────────────────────────────

const findByCode = async (rawCode) => {
  const code = normalizePairingCode(rawCode);
  if (!code) return null;
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM reservations WHERE code = $1`, [code]);
  return rows[0] ?? null;
};

const findOwned = async (ownerId, id) => {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM reservations WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
  if (!rows[0]) throw new ReservationsError(404, "No encontramos la reserva.");
  return rows[0];
};

// Listado del panel (tabla y kanban comparten estos datos; los filtros se
// aplican en pantalla). Trae las reservas desde `from` en adelante y, sin
// importar la fecha, las que todavía esperan respuesta (pendientes y
// rechazadas). Tope: LIMITS.listMax; `truncated` avisa si quedaron afuera.
const listForOwner = async (ownerId, { from }) => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM reservations
     WHERE owner_id = $1 AND (reserve_date >= $2::date OR status IN ('pending', 'rejected'))
     ORDER BY reserve_date, reserve_time, id
     LIMIT $3`,
    [ownerId, from, LIMITS.listMax + 1]
  );
  const truncated = rows.length > LIMITS.listMax;
  return { rows: truncated ? rows.slice(0, LIMITS.listMax) : rows, truncated };
};

const countPending = async (ownerId) => {
  const { rows } = await db.query(
    "SELECT count(*)::int AS total FROM reservations WHERE owner_id = $1 AND status = 'pending'", [ownerId]
  );
  return rows[0].total;
};

// ── Escrituras ───────────────────────────────

const isUniqueViolation = (error) => error?.code === "23505";

const insertReservation = async (ownerId, fields) => {
  // 31^8 códigos: un choque es rarísimo, pero se reintenta por las dudas.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { rows } = await db.query(
        `INSERT INTO reservations
           (owner_id, code, customer_name, customer_phone, party_size, reserve_date, reserve_time, status, source, table_label, notes, internal_notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${COLUMNS}`,
        [
          ownerId, randomPairingCode(), fields.name, fields.phone, fields.partySize, fields.date, fields.time,
          fields.status, fields.source, fields.tableLabel ?? null, fields.notes ?? null, fields.internalNotes ?? null,
        ]
      );
      return rows[0];
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new ReservationsError(500, "No pudimos generar el código de reserva. Intentá de nuevo.");
};

/**
 * Reserva pedida por el cliente desde la landing: queda pendiente.
 */
const createFromWeb = async (ownerId, settingsRow, body, now = new Date()) => {
  const settings = toSettingsDTO(settingsRow);
  if (!settings.enabled) throw new ReservationsError(403, "Este local no recibe reservas online.", "RESERVATIONS_OFF");

  const fields = {
    name: requiredText(body.name, LIMITS.nameLength, "El nombre"),
    phone: parsePhone(body.phone, settings.phoneMode),
    partySize: parsePartySize(body.partySize, settings.maxPartySize),
    date: parseDate(body.date),
    time: parseTime(body.time),
    notes: cleanText(body.notes, LIMITS.notesLength, "Las aclaraciones"),
    status: "pending",
    source: "web",
  };
  assertBookable(fields.date, fields.time, settings, now);

  const { rows } = await db.query(
    "SELECT count(*)::int AS total FROM reservations WHERE owner_id = $1 AND status IN ('pending', 'rejected')", [ownerId]
  );
  if (rows[0].total >= LIMITS.openPerOwner) {
    throw new ReservationsError(429, "El local tiene muchas reservas por responder. Escribinos por WhatsApp.");
  }

  const row = await insertReservation(ownerId, fields);
  notify(row);
  return row;
};

/**
 * Reserva cargada a mano por el local (ej. atendida por WhatsApp). Por
 * defecto entra confirmada, y el panel le muestra el código para pasárselo
 * al cliente.
 */
const createManual = async (ownerId, settingsRow, body) => {
  const settings = toSettingsDTO(settingsRow);
  const status = body.status === "pending" ? "pending" : "confirmed";
  const row = await insertReservation(ownerId, {
    name: requiredText(body.name, LIMITS.nameLength, "El nombre"),
    // En la carga manual el teléfono siempre es opcional.
    phone: parsePhone(body.phone, "optional"),
    partySize: parsePartySize(body.partySize, Math.max(settings.maxPartySize, 100)),
    date: parseDate(body.date),
    time: parseTime(body.time),
    notes: cleanText(body.notes, LIMITS.notesLength, "Las aclaraciones"),
    internalNotes: cleanText(body.internalNotes, LIMITS.notesLength, "La nota interna"),
    tableLabel: status === "confirmed" ? cleanText(body.tableLabel, LIMITS.tableLabelLength, "La mesa") : null,
    status,
    source: "manual",
  });
  notify(row);
  return row;
};

// UPDATE de columnas permitidas. Se condiciona al estado que se leyó: si en el
// medio cambió (el cliente canceló mientras el local confirmaba), no pisa.
const applyUpdate = async (row, update) => {
  const entries = Object.entries(update).filter(([key]) => UPDATABLE.includes(key));
  if (entries.length === 0) return row;
  const sets = entries.map(([key], index) => `${key} = $${index + 3}`);
  const { rows } = await db.query(
    `UPDATE reservations SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 AND status = $2
     RETURNING ${COLUMNS}`,
    [row.id, row.status, ...entries.map(([, value]) => value)]
  );
  if (!rows[0]) {
    throw new ReservationsError(409, "La reserva cambió mientras la editabas. Actualizá la pantalla.", "CONFLICT");
  }
  notify(rows[0]);
  return rows[0];
};

const runOwnerAction = async (ownerId, id, action, body) => {
  const row = await findOwned(ownerId, id);
  return applyUpdate(row, ownerAction(row, action, body ?? {}));
};

const runCustomerAction = async (rawCode, action) => {
  const row = await findByCode(rawCode);
  if (!row) throw new ReservationsError(404, "No encontramos una reserva con ese código.");
  return applyUpdate(row, customerAction(row, action));
};

// Edición de datos de una reserva abierta (hora, mesa, cantidad…).
const updateDetails = async (ownerId, id, body = {}, settingsRow) => {
  const row = await findOwned(ownerId, id);
  if (!["pending", "confirmed"].includes(row.status)) {
    throw new ReservationsError(409, "Solo se pueden editar reservas pendientes o confirmadas.", "INVALID_TRANSITION");
  }
  const settings = toSettingsDTO(settingsRow);
  const update = {};
  if (body.name !== undefined) update.customer_name = requiredText(body.name, LIMITS.nameLength, "El nombre");
  if (body.phone !== undefined) update.customer_phone = parsePhone(body.phone, "optional");
  if (body.partySize !== undefined) update.party_size = parsePartySize(body.partySize, Math.max(settings.maxPartySize, 100));
  if (body.date !== undefined) update.reserve_date = parseDate(body.date);
  if (body.time !== undefined) update.reserve_time = parseTime(body.time);
  if (body.tableLabel !== undefined) update.table_label = cleanText(body.tableLabel, LIMITS.tableLabelLength, "La mesa");
  if (body.internalNotes !== undefined) update.internal_notes = cleanText(body.internalNotes, LIMITS.notesLength, "La nota interna");
  return applyUpdate(row, update);
};

module.exports = {
  getOrCreateSettings,
  findSettings,
  updateSettings,
  toSettingsDTO,
  toOwnerDTO,
  toCustomerDTO,
  findByCode,
  findOwned,
  listForOwner,
  countPending,
  createFromWeb,
  createManual,
  runOwnerAction,
  runCustomerAction,
  updateDetails,
};
