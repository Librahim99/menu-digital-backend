// Configuración del módulo por local y sus mesas (con el QR de cada una).
//
// Todo vive en una sola fila de order_settings. Las opciones "de siempre"
// tienen su columna; las nuevas van en order_settings.options (jsonb) y se
// declaran acá abajo en OPTIONS, con su validación y su valor por defecto:
// agregar una configuración no requiere migrar la base.

const { query, withTransaction } = require("../db/sql");
const { randomToken } = require("../utils/tokens");
const { OrdersError } = require("../errors");
const { LIMITS } = require("../constants");
const { parseShiftSchedule } = require("../utils/validate");

const booleanOption = (fallback) => ({
  default: fallback,
  parse: (value) => {
    if (typeof value !== "boolean") throw new OrdersError(400, "Configuración inválida.");
    return value;
  },
});

const intOption = (fallback, min, max, message) => ({
  default: fallback,
  parse: (value) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new OrdersError(400, message);
    return number;
  },
});

const enumOption = (fallback, values) => ({
  default: fallback,
  parse: (value) => {
    if (!values.includes(value)) throw new OrdersError(400, "Configuración inválida.");
    return value;
  },
});

// Opciones extensibles (claves de order_settings.options).
const OPTIONS = {
  // Con QR general: si es false el comensal puede pedir sin indicar mesa
  // (el pedido entra como "Barra").
  requireTableNumber: booleanOption(true),
  // Espera mínima entre dos pedidos del mismo dispositivo del comensal.
  customerOrderCooldownSeconds: intOption(
    LIMITS.customerCooldownMs / 1000, 0, 600, "La espera entre pedidos tiene que ser entre 0 y 600 segundos."
  ),
  // Pedidos de take away / delivery pagados online con Mercado Pago desde la
  // carta pública (requiere tener la cuenta de MP conectada).
  onlineOrdering: booleanOption(false),
  // Con el pago online activo, saca «Pedir por WhatsApp» del carrito de la carta.
  // Solo tiene efecto si el pago online está funcionando (ver getOnlineConfig).
  hideWhatsappOrder: booleanOption(false),
  // Tiempo estimado de preparación de los pedidos online (minutos). 0 = sin estimación.
  // Se cargan los dos o ninguno (ver updateSettings).
  prepMinMinutes: intOption(0, 0, 600, "El tiempo mínimo tiene que ser entre 0 y 600 minutos."),
  prepMaxMinutes: intOption(0, 0, 600, "El tiempo máximo tiene que ser entre 0 y 600 minutos."),

  // ── Delivery / repartidores (ver orders/delivery/) ──
  // Apagado: el local gestiona sus envíos por fuera y el flujo de siempre no cambia.
  deliveryEnabled: booleanOption(false),
  // manual: el administrador elige al repartidor · open: lista compartida y los
  // repartidores disponibles toman los pedidos.
  deliveryAssignMode: enumOption("manual", ["manual", "open"]),
  // Quién puede marcar la entrega: solo el repartidor (con el código del cliente)
  // o también el administrador.
  deliveryConfirmBy: enumOption("courier", ["courier", "courier_admin"]),
  // Excepción para resolver incidencias: el administrador entrega sin código,
  // con motivo obligatorio y queda auditado (aunque confirmBy sea "courier").
  deliveryAdminOverride: booleanOption(false),
};

// Opciones guardadas + valores por defecto de las que no se guardaron.
const optionsOf = (row) => {
  const stored = row?.options && typeof row.options === "object" ? row.options : {};
  return Object.fromEntries(Object.entries(OPTIONS).map(([key, option]) => [
    key, stored[key] === undefined ? option.default : stored[key],
  ]));
};

const parseOptions = (current, body) => {
  if (body === undefined) return current;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OrdersError(400, "Configuración inválida.");
  const next = { ...current };
  for (const [key, value] of Object.entries(body)) {
    if (!OPTIONS[key]) throw new OrdersError(400, "Configuración desconocida.");
    next[key] = OPTIONS[key].parse(value);
  }
  return next;
};

const toSettingsDTO = (row) => ({
  qrMode: row.qr_mode,
  customerOrdering: row.customer_ordering,
  customerHistory: row.customer_history,
  tableCount: row.table_count,
  periodMode: row.period_mode,
  shiftSchedule: row.shift_schedule ?? [],
  options: optionsOf(row),
  generalQrToken: row.general_qr_token,
  updatedAt: row.updated_at,
});

// Deja activas exactamente las mesas 1..tableCount (crea las que falten con
// su token) y desactiva las demás sin borrarlas.
const syncTables = async (client, ownerId, tableCount) => {
  const { rows } = await client.query("SELECT number FROM order_tables WHERE owner_id = $1", [ownerId]);
  const existing = new Set(rows.map((row) => row.number));
  for (let number = 1; number <= tableCount; number += 1) {
    if (!existing.has(number)) {
      await client.query(
        "INSERT INTO order_tables (owner_id, number, qr_token) VALUES ($1, $2, $3) ON CONFLICT (owner_id, number) DO NOTHING",
        [ownerId, number, randomToken()]
      );
    }
  }
  await client.query(
    "UPDATE order_tables SET active = (number <= $2) WHERE owner_id = $1",
    [ownerId, tableCount]
  );
};

