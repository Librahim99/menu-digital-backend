// Configuración de los juegos de un local: qué juegos están habilitados y las
// opciones de cada uno. Se guarda en MongoDB (GameSettings), una por local.
//
// Lo guardado puede ser de una versión anterior (un juego nuevo todavía sin
// configurar, una opción que no existía): `resolve` siempre devuelve la
// configuración completa, con los valores por defecto de lo que falte.

const GameSettings = require("../models/GameSettings");
const { GAMES, poolOf } = require("./registry");
const { filterPool } = require("./catalog");
const v = require("./validate");

const defaults = () => ({
  // true: los juegos se ofrecen solo a quien escaneó el QR del local.
  venueOnly: false,
  games: Object.fromEntries(GAMES.map((game) => [game.id, game.defaults()])),
});

/** Configuración completa a partir de lo guardado (o de nada). */
const resolve = (stored) => {
  const base = defaults();
  const saved = v.isPlainObject(stored) ? stored : {};
  const games = v.isPlainObject(saved.games) ? saved.games : {};
  return {
    venueOnly: saved.venueOnly === true,
    games: Object.fromEntries(GAMES.map((game) => {
      const current = base.games[game.id];
      if (!v.isPlainObject(games[game.id])) return [game.id, current];
      try {
        // Pasa por la misma validación: lo que falte toma su valor por defecto.
        return [game.id, game.normalize(games[game.id], current)];
      } catch {
        // Datos guardados que ya no son válidos: se ignoran, el juego queda como nuevo.
        return [game.id, current];
      }
    })),
  };
};

/**
 * Aplica un cambio parcial sobre la configuración actual.
 * @param {object} current  configuración completa
 * @param {object} body     { venueOnly?, games?: { [id]: cambios de ese juego } }
 */
const applyChanges = (current, body) => {
  v.object(body);
  const next = { venueOnly: v.boolean(body.venueOnly, current.venueOnly, "Solo en el local"), games: { ...current.games } };
  if (body.games !== undefined) {
    v.object(body.games);
    for (const game of GAMES) {
      if (body.games[game.id] === undefined) continue;
      next.games[game.id] = game.normalize(v.object(body.games[game.id]), current.games[game.id]);
    }
  }
  return next;
};

const getSettings = async (ownerId) => {
  const doc = await GameSettings.findOne({ userID: ownerId }).select("config").lean();
  return resolve(doc?.config);
};

const updateSettings = async (ownerId, body) => {
  const next = applyChanges(await getSettings(ownerId), body);
  await GameSettings.findOneAndUpdate(
    { userID: ownerId },
    { $set: { config: next } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return next;
};

/**
 * Lo que recibe la carta del comensal: solo los juegos habilitados que hoy se
 * pueden jugar, cada uno con lo justo para funcionar.
 * @param {object} settings  configuración completa
 * @param {{ products: Array, hidePrices: boolean }} context
 */
const toPublic = (settings, { products, hidePrices }) => {
  const games = [];
  for (const game of GAMES) {
    const config = settings.games[game.id];
    if (!config.enabled) continue;
    const view = game.toPublic(config, { products: filterPool(products, poolOf(game, config)), hidePrices });
    if (view) games.push({ id: game.id, ...view });
  }
  return { enabled: games.length > 0, venueOnly: settings.venueOnly, games };
};

module.exports = { defaults, resolve, applyChanges, getSettings, updateSettings, toPublic };
