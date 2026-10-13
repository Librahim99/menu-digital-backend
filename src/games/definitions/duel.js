// Duelo de la carta: juego competitivo multijugador. Cada uno desde su
// celular responde rondas cortas de opción múltiple armadas con la carta real
// del local; suma más quien acierta y más rápido. Las partidas las lleva el
// servidor (ver duel/engine.js, duel/rooms.js y realtime.js).

const { LIMITS } = require("../constants");
const v = require("../validate");
const { canPlay } = require("../duel/engine");

const id = "duel";

const defaults = () => ({
  enabled: false,
  rounds: 5,
  // Segundos para responder cada ronda.
  seconds: 15,
  pool: { ...v.EMPTY_POOL },
  // Premio para quien gana, si el local quiere ofrecer uno (ej. "un café de regalo").
  prizeText: "",
});

const normalize = (input, current) => ({
  enabled: v.boolean(input.enabled, current.enabled, "Duelo de la carta"),
  rounds: v.integer(input.rounds, current.rounds, { min: LIMITS.duelRoundsMin, max: LIMITS.duelRoundsMax, field: "Rondas" }),
  seconds: v.integer(input.seconds, current.seconds, {
    min: LIMITS.duelSecondsMin, max: LIMITS.duelSecondsMax, field: "Segundos por ronda",
  }),
  pool: v.pool(input.pool, current.pool),
  prizeText: v.text(input.prizeText, current.prizeText, { max: LIMITS.promoLength, field: "Premio del duelo" }),
});

// null: con esta carta no se pueden armar rondas (muy pocos productos).
const toPublic = (config, { products, hidePrices }) => (canPlay(products, { hidePrices }) ? {
  rounds: config.rounds,
  seconds: config.seconds,
  prizeText: config.prizeText,
  minPlayers: LIMITS.duelPlayersMin,
  maxPlayers: LIMITS.duelPlayersMax,
} : null);

module.exports = { id, defaults, normalize, toPublic };
