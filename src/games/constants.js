// Juegos para comensales: límites y contenido de base.

const LIMITS = {
  promoLength: 140,
  // Productos y categorías participantes de un juego.
  poolCategories: 200,
  poolExcludedItems: 1000,
  // Ruleta.
  roulettePicksMax: 3,
  // Preguntas para compartir.
  questionCategories: 12,
  questionCategoryNameLength: 40,
  questionsPerCategory: 80,
  questionLength: 200,
  challengeEveryMin: 2,
  challengeEveryMax: 12,
  // Duelo de la carta (multijugador).
  duelRoundsMin: 3,
  duelRoundsMax: 10,
  duelSecondsMin: 8,
  duelSecondsMax: 30,
  duelPlayersMin: 2,
  duelPlayersMax: 8,
  duelPlayerNameLength: 20,
  duelCodeLength: 5,
  duelRoomsPerVenue: 40,
  duelOptions: 4,
  duelDescriptionMin: 15,
  duelDescriptionMax: 160,
};

const DUEL_TIMING = {
  // Lo que se muestra la respuesta correcta antes de la ronda siguiente.
  revealMs: 5_000,
  // Una sala sin nadie conectado se descarta pasado este tiempo.
  emptyRoomMs: 2 * 60_000,
  // Una partida terminada (o una sala que nunca arrancó) no queda para siempre.
  finishedRoomMs: 15 * 60_000,
  lobbyRoomMs: 30 * 60_000,
};

// Mazo de base de "Preguntas para compartir". Es el punto de partida: cada
// local lo edita desde Configuración (y lo que guarda reemplaza a este).
const DEFAULT_DECK = [
  {
    id: "romper-el-hielo",
    name: "Para romper el hielo",
    questions: [
      "¿Cuál es la mejor comida que probaste en tu vida y dónde fue?",
      "Si pudieras cenar con cualquier persona, viva o no, ¿con quién sería?",
      "¿Qué plato te recuerda a tu infancia?",
      "¿Cuál fue el viaje que más disfrutaste?",
      "¿Qué canción no podés dejar de escuchar últimamente?",
      "¿Qué harías mañana si te dieran el día libre de sorpresa?",
      "¿Cuál es tu plan perfecto para un domingo?",
      "¿Qué serie o película recomendarías sin dudar?",
      "¿Dulce o salado? Defendé tu postura.",
      "¿Qué es lo más raro que comiste alguna vez?",
    ],
  },
  {
    id: "citas",
    name: "Para una cita",
    questions: [
      "¿Qué fue lo primero que pensaste cuando nos conocimos?",
      "¿Cuál es tu idea de una cita perfecta?",
      "¿Qué te hace reír siempre, sin falta?",
      "¿Qué lugar del mundo te gustaría conocer acompañado?",
      "¿Qué es algo que te apasiona y casi nadie sabe?",
      "¿Cuál fue el mejor regalo que te hicieron?",
      "¿Qué pequeño gesto te alegra el día?",
      "¿Qué aprendiste de tu última gran aventura?",
      "Si pudieras revivir un día de tu vida, ¿cuál elegirías?",
      "¿Qué te gustaría que hagamos juntos este año?",
    ],
  },
  {
    id: "amigos",
    name: "Entre amigos",
    questions: [
      "¿Quién de la mesa sobreviviría más tiempo en una isla desierta?",
      "¿Cuál es la anécdota del grupo que nunca falla?",
      "¿Quién es el que siempre llega tarde? ¿Y cuál fue su peor excusa?",
      "Si armáramos una banda, ¿qué haría cada uno?",
      "¿Cuál fue la peor decisión que tomamos juntos?",
      "¿Quién de la mesa pide siempre lo mismo?",
      "¿A quién de acá llamarías a las 3 de la mañana?",
      "¿Qué viaje tenemos pendiente como grupo?",
      "¿Quién sería el primero en hacerse famoso, y por qué?",
      "¿Cuál es el apodo más raro que tuvo alguien de la mesa?",
    ],
  },
  {
    id: "para-reirse",
    name: "Para reírse",
    questions: [
      "¿Cuál es tu combinación de comida más cuestionable?",
      "¿Qué superpoder inútil te gustaría tener?",
      "¿Cuál fue tu peor corte de pelo?",
      "Si fueras un plato de esta carta, ¿cuál serías?",
      "¿Qué es lo más vergonzoso que te pasó en un restaurante?",
      "¿Qué palabra usás demasiado?",
      "¿Cuál es tu talento oculto más ridículo?",
      "¿Qué moda del pasado te da vergüenza haber seguido?",
      "Si tu vida fuera una película, ¿cómo se llamaría?",
      "¿Cuál es la mentira piadosa que más decís?",
    ],
  },
];

module.exports = { LIMITS, DUEL_TIMING, DEFAULT_DECK };
