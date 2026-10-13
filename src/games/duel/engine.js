// Duelo de la carta: armado de las rondas y puntaje. Funciones puras: reciben
// los productos del local y un generador de azar (así se prueban con un azar
// fijo) y no conocen salas, sockets ni la base.
//
// Cada ronda es una pregunta de opción múltiple sobre la carta real:
//   pricier      "¿Cuál sale más?" entre varios productos
//   price        "¿Cuánto sale X?" entre cuatro precios
//   category     "¿En qué parte de la carta está X?"
//   description  "¿Qué producto es?" a partir de su descripción
// Con los precios ocultos (configuración de la carta) no hay rondas de precios.

const { LIMITS } = require("../constants");

const money = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 });
const formatPrice = (value) => `$${money.format(value)}`;

const shuffle = (list, rng) => {
  const result = [...list];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
};

const hasPrice = (product) => typeof product.price === "number" && product.price > 0;

// Primero los que todavía no salieron en la partida.
const freshFirst = (products, used, rng) => {
  const mixed = shuffle(products, rng);
  return [...mixed.filter((product) => !used.has(product.id)), ...mixed.filter((product) => used.has(product.id))];
};

// Opciones mezcladas + cuál es la correcta.
const withOptions = (round, correctLabel, otherLabels, rng) => {
  const options = shuffle([correctLabel, ...otherLabels], rng);
  return { ...round, options, correct: options.indexOf(correctLabel) };
};

const stepOf = (price) => {
  if (price >= 10_000) return 500;
  if (price >= 2_000) return 100;
  if (price >= 500) return 50;
  return 10;
};

const PRICE_FACTORS = [0.6, 0.75, 0.85, 1.15, 1.25, 1.4, 1.6];

const BUILDERS = {
  pricier: (products, rng, used) => {
    const candidates = freshFirst(products.filter(hasPrice), used, rng);
    // El más caro de la ronda es su protagonista: se elige primero (uno que no
    // haya salido, si queda) y se lo acompaña con otros más baratos.
    for (const top of candidates) {
      const cheaper = [];
      for (const product of candidates) {
        if (product.price < top.price && !cheaper.some((other) => other.price === product.price)) cheaper.push(product);
        if (cheaper.length === LIMITS.duelOptions - 1) break;
      }
      if (cheaper.length === 0) continue;
      return withOptions(
        { type: "pricier", prompt: "¿Cuál sale más?", itemId: top.id },
        top.title, cheaper.map((product) => product.title), rng,
      );
    }
    return null;
  },

  price: (products, rng, used) => {
    // El primero al que se le puedan armar tres precios falsos distintos (a un
    // producto muy barato no siempre se puede).
    for (const product of freshFirst(products.filter(hasPrice), used, rng)) {
      const step = stepOf(product.price);
      const decoys = [];
      for (const factor of shuffle(PRICE_FACTORS, rng)) {
        const value = Math.round((product.price * factor) / step) * step;
        if (value > 0 && value !== product.price && !decoys.includes(value)) decoys.push(value);
        if (decoys.length === LIMITS.duelOptions - 1) break;
      }
      if (decoys.length < LIMITS.duelOptions - 1) continue;
      return withOptions(
        { type: "price", prompt: `¿Cuánto sale ${product.title}?`, itemId: product.id },
        formatPrice(product.price), decoys.map(formatPrice), rng,
      );
    }
    return null;
  },

  category: (products, rng, used) => {
    const titles = [...new Set(products.map((product) => product.categoryTitle).filter(Boolean))];
    if (titles.length < 2) return null;
    const product = freshFirst(products.filter((entry) => entry.categoryTitle), used, rng)[0];
    const others = shuffle(titles.filter((title) => title !== product.categoryTitle), rng).slice(0, LIMITS.duelOptions - 1);
    return withOptions(
      { type: "category", prompt: `¿En qué parte de la carta está ${product.title}?`, itemId: product.id },
      product.categoryTitle, others, rng,
    );
  },

  description: (products, rng, used) => {
    // Sirve la descripción que no delata el nombre del producto.
    const describable = products.filter((product) => {
      const description = (product.description ?? "").trim();
      return description.length >= LIMITS.duelDescriptionMin
        && !description.toLowerCase().includes(product.title.toLowerCase());
    });
    const product = freshFirst(describable, used, rng)[0];
    const others = shuffle(
      [...new Set(products.filter((entry) => entry.title !== product?.title).map((entry) => entry.title))], rng,
    ).slice(0, LIMITS.duelOptions - 1);
    if (!product || others.length < 2) return null;
    const description = product.description.trim();
    return withOptions(
      {
        type: "description",
        prompt: "¿Qué producto es?",
        detail: description.length > LIMITS.duelDescriptionMax ? `${description.slice(0, LIMITS.duelDescriptionMax - 1)}…` : description,
        itemId: product.id,
      },
      product.title, others, rng,
    );
  },
};

const PRICE_TYPES = ["pricier", "price"];

// Tipos de ronda que se pueden armar con estos productos.
const playableTypes = (products, { hidePrices = false } = {}) =>
  Object.keys(BUILDERS)
    .filter((type) => !(hidePrices && PRICE_TYPES.includes(type)))
    .filter((type) => BUILDERS[type](products, () => 0, new Set()) !== null);

const canPlay = (products, options) => products.length >= 2 && playableTypes(products, options).length > 0;

/**
 * Rondas de una partida. Alterna los tipos posibles y evita repetir el
 * producto protagonista mientras queden otros.
 * @param {Array<{id, title, categoryTitle, price, description}>} products
 * @param {{ rounds: number, hidePrices?: boolean, rng?: () => number }} options
 * @returns {Array<{type, prompt, detail?, options: string[], correct: number, itemId: string}>}
 *          vacío si con esta carta no se puede jugar
 */
const buildRounds = (products, { rounds, hidePrices = false, rng = Math.random }) => {
  const types = playableTypes(products, { hidePrices });
  if (products.length < 2 || types.length === 0) return [];
  const used = new Set();
  const result = [];
  let order = [];
  // Tope de intentos: un tipo que se pudo armar al chequear siempre se puede
  // volver a armar, pero una partida nunca debe quedar colgada armando rondas.
  for (let attempt = 0; result.length < rounds && attempt < rounds * 10; attempt += 1) {
    if (order.length === 0) order = shuffle(types, rng);
    const type = order.shift();
    if (used.size >= products.length) used.clear();
    const round = BUILDERS[type](products, rng, used);
    if (!round) continue;
    used.add(round.itemId);
    result.push(round);
  }
  return result;
};

const MAX_POINTS = 1000;
const BASE_POINTS = 500;

// Acertar vale la mitad; la otra mitad premia la velocidad (más puntos cuanto antes).
const scoreAnswer = ({ correct, elapsedMs, totalMs }) => {
  if (!correct) return 0;
  const left = Math.max(0, Math.min(1, 1 - elapsedMs / totalMs));
  return BASE_POINTS + Math.round((MAX_POINTS - BASE_POINTS) * left);
};

module.exports = { buildRounds, canPlay, playableTypes, scoreAnswer, shuffle, formatPrice, MAX_POINTS };
