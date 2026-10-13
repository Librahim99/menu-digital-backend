const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRounds, canPlay, playableTypes, scoreAnswer, shuffle, MAX_POINTS } = require("../src/games/duel/engine");

// Duelo de la carta: armado de rondas y puntaje (funciones puras, azar fijo).

// Azar reproducible: misma semilla, misma partida.
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const product = (id, title, price, categoryTitle, description = "") => ({ id, title, price, categoryTitle, description, available: true });

const CARTA = [
  product("p1", "Muzzarella", 9000, "Pizzas", "Salsa de tomate, queso y aceitunas verdes"),
  product("p2", "Napolitana", 10500, "Pizzas", "Con rodajas de tomate fresco y ajo"),
  product("p3", "Fugazzeta", 11000, "Pizzas"),
  product("p4", "Flan", 3000, "Postres", "Casero, con dulce de leche o crema"),
  product("p5", "Helado", null, "Postres"),
  product("p6", "Rubia", 2500, "Cervezas"),
  product("p7", "Negra", 2800, "Cervezas"),
];

const byId = Object.fromEntries(CARTA.map((p) => [p.id, p]));
const priceLabel = (value) => `$${new Intl.NumberFormat("es-AR").format(value)}`;

test("arma la cantidad de rondas pedida, cada una con opciones distintas y una sola correcta", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const rounds = buildRounds(CARTA, { rounds: 8, rng: seeded(seed) });
    assert.equal(rounds.length, 8);
    for (const round of rounds) {
      assert.ok(round.options.length >= 2 && round.options.length <= 4, round.type);
      assert.equal(new Set(round.options).size, round.options.length, `opciones repetidas en ${round.type}`);
      assert.ok(round.correct >= 0 && round.correct < round.options.length);
      assert.ok(byId[round.itemId], "el producto de la ronda es de la carta");
      assert.ok(round.prompt.length > 0);
    }
  }
});

test("la respuesta marcada como correcta es de verdad la correcta, en cada tipo de ronda", () => {
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed += 1) {
    for (const round of buildRounds(CARTA, { rounds: 6, rng: seeded(seed) })) {
      seen.add(round.type);
      const answer = round.options[round.correct];
      const featured = byId[round.itemId];
      if (round.type === "price") {
        assert.equal(answer, priceLabel(featured.price));
        assert.ok(round.prompt.includes(featured.title));
      } else if (round.type === "pricier") {
        const prices = round.options.map((title) => CARTA.find((p) => p.title === title).price);
        assert.equal(prices[round.correct], Math.max(...prices));
        assert.equal(new Set(prices).size, prices.length, "sin empates de precio");
        assert.equal(answer, featured.title);
      } else if (round.type === "category") {
        assert.equal(answer, featured.categoryTitle);
        assert.ok(round.prompt.includes(featured.title));
      } else if (round.type === "description") {
        assert.equal(answer, featured.title);
        assert.equal(round.detail, featured.description);
        assert.ok(!round.detail.toLowerCase().includes(featured.title.toLowerCase()), "la descripción no delata el nombre");
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["category", "description", "price", "pricier"]);
});

test("alterna los tipos de ronda y no repite el producto mientras queden otros", () => {
  // Carta donde cualquier producto sirve para cualquier tipo de ronda.
  const full = Array.from({ length: 7 }, (_, i) =>
    product(`f${i}`, `Plato ${i}`, 1000 * (i + 1), i % 2 ? "Entradas" : "Principales", `Receta de la casa número ${i}, bien servida`));
  for (let seed = 1; seed <= 20; seed += 1) {
    const rounds = buildRounds(full, { rounds: 6, rng: seeded(seed) });
    assert.equal(new Set(rounds.slice(0, 4).map((r) => r.type)).size, 4, "los cuatro tipos antes de repetir alguno");
    const featured = rounds.map((r) => r.itemId);
    // El más barato no puede protagonizar "¿cuál sale más?": quedan 6 para 6 rondas.
    assert.ok(new Set(featured).size >= 5, `productos repetidos de más: ${featured}`);
    assert.notEqual(featured[0], featured[1]);
  }
});

test("con los precios ocultos no hay rondas de precios", () => {
  assert.deepEqual(playableTypes(CARTA, { hidePrices: true }).sort(), ["category", "description"]);
  for (let seed = 1; seed <= 20; seed += 1) {
    const rounds = buildRounds(CARTA, { rounds: 6, hidePrices: true, rng: seeded(seed) });
    assert.equal(rounds.length, 6);
    for (const round of rounds) {
      assert.ok(["category", "description"].includes(round.type));
      assert.ok(!JSON.stringify(round).includes("$"), "no viaja ningún precio");
    }
  }
});

test("un producto sin precio propio (solo variantes) no entra en rondas de precios", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const round of buildRounds(CARTA, { rounds: 8, rng: seeded(seed) })) {
      if (round.type === "price") assert.notEqual(round.itemId, "p5");
      if (round.type === "pricier") assert.ok(!round.options.includes("Helado"));
    }
  }
});