// Configuración del local; la crea con valores por defecto la primera vez.
const getOrCreateSettings = async (ownerId) => {
  const found = await query("SELECT * FROM order_settings WHERE owner_id = $1", [ownerId]);
  if (found.rows[0]) return found.rows[0];

  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO order_settings (owner_id, general_qr_token) VALUES ($1, $2)
       ON CONFLICT (owner_id) DO NOTHING RETURNING *`,
      [ownerId, randomToken()]
    );
    if (inserted.rows[0]) {
      await syncTables(client, ownerId, inserted.rows[0].table_count);
      return inserted.rows[0];
    }
    // Otra request lo creó en paralelo.
    const again = await client.query("SELECT * FROM order_settings WHERE owner_id = $1", [ownerId]);
    return again.rows[0];
  });
};

// Solo lectura: null si el local nunca configuró el módulo.
const findSettings = async (ownerId) => {
  const { rows } = await query("SELECT * FROM order_settings WHERE owner_id = $1", [ownerId]);
  return rows[0] ?? null;
};

const updateSettings = async (ownerId, body = {}) => {
  const current = await getOrCreateSettings(ownerId);
  const next = {
    qr_mode: current.qr_mode,
    customer_ordering: current.customer_ordering,
    customer_history: current.customer_history,
    table_count: current.table_count,
    period_mode: current.period_mode,
    shift_schedule: current.shift_schedule ?? [],
  };

  if (body.qrMode !== undefined) {
    if (!["general", "per_table"].includes(body.qrMode)) throw new OrdersError(400, "Tipo de QR inválido.");
    next.qr_mode = body.qrMode;
  }
  for (const [key, column] of [["customerOrdering", "customer_ordering"], ["customerHistory", "customer_history"]]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") throw new OrdersError(400, "Configuración inválida.");
      next[column] = body[key];
    }
  }
  if (body.tableCount !== undefined) {
    const count = Number(body.tableCount);
    if (!Number.isSafeInteger(count) || count < 1 || count > LIMITS.maxTables) {
      throw new OrdersError(400, `La cantidad de mesas tiene que ser entre 1 y ${LIMITS.maxTables}.`);
    }
    next.table_count = count;
  }
  if (body.periodMode !== undefined) {
    if (!["shift", "day"].includes(body.periodMode)) throw new OrdersError(400, "Período inválido.");
    next.period_mode = body.periodMode;
  }
  if (body.shiftSchedule !== undefined) {
    next.shift_schedule = parseShiftSchedule(body.shiftSchedule);
  }
  const options = parseOptions(optionsOf(current), body.options);
  if ((options.prepMinMinutes > 0) !== (options.prepMaxMinutes > 0)) {
    throw new OrdersError(400, "Cargá el tiempo mínimo y el máximo, o dejá los dos en 0.");
  }
  if (options.prepMaxMinutes < options.prepMinMinutes) {
    throw new OrdersError(400, "El tiempo máximo no puede ser menor que el mínimo.");
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE order_settings SET qr_mode = $2, customer_ordering = $3, customer_history = $4,
         table_count = $5, period_mode = $6, shift_schedule = $7::jsonb, options = $8::jsonb, updated_at = now()
       WHERE owner_id = $1 RETURNING *`,
      [ownerId, next.qr_mode, next.customer_ordering, next.customer_history,
        next.table_count, next.period_mode, JSON.stringify(next.shift_schedule), JSON.stringify(options)]
    );
    if (next.table_count !== current.table_count) await syncTables(client, ownerId, next.table_count);
    return rows[0];
  });
};

const listTables = async (ownerId) => {
  const { rows } = await query(
    "SELECT number, qr_token FROM order_tables WHERE owner_id = $1 AND active ORDER BY number",
    [ownerId]
  );
  return rows.map((row) => ({ number: row.number, qrToken: row.qr_token }));
};

// Invalida QRs impresos: el general, una mesa o todas.
const regenerateQr = async (ownerId, target) => {
  await getOrCreateSettings(ownerId);
  if (target === "general") {
    await query("UPDATE order_settings SET general_qr_token = $2, updated_at = now() WHERE owner_id = $1", [ownerId, randomToken()]);
    return;
  }
  if (target === "all") {
    const { rows } = await query("SELECT id FROM order_tables WHERE owner_id = $1", [ownerId]);
    for (const row of rows) {
      await query("UPDATE order_tables SET qr_token = $2 WHERE id = $1", [row.id, randomToken()]);
    }
    return;
  }
  const number = Number(target);
  if (!Number.isSafeInteger(number) || number < 1) throw new OrdersError(400, "Mesa inválida.");
  const { rowCount } = await query(
    "UPDATE order_tables SET qr_token = $3 WHERE owner_id = $1 AND number = $2",
    [ownerId, number, randomToken()]
  );
  if (rowCount === 0) throw new OrdersError(404, "Esa mesa no existe.");
};

/**
 * Resuelve el token de un QR escaneado en la carta.
 * @returns {{ kind: "table", tableNumber } | { kind: "general" } | null}
 */
const resolveQrToken = async (settings, token) => {
  if (!settings || typeof token !== "string") return null;
  if (token === settings.general_qr_token) return { kind: "general" };
  const { rows } = await query(
    "SELECT number FROM order_tables WHERE owner_id = $1 AND qr_token = $2 AND active",
    [settings.owner_id, token]
  );
  return rows[0] ? { kind: "table", tableNumber: rows[0].number } : null;
};

module.exports = {
  optionsOf,
  toSettingsDTO,
  getOrCreateSettings,
  findSettings,
  updateSettings,
  listTables,
  regenerateQr,
  resolveQrToken,
};
