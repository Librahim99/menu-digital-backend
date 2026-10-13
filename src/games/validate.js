const mongoose = require("mongoose");
const { GamesError } = require("./errors");
const { LIMITS } = require("./constants");

// Validación de la configuración de los juegos que llega del panel. Todo lo
// que no cumpla corta con 400 y un mensaje claro.

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const object = (value, message = "Configuración inválida.") => {
  if (!isPlainObject(value)) throw new GamesError(400, message);
  return value;
};

const boolean = (value, fallback, field) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new GamesError(400, `${field}: valor inválido.`);
  return value;
};

const integer = (value, fallback, { min, max, field }) => {
  if (value === undefined) return fallback;
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new GamesError(400, `${field} tiene que ser entre ${min} y ${max}.`);
  }
  return number;
};

// Texto de una línea, sin espacios de más. "" si viene vacío.
const text = (value, fallback, { max, field }) => {
  if (value === undefined) return fallback;
  if (value === null) return "";
  if (typeof value !== "string") throw new GamesError(400, `${field}: texto inválido.`);
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length > max) throw new GamesError(400, `${field} no puede superar ${max} caracteres.`);
  return trimmed;
};

// Lista de ids de Mongo (categorías o productos), sin repetidos.
const idList = (value, fallback, { max, field }) => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > max) throw new GamesError(400, `${field}: lista inválida.`);
  const ids = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !mongoose.isValidObjectId(id)) throw new GamesError(400, `${field}: lista inválida.`);
    ids.add(id);
  }
  return [...ids];
};

const EMPTY_POOL = Object.freeze({ categoryIds: [], excludedItemIds: [] });

/**
 * Productos que participan de un juego: las categorías elegidas (vacío =
 * todas) menos los productos excluidos uno por uno.
 */
const pool = (value, fallback = EMPTY_POOL) => {
  if (value === undefined) return { categoryIds: [...fallback.categoryIds], excludedItemIds: [...fallback.excludedItemIds] };
  object(value, "Productos participantes: configuración inválida.");
  return {
    categoryIds: idList(value.categoryIds, fallback.categoryIds, { max: LIMITS.poolCategories, field: "Categorías participantes" }),
    excludedItemIds: idList(value.excludedItemIds, fallback.excludedItemIds, { max: LIMITS.poolExcludedItems, field: "Productos excluidos" }),
  };
};

module.exports = { isPlainObject, object, boolean, integer, text, idList, pool, EMPTY_POOL };
