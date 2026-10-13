// Registro de juegos. Cada juego es un módulo de ./definitions con:
//
//   id                           clave con la que se guarda su configuración
//   defaults()                   su configuración inicial (apagado)
//   normalize(input, current)    valida un cambio parcial sobre la actual
//   toPublic(config, context)    lo que recibe la carta del comensal, o null
//                                si hoy no se puede jugar
//   poolOf?(config)              de dónde salen sus productos participantes
//                                (por defecto, config.pool)
//
// Para sumar un juego: crear su módulo y agregarlo a esta lista. La
// configuración, los endpoints y la vista pública lo toman de acá.

const GAMES = [
  require("./definitions/roulette"),
  require("./definitions/questions"),
  require("./definitions/duel"),
];

const byId = new Map(GAMES.map((game) => [game.id, game]));

const getGame = (id) => byId.get(id) ?? null;

const poolOf = (game, config) => (game.poolOf ? game.poolOf(config) : config.pool);

module.exports = { GAMES, getGame, poolOf };
