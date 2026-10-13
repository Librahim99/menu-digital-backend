// Preguntas para compartir: juego social para citas, parejas y grupos. Un mazo
// de preguntas por categoría y, cada tanto, un desafío con un producto real
// del local ("pidan X para compartir") con su botón para sumarlo al pedido.

const crypto = require("crypto");
const { LIMITS, DEFAULT_DECK } = require("../constants");
const { GamesError } = require("../errors");
const v = require("../validate");

const id = "questions";

const defaults = () => ({
  enabled: false,
  categories: DEFAULT_DECK.map((category) => ({
    id: category.id, name: category.name, enabled: true, questions: [...category.questions],
  })),
  challenges: {
    enabled: true,
    // Un desafío cada tantas preguntas.
    every: 4,
    pool: { ...v.EMPTY_POOL },
  },
});

const CATEGORY_ID_RE = /^[a-z0-9-]{1,40}$/;

// El mazo completo como lo deja el local: se reemplaza entero (así se pueden
// borrar, renombrar y reordenar categorías y preguntas).
const normalizeCategories = (value, current) => {
  if (value === undefined) return current;
  if (!Array.isArray(value) || value.length > LIMITS.questionCategories) {
    throw new GamesError(400, `Podés tener hasta ${LIMITS.questionCategories} categorías de preguntas.`);
  }
  const ids = new Set();
  return value.map((entry) => {
    v.object(entry, "Categoría de preguntas inválida.");
    const name = v.text(entry.name, "", { max: LIMITS.questionCategoryNameLength, field: "Nombre de la categoría" });
    if (!name) throw new GamesError(400, "Cada categoría de preguntas necesita un nombre.");
    if (!Array.isArray(entry.questions) || entry.questions.length > LIMITS.questionsPerCategory) {
      throw new GamesError(400, `"${name}" puede tener hasta ${LIMITS.questionsPerCategory} preguntas.`);
    }
    // Sin vacías ni repetidas (se cargan de a una por renglón).
    const questions = [...new Set(entry.questions
      .map((question) => v.text(question, "", { max: LIMITS.questionLength, field: `Una pregunta de "${name}"` }))
      .filter(Boolean))];
    let categoryId = typeof entry.id === "string" && CATEGORY_ID_RE.test(entry.id) ? entry.id : crypto.randomUUID().slice(0, 8);
    while (ids.has(categoryId)) categoryId = crypto.randomUUID().slice(0, 8);
    ids.add(categoryId);
    return { id: categoryId, name, enabled: v.boolean(entry.enabled, true, name), questions };
  });
};

const normalize = (input, current) => {
  const challenges = input.challenges === undefined ? {} : v.object(input.challenges, "Desafíos: configuración inválida.");
  return {
    enabled: v.boolean(input.enabled, current.enabled, "Preguntas para compartir"),
    categories: normalizeCategories(input.categories, current.categories),
    challenges: {
      enabled: v.boolean(challenges.enabled, current.challenges.enabled, "Desafíos"),
      every: v.integer(challenges.every, current.challenges.every, {
        min: LIMITS.challengeEveryMin, max: LIMITS.challengeEveryMax, field: "Cada cuántas preguntas va un desafío",
      }),
      pool: v.pool(challenges.pool, current.challenges.pool),
    },
  };
};

// null: no hay ninguna categoría activa con preguntas.
const toPublic = (config, { products }) => {
  const categories = config.categories
    .filter((category) => category.enabled && category.questions.length > 0)
    .map(({ id: categoryId, name, questions }) => ({ id: categoryId, name, questions }));
  if (categories.length === 0) return null;
  const withChallenges = config.challenges.enabled && products.length > 0;
  return {
    categories,
    challenges: withChallenges ? { every: config.challenges.every, itemIds: products.map((product) => product.id) } : null,
  };
};

// Los productos de este juego son los de sus desafíos.
const poolOf = (config) => config.challenges.pool;

module.exports = { id, defaults, normalize, toPublic, poolOf };
