const mongoose = require("mongoose");
const { OrdersError } = require("../errors");
const { LIMITS, SERVICE_TYPES } = require("../constants");

// Validación de lo que llega del cliente. Todo lo que no cumpla corta con
// 400 y un mensaje claro; nada de esto se confía para precios (ver
// services/menuCatalog.js).

const cleanText = (value, max) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new OrdersError(400, "Texto inválido.");
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new OrdersError(400, `El texto no puede superar ${max} caracteres.`);
  return trimmed;
};

const positiveInt = (value, { max, field }) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1 || (max && number > max)) {
    throw new OrdersError(400, `${field} inválido.`);
  }
  return number;
};

const optionalPositiveInt = (value, options) =>
  value === undefined || value === null || value === "" ? null : positiveInt(value, options);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const optionalUuid = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new OrdersError(400, "Identificador de envío inválido.");
  return value.toLowerCase();
};

// Líneas de un pedido: [{ itemId, option?, quantity, notes? }]
const parseOrderLines = (lines) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new OrdersError(400, "El pedido no tiene productos.");
  }
  if (lines.length > LIMITS.linesPerOrder) {
    throw new OrdersError(400, `Un pedido puede tener hasta ${LIMITS.linesPerOrder} líneas.`);
  }
  return lines.map((line) => {
    if (!line || typeof line !== "object") throw new OrdersError(400, "Producto inválido.");
    if (typeof line.itemId !== "string" || !mongoose.isValidObjectId(line.itemId)) {
      throw new OrdersError(400, "Producto inválido.");
    }
    return {
      itemId: line.itemId,
      option: cleanText(line.option, 80),
      quantity: positiveInt(line.quantity, { max: LIMITS.quantityPerLine, field: "Cantidad" }),
      notes: cleanText(line.notes, LIMITS.notesLength),
    };
  });
};

/**
 * Dónde se sirve el pedido y, para take away / delivery, los datos de quien
 * retira o recibe. Sin serviceType (clientes viejos) se deduce de la mesa.
 * @returns {{ serviceType, tableNumber, customer: { name, phone, address, deliveryNotes } }}
 */
const parseService = (body = {}, { tableCount, allowed = SERVICE_TYPES }) => {
  const serviceType = body.serviceType ?? (body.tableNumber ? "table" : "counter");
  if (!allowed.includes(serviceType)) throw new OrdersError(400, "Tipo de pedido inválido.");

  const tableNumber = serviceType === "table"
    ? positiveInt(body.tableNumber, { field: "Número de mesa", max: tableCount })
    : null;

  const withCustomer = serviceType === "takeaway" || serviceType === "delivery";
  const customer = {
    name: withCustomer ? cleanText(body.customerName, LIMITS.customerNameLength) : null,
    phone: withCustomer ? cleanText(body.customerPhone, LIMITS.customerPhoneLength) : null,
    address: serviceType === "delivery" ? cleanText(body.deliveryAddress, LIMITS.deliveryAddressLength) : null,
    deliveryNotes: withCustomer ? cleanText(body.deliveryNotes, LIMITS.deliveryNotesLength) : null,
  };
  return { serviceType, tableNumber, customer };
};

// Importe opcional (efectivo contado, fondo de caja): null si viene vacío.
const optionalMoney = (value, field) => {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1e10) throw new OrdersError(400, `${field} inválido.`);
  return Math.round(number * 100) / 100;
};

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Turnos configurados: [{ name, from: "HH:MM", to: "HH:MM" }]. Un turno que
// cruza la medianoche (20:00 → 02:00) es válido.
const parseShiftSchedule = (value) => {
  if (!Array.isArray(value)) throw new OrdersError(400, "Los turnos son inválidos.");
  if (value.length > LIMITS.shiftsInSchedule) {
    throw new OrdersError(400, `Podés configurar hasta ${LIMITS.shiftsInSchedule} turnos.`);
  }
  return value.map((shift) => {
    const name = cleanText(shift?.name, 40);
    if (!name) throw new OrdersError(400, "Cada turno necesita un nombre.");
    if (!HHMM_RE.test(shift?.from ?? "") || !HHMM_RE.test(shift?.to ?? "") || shift.from === shift.to) {
      throw new OrdersError(400, `Revisá el horario del turno "${name}".`);
    }
    return { name, from: shift.from, to: shift.to };
  });
};

module.exports = {
  cleanText,
  positiveInt,
  optionalPositiveInt,
  optionalUuid,
  parseOrderLines,
  parseService,
  optionalMoney,
  parseShiftSchedule,
};