test("los precios falsos son creíbles: redondos, positivos y distintos del real", () => {
  const solo = [product("a", "Café", 1850, "Cafetería"), product("b", "Té", 1700, "Cafetería")];
  for (let seed = 1; seed <= 30; seed += 1) {
    const round = buildRounds(solo, { rounds: 1, rng: seeded(seed) })[0];
    if (round.type !== "price") continue;
    const real = round.options[round.correct];
    const decoys = round.options.filter((label) => label !== real);
    assert.equal(decoys.length, 3);
    for (const label of decoys) {
      const value = Number(label.replace(/[$.]/g, ""));
      assert.ok(value > 0);
      assert.equal(value % 50, 0, `${label} es un precio redondo`);
    }
  }
});

test("cartas con las que no se puede jugar", () => {
  assert.equal(canPlay([], {}), false);
  assert.equal(canPlay([product("a", "Único", 1000, "Todo")], {}), false);
  assert.deepEqual(buildRounds([], { rounds: 5 }), []);
  // Dos productos al mismo precio, misma categoría, sin descripción: nada que preguntar con precios ocultos.
  const flat = [product("a", "Uno", 1000, "Todo"), product("b", "Dos", 1000, "Todo")];
  assert.equal(canPlay(flat, { hidePrices: true }), false);
  assert.deepEqual(buildRounds(flat, { rounds: 5, hidePrices: true }), []);
  // Con precios a la vista sí: se puede preguntar cuánto sale.
  assert.equal(canPlay(flat, {}), true);
  assert.deepEqual(playableTypes(flat, {}), ["price"]);
});

test("carta mínima: arma las rondas pedidas aunque tenga que repetir productos, sin colgarse", () => {
  const tiny = [product("a", "Uno", 1000, "Todo"), product("b", "Dos", 2500, "Todo")];
  for (let seed = 1; seed <= 20; seed += 1) {
    const rounds = buildRounds(tiny, { rounds: 10, rng: seeded(seed) });
    assert.equal(rounds.length, 10);
  }
  // Productos tan baratos que no admiten tres precios falsos: no hay ronda "cuánto sale".
  const cheap = [product("a", "Caramelo", 10, "Kiosco"), product("b", "Chicle", 20, "Kiosco")];
  assert.deepEqual(playableTypes(cheap, {}), ["pricier"]);
  assert.equal(buildRounds(cheap, { rounds: 4, rng: seeded(1) }).length, 4);
});

test("la misma semilla da la misma partida", () => {
  assert.deepEqual(buildRounds(CARTA, { rounds: 5, rng: seeded(7) }), buildRounds(CARTA, { rounds: 5, rng: seeded(7) }));
  assert.notDeepEqual(buildRounds(CARTA, { rounds: 5, rng: seeded(7) }), buildRounds(CARTA, { rounds: 5, rng: seeded(8) }));
});

test("puntaje: acertar vale la mitad y la velocidad el resto; errar no suma", () => {
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 0, totalMs: 15000 }), MAX_POINTS);
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 7500, totalMs: 15000 }), 750);
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 15000, totalMs: 15000 }), 500);
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 99999, totalMs: 15000 }), 500, "nunca menos que la base");
  assert.equal(scoreAnswer({ correct: true, elapsedMs: -50, totalMs: 15000 }), MAX_POINTS, "ni más que el máximo");
  assert.equal(scoreAnswer({ correct: false, elapsedMs: 0, totalMs: 15000 }), 0);
  assert.ok(scoreAnswer({ correct: true, elapsedMs: 2000, totalMs: 15000 }) > scoreAnswer({ correct: true, elapsedMs: 3000, totalMs: 15000 }));
});

test("mezclar no pierde ni repite elementos", () => {
  const list = [1, 2, 3, 4, 5, 6];
  for (let seed = 1; seed <= 20; seed += 1) {
    assert.deepEqual(shuffle(list, seeded(seed)).sort(), list);
  }
  assert.deepEqual(list, [1, 2, 3, 4, 5, 6], "no toca la lista original");
});
