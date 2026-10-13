// Ruleta de menú: sortea productos reales del local para descubrir qué pedir.
// El sorteo lo hace el celular del comensal entre los productos que le manda
// el servidor (los que participan y se pueden pedir ahora).

const { LIMITS } = require("../constants");
const v = require("../validate");

const id = "roulette";

const defaults = () => ({
  enabled: false,
  // Cuántos productos salen por tirada (ej. 2: algo para comer y algo para tomar).
  picks: 1,
  pool: { ...v.EMPTY_POOL },
  // Texto libre que acompaña el resultado (ej. "Si pedís lo que salió, 10% off").
  promoText: "",
});

const normalize = (input, current) => ({
  enabled: v.boolean(input.enabled, current.enabled, "Ruleta"),
  picks: v.integer(input.picks, current.picks, { min: 1, max: LIMITS.roulettePicksMax, field: "Productos por tirada" }),
  pool: v.pool(input.pool, current.pool),
  promoText: v.text(input.promoText, current.promoText, { max: LIMITS.promoLength, field: "Promoción de la ruleta" }),
});

// null: hoy no se puede jugar (sin productos que participen).
const toPublic = (config, { products }) => (products.length === 0 ? null : {
  picks: Math.min(config.picks, products.length),
  promoText: config.promoText,
  itemIds: products.map((product) => product.id),
});

module.exports = { id, defaults, normalize, toPublic };
