const { ReservationsError } = require("../errors");
const { LIMITS, PHONE_MODES } = require("../constants");

// Validación de lo que llega del cliente. Todo lo que no cumpla corta con 400
// y un mensaje claro.

// Buenos Aires es UTC-3 todo el año (ver utils/dates.js).
const BA_OFFSET = "-03:00";

const cleanText = (value, max, field = "El texto") => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ReservationsError(400, `${field} es inválido.`);
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new ReservationsError(400, `${field} no puede superar ${max} caracteres.`);
  return trimmed;
};

const requiredText = (value, max, field) => {
  const text = cleanText(value, max, field);
  if (!text) throw new ReservationsError(400, `${field} es obligatorio.`);
  return text;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isValidDate = (value) => {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
};

const parseDate = (value, field = "La fecha") => {
  if (!isValidDate(value)) throw new ReservationsError(400, `${field} es inválida.`);
  return value;
};

const parseTime = (value, field = "El horario") => {
  if (typeof value !== "string" || !TIME_RE.test(value)) throw new ReservationsError(400, `${field} es inválido.`);
  return value;
};

const parsePartySize = (value, max) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new ReservationsError(400, "Indicá la cantidad de personas.");
  }
  if (number > max) {
    throw new ReservationsError(400, `Para grupos de más de ${max} personas, escribinos por WhatsApp.`);
  }
  return number;
};

// Teléfono: solo dígitos, espacios y + - ( ). Se guarda tal cual lo tipeó.
const parsePhone = (value, mode) => {
  const text = cleanText(value, LIMITS.phoneLength, "El teléfono");
  if (mode === "off") return null;
  if (!text) {
    if (mode === "required") throw new ReservationsError(400, "Ingresá un teléfono de contacto.");
    return null;
  }
  const digits = text.replace(/\D/g, "");
  if (!/^[\d\s+()-]+$/.test(text) || digits.length < 6 || digits.length > 15) {
    throw new ReservationsError(400, "El teléfono es inválido.");
  }
  return text;
};

const parseId = (value) => {
  const number = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new ReservationsError(400, "Identificador inválido.");
  return number;
};

// Ahora, en horario de Buenos Aires: { date: "YYYY-MM-DD", time: "HH:MM" }.
const baFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

const buenosAiresNow = (now = new Date()) => {
  const parts = Object.fromEntries(baFormatter.formatToParts(now).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};

// Instante real de una fecha+hora "de pared" de Buenos Aires.
const toInstant = (date, time) => new Date(`${date}T${time}:00${BA_OFFSET}`);

const addDays = (date, days) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/**
 * Valida que fecha+hora sean un momento futuro razonable según la
 * configuración del local (anticipación mínima y días hacia adelante).
 */
const assertBookable = (date, time, settings, now = new Date()) => {
  const instant = toInstant(date, time);
  if (instant.getTime() < now.getTime() + settings.minNoticeMinutes * 60_000) {
    throw new ReservationsError(
      400,
      settings.minNoticeMinutes > 0
        ? "Ese horario ya no está disponible. Elegí uno más adelante o escribinos por WhatsApp."
        : "Esa fecha y hora ya pasaron."
    );
  }
  const limit = addDays(buenosAiresNow(now).date, settings.maxDaysAhead);
  if (date > limit) {
    throw new ReservationsError(400, `Solo se puede reservar con hasta ${settings.maxDaysAhead} días de anticipación.`);
  }
};

const parseSettingsPatch = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ReservationsError(400, "Configuración inválida.");
  const patch = {};
  const int = (key, min, max, message) => {
    if (body[key] === undefined) return;
    const number = Number(body[key]);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new ReservationsError(400, message);
    patch[key] = number;
  };

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new ReservationsError(400, "Configuración inválida.");
    patch.enabled = body.enabled;
  }
  if (body.phoneMode !== undefined) {
    if (!PHONE_MODES.includes(body.phoneMode)) throw new ReservationsError(400, "Configuración inválida.");
    patch.phoneMode = body.phoneMode;
  }
  int("maxPartySize", 1, 100, "El máximo de personas tiene que ser entre 1 y 100.");
  int("maxDaysAhead", 1, 365, "Los días de anticipación tienen que ser entre 1 y 365.");
  int("minNoticeMinutes", 0, 10080, "La anticipación mínima tiene que ser entre 0 y 10080 minutos.");
  return patch;
};

module.exports = {
  cleanText,
  requiredText,
  parseDate,
  parseTime,
  parsePartySize,
  parsePhone,
  parseId,
  parseSettingsPatch,
  buenosAiresNow,
  toInstant,
  addDays,
  assertBookable,
};
