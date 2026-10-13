const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { stubModule } = require("../test-support/ordersDb");
const { oid, venueUser, sampleMenu, mockGamesDb } = require("../test-support/gamesMocks");

// Juegos para comensales: configuración por local (validación, valores por
// defecto, persistencia, permisos y aislamiento) y lo que recibe la carta
// pública. Los endpoints corren de verdad sobre un servidor HTTP; lo único de
// mentira es MongoDB y el JWT del panel.

const USERS = [];
// Sesión del panel: en lugar del JWT, el test dice qué local es (o ninguno).
stubModule(path.join(__dirname, "..", "src", "middleware", "auth.js"), {
  protect: (req, res, next) => {
    const user = USERS.find((entry) => String(entry._id) === req.headers["x-test-owner"]);
    if (!user) return res.status(401).json({ message: "No autorizado, token requerido" });
    req.user = user;
    next();
  },
});

const settingsService = require("../src/games/settingsService");
const { filterPool } = require("../src/games/catalog");
const { GAMES } = require("../src/games/registry");
const { DEFAULT_DECK, LIMITS } = require("../src/games/constants");

let server;
let base;
test.before(async () => {
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/api/games", require("../src/games/routes"));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/games`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

const call = async (method, url, { body, owner } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(owner ? { "x-test-owner": String(owner._id) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

// Un local con su carta de prueba, registrado para el "login" del test.
const venue = (t, fields = {}) => {
  const user = venueUser(fields);
  const menu = sampleMenu(user._id);
  USERS.push(user);
  return { user, ...menu };
};

const rejects = (fn, message) => assert.throws(fn, (error) => {
  assert.equal(error.status, 400, error.message);
  if (message) assert.match(error.message, message);
  return true;
});

// ── Configuración: valores por defecto y validación (sin base) ──────────────

test("por defecto todos los juegos están apagados y el mazo de preguntas viene cargado", () => {
  const settings = settingsService.resolve(undefined);
  assert.equal(settings.venueOnly, false);
  assert.deepEqual(Object.keys(settings.games), ["roulette", "questions", "duel"]);
  assert.ok(Object.values(settings.games).every((game) => game.enabled === false));
  assert.deepEqual(settings.games.roulette, { enabled: false, picks: 1, pool: { categoryIds: [], excludedItemIds: [] }, promoText: "" });
  assert.equal(settings.games.questions.categories.length, DEFAULT_DECK.length);
  assert.ok(settings.games.questions.categories.every((category) => category.enabled && category.questions.length >= 8));
  assert.deepEqual(settings.games.duel, { enabled: false, rounds: 5, seconds: 15, pool: { categoryIds: [], excludedItemIds: [] }, prizeText: "" });
  // Cada llamada da una copia propia: tocarla no altera los valores por defecto.
  settings.games.questions.categories[0].questions.push("otra");
  assert.equal(settingsService.resolve(undefined).games.questions.categories[0].questions.length, DEFAULT_DECK[0].questions.length);
});

test("un cambio parcial toca solo lo que trae", () => {
  const current = settingsService.resolve(undefined);
  const next = settingsService.applyChanges(current, { games: { roulette: { enabled: true, picks: 2, promoText: "  10%   off  " } } });
  assert.deepEqual(next.games.roulette, { enabled: true, picks: 2, pool: { categoryIds: [], excludedItemIds: [] }, promoText: "10% off" });
  assert.deepEqual(next.games.duel, current.games.duel);
  assert.deepEqual(next.games.questions, current.games.questions);
  assert.equal(next.venueOnly, false);
  assert.equal(current.games.roulette.enabled, false, "la configuración anterior no se modifica");

  const again = settingsService.applyChanges(next, { venueOnly: true, games: { duel: { rounds: 7 } } });
  assert.equal(again.venueOnly, true);
  assert.equal(again.games.roulette.picks, 2);
  assert.deepEqual([again.games.duel.rounds, again.games.duel.seconds, again.games.duel.enabled], [7, 15, false]);
});

test("validación: tipos, rangos y largos de cada opción", () => {
  const current = settingsService.resolve(undefined);
  const change = (body) => () => settingsService.applyChanges(current, body);
  rejects(change("hola"));
  rejects(change([]));
  rejects(change({ venueOnly: "si" }));
  rejects(change({ games: [] }));
  rejects(change({ games: { roulette: "on" } }));
  rejects(change({ games: { roulette: { enabled: 1 } } }));
  rejects(change({ games: { roulette: { picks: 0 } } }), /entre 1 y 3/);
  rejects(change({ games: { roulette: { picks: 4 } } }));
  rejects(change({ games: { roulette: { picks: 1.5 } } }));
  rejects(change({ games: { roulette: { promoText: "x".repeat(LIMITS.promoLength + 1) } } }), /140 caracteres/);
  rejects(change({ games: { roulette: { promoText: 5 } } }));
  rejects(change({ games: { duel: { rounds: 2 } } }), /entre 3 y 10/);
  rejects(change({ games: { duel: { rounds: 11 } } }));
  rejects(change({ games: { duel: { seconds: 7 } } }), /entre 8 y 30/);
  rejects(change({ games: { duel: { seconds: 31 } } }));
  rejects(change({ games: { questions: { challenges: { every: 1 } } } }));
  rejects(change({ games: { questions: { challenges: "si" } } }));
  // Un juego que no existe se ignora (no rompe ni se guarda).
  assert.equal("ajedrez" in settingsService.applyChanges(current, { games: { ajedrez: { enabled: true } } }).games, false);
});

test("productos participantes: solo ids válidos, sin repetidos", () => {
  const current = settingsService.resolve(undefined);
  const [a, b] = [String(oid()), String(oid())];
  const next = settingsService.applyChanges(current, { games: { roulette: { pool: { categoryIds: [a, b, a], excludedItemIds: [b] } } } });
  assert.deepEqual(next.games.roulette.pool, { categoryIds: [a, b], excludedItemIds: [b] });
  // Cambiar solo una lista conserva la otra.
  const only = settingsService.applyChanges(next, { games: { roulette: { pool: { excludedItemIds: [] } } } });
  assert.deepEqual(only.games.roulette.pool, { categoryIds: [a, b], excludedItemIds: [] });

  const change = (pool) => () => settingsService.applyChanges(current, { games: { roulette: { pool } } });
  rejects(change("todas"));
  rejects(change({ categoryIds: "todas" }));
  rejects(change({ categoryIds: ["no-es-un-id"] }));
  rejects(change({ categoryIds: [{ $ne: null }] }));
  rejects(change({ excludedItemIds: [123] }));
  rejects(change({ categoryIds: Array.from({ length: LIMITS.poolCategories + 1 }, () => String(oid())) }));
});

test("preguntas: el mazo se reemplaza entero; limpia vacías y repetidas", () => {
  const current = settingsService.resolve(undefined);
  const next = settingsService.applyChanges(current, {
    games: { questions: { categories: [
      { id: "citas", name: "  Primera   cita ", enabled: false, questions: ["  ¿Mar o montaña?  ", "", "¿Mar o montaña?", "¿Perros o gatos?"] },
      { name: "Del local", questions: ["¿Cuál es tu plato favorito de acá?"] },
    ] } },
  });
  const [first, second] = next.games.questions.categories;
  assert.deepEqual(first, { id: "citas", name: "Primera cita", enabled: false, questions: ["¿Mar o montaña?", "¿Perros o gatos?"] });
  assert.equal(second.name, "Del local");
  assert.equal(second.enabled, true);
  assert.match(second.id, /^[a-z0-9-]{1,40}$/);
  assert.equal(next.games.questions.categories.length, 2, "las categorías que no vinieron se borraron");

  const change = (categories) => () => settingsService.applyChanges(current, { games: { questions: { categories } } });
  rejects(change("ninguna"));
  rejects(change([{ name: "", questions: [] }]), /necesita un nombre/);
  rejects(change([{ name: "x".repeat(41), questions: [] }]));
  rejects(change([{ name: "Ok", questions: "una sola" }]));
  rejects(change([{ name: "Ok", questions: ["x".repeat(201)] }]));
  rejects(change([{ name: "Ok", questions: [42] }]));
  rejects(change([{ name: "Ok", questions: Array.from({ length: 81 }, (_, i) => `¿Pregunta ${i}?`) }]));
  rejects(change(Array.from({ length: 13 }, (_, i) => ({ name: `Cat ${i}`, questions: [] }))), /hasta 12 categorías/);
  // Ids repetidos o raros no rompen: se les da uno nuevo.
  const dup = settingsService.applyChanges(current, { games: { questions: { categories: [
    { id: "a", name: "Uno", questions: [] }, { id: "a", name: "Dos", questions: [] }, { id: "../../x", name: "Tres", questions: [] },
  ] } } }).games.questions.categories.map((c) => c.id);
  assert.equal(new Set(dup).size, 3);
  assert.ok(dup.every((id) => /^[a-z0-9-]{1,40}$/.test(id)));
});

test("lo guardado por una versión anterior (o roto) se completa con los valores por defecto", () => {
  // Sin el juego nuevo y sin una opción que antes no existía.
  const old = settingsService.resolve({ games: { roulette: { enabled: true } } });
  assert.deepEqual(old.games.roulette, { enabled: true, picks: 1, pool: { categoryIds: [], excludedItemIds: [] }, promoText: "" });
  assert.equal(old.games.duel.rounds, 5);
  assert.equal(old.venueOnly, false);
  // Datos inválidos en un juego: ese juego vuelve a su configuración inicial, los demás quedan.
  const broken = settingsService.resolve({ venueOnly: "x", games: { roulette: { enabled: true, picks: 99 }, duel: { enabled: true, rounds: 4 } } });
  assert.equal(broken.games.roulette.enabled, false);
  assert.deepEqual([broken.games.duel.enabled, broken.games.duel.rounds], [true, 4]);
  for (const junk of [null, "x", 7, [], { games: "x" }, { games: { roulette: [] } }]) {
    assert.deepEqual(settingsService.resolve(junk), settingsService.defaults());
  }
});

test("arquitectura: cada juego del registro cumple el mismo contrato", () => {
  assert.deepEqual(GAMES.map((game) => game.id), ["roulette", "questions", "duel"]);
  for (const game of GAMES) {
    const config = game.defaults();
    assert.equal(config.enabled, false, `${game.id} arranca apagado`);
    assert.deepEqual(game.normalize({}, config), config, `${game.id}: un cambio vacío no cambia nada`);
    assert.equal(game.toPublic({ ...config, enabled: true }, { products: [], hidePrices: false }) === null || game.id === "questions", true,
      `${game.id}: sin productos no se ofrece (salvo las preguntas, que no los necesitan)`);
  }
});

// ── Qué productos participan y qué ve el comensal (sin base) ────────────────

const product = (id, categoryId, over = {}) => ({
  id, title: `P ${id}`, categoryId, categoryTitle: `C ${categoryId}`, price: 1000 * Number(id), description: "", available: true, ...over,
});
const PRODUCTS = [product("1", "a"), product("2", "a"), product("3", "b"), product("4", "b", { available: false }), product("5", "c")];

test("productos participantes: categorías elegidas menos los excluidos, y solo lo que se puede pedir ahora", () => {
  const ids = (pool) => filterPool(PRODUCTS, pool).map((p) => p.id);
  assert.deepEqual(ids({ categoryIds: [], excludedItemIds: [] }), ["1", "2", "3", "5"], "todo lo disponible");
  assert.deepEqual(ids({ categoryIds: ["a", "b"], excludedItemIds: [] }), ["1", "2", "3"]);
  assert.deepEqual(ids({ categoryIds: ["a"], excludedItemIds: ["2"] }), ["1"]);
  assert.deepEqual(ids({ categoryIds: [], excludedItemIds: ["1", "5"] }), ["2", "3"]);
  assert.deepEqual(ids({ categoryIds: ["z"], excludedItemIds: [] }), [], "una categoría que ya no existe no trae nada");
  assert.deepEqual(ids(undefined), ["1", "2", "3", "5"]);
});

test("vista pública: solo los juegos encendidos que hoy se pueden jugar, con lo justo", () => {
  // Los ids de este catálogo de prueba son letras: el reparto se pone directo, sin pasar por la validación de ids.
  const on = (changes, pools = {}) => {
    const settings = settingsService.applyChanges(settingsService.resolve(undefined), { games: changes });
    for (const [gameId, categoryIds] of Object.entries(pools)) settings.games[gameId].pool = { categoryIds, excludedItemIds: [] };
    return settings;
  };
  const view = (settings, context = {}) => settingsService.toPublic(settings, { products: PRODUCTS, hidePrices: false, ...context });

  assert.deepEqual(view(settingsService.resolve(undefined)), { enabled: false, venueOnly: false, games: [] });

  const all = view(on({
    roulette: { enabled: true, picks: 3, promoText: "Postre gratis" },
    questions: { enabled: true },
    duel: { enabled: true, prizeText: "Un café" },
  }, { roulette: ["a"] }));
  assert.equal(all.enabled, true);
  assert.deepEqual(all.games.map((game) => game.id), ["roulette", "questions", "duel"]);
  const [roulette, questions, duel] = all.games;
  assert.deepEqual(roulette, { id: "roulette", picks: 2, promoText: "Postre gratis", itemIds: ["1", "2"] }, "no salen más productos de los que participan");
  assert.equal(questions.categories.length, 4);
  assert.deepEqual(Object.keys(questions.categories[0]).sort(), ["id", "name", "questions"]);
  assert.deepEqual(questions.challenges, { every: 4, itemIds: ["1", "2", "3", "5"] });
  assert.deepEqual(duel, { id: "duel", rounds: 5, seconds: 15, prizeText: "Un café", minPlayers: 2, maxPlayers: 8 });
  assert.equal(JSON.stringify(all).includes("excludedItemIds"), false, "la configuración interna no viaja");

  // Ruleta sin productos que participen: no se ofrece.
  assert.deepEqual(view(on({ roulette: { enabled: true } }, { roulette: ["z"] })).games, []);
  // Preguntas: sin desafíos si no hay productos o están apagados; sin categorías activas no se ofrece.
  assert.equal(view(on({ questions: { enabled: true } }), { products: [] }).games[0].challenges, null);
  assert.equal(view(on({ questions: { enabled: true, challenges: { enabled: false } } })).games[0].challenges, null);
  const off = settingsService.resolve(undefined).games.questions.categories.map((category) => ({ ...category, enabled: false }));
  assert.deepEqual(view(on({ questions: { enabled: true, categories: off } })).games, []);
  assert.deepEqual(view(on({ questions: { enabled: true, categories: [{ name: "Vacía", questions: [] }] } })).games, []);
  // Duelo: con una carta que no alcanza para armar rondas no se ofrece.
  assert.deepEqual(view(on({ duel: { enabled: true } }), { products: PRODUCTS.slice(0, 1) }).games, []);
  assert.equal(view(on({ duel: { enabled: true } }), { hidePrices: true }).games.length, 1, "con precios ocultos se juega con categorías");
});

// ── Endpoints ────────────────────────────────────────────────────────────────

test("panel: ver y guardar la configuración, con la carta para elegir qué participa", async (t) => {
  const v = venue(t);
  mockGamesDb(t, { users: USERS, menus: v.menus, items: v.items });

  let res = await call("GET", "/settings", { owner: v.user });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.games.roulette.enabled, false);
  assert.deepEqual(res.body.catalog.categories.map((c) => c.title), ["Cervezas", "Pizzas", "Postres"], "en el orden de la carta: primero las secciones");
  assert.equal(res.body.catalog.products.length, 7);
  assert.deepEqual(Object.keys(res.body.catalog.products[0]).sort(), ["available", "categoryId", "id", "title"]);
  assert.equal(res.body.limits.duelRoundsMax, 10);

  res = await call("PUT", "/settings", { owner: v.user, body: {
    venueOnly: true,
    games: {
      roulette: { enabled: true, picks: 2, pool: { categoryIds: [v.ids.categories.pizzas], excludedItemIds: [v.ids.items.Fugazzeta] } },
      duel: { enabled: true, rounds: 4, seconds: 10, prizeText: "Un café de regalo" },
    },
  } });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.games.roulette.picks, 2);
  assert.equal(res.body.settings.venueOnly, true);

  // Quedó guardado: al volver a entrar está igual.
  res = await call("GET", "/settings", { owner: v.user });
  assert.deepEqual(res.body.settings.games.duel, {
    enabled: true, rounds: 4, seconds: 10, pool: { categoryIds: [], excludedItemIds: [] }, prizeText: "Un café de regalo",
  });
  assert.deepEqual(res.body.settings.games.roulette.pool, { categoryIds: [v.ids.categories.pizzas], excludedItemIds: [v.ids.items.Fugazzeta] });
  assert.equal(res.body.settings.games.questions.enabled, false);
});

test("panel: permisos (sin sesión, sin el plan) y validación", async (t) => {
  const pro = venue(t);
  const free = venue(t, { slug: "bar-free", subscription: "free", subscriptionExpiresAt: null });
  const expired = venue(t, { slug: "bar-vencido", subscriptionExpiresAt: new Date("2020-01-01T00:00:00Z") });
  // Mismo cálculo que hace `protect` en producción: el plan vigente, no el comprado.
  const { getSubscriptionState } = require("../src/config/plans");
  for (const user of [pro.user, free.user, expired.user]) {
    user.subscription = getSubscriptionState(user.subscription, user.subscriptionExpiresAt).effectivePlan;
  }
  const { store } = mockGamesDb(t, { users: USERS, menus: pro.menus, items: pro.items });

  assert.equal((await call("GET", "/settings")).status, 401);
  assert.equal((await call("PUT", "/settings", { body: { venueOnly: true } })).status, 401);
  for (const owner of [free.user, expired.user]) {
    const res = await call("GET", "/settings", { owner });
    assert.equal(res.status, 403);
    assert.deepEqual([res.body.code, res.body.feature], ["FEATURE_NOT_INCLUDED", "juegos"]);
    assert.equal((await call("PUT", "/settings", { owner, body: { venueOnly: true } })).status, 403);
  }

  for (const body of [
    { games: { roulette: { picks: 9 } } },
    { games: { duel: { seconds: 2 } } },
    { games: { roulette: { pool: { categoryIds: ["x"] } } } },
    { venueOnly: "si" },
    { games: { questions: { categories: [{ name: "", questions: [] }] } } },
  ]) {
    const res = await call("PUT", "/settings", { owner: pro.user, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.message);
  }
  assert.equal(store.size, 0, "nada inválido ni sin permiso llegó a guardarse");
});

test("aislamiento: cada local tiene su configuración y solo ve su carta", async (t) => {
  const a = venue(t, { slug: "local-a" });
  const b = venue(t, { slug: "local-b" });
  const { store } = mockGamesDb(t, { users: USERS, menus: [...a.menus, ...b.menus], items: [...a.items, ...b.items] });

  await call("PUT", "/settings", { owner: a.user, body: { games: { roulette: { enabled: true, promoText: "Promo de A" } } } });
  // B intenta meter en su ruleta una categoría y un producto de A.
  await call("PUT", "/settings", { owner: b.user, body: { games: { roulette: {
    enabled: true, pool: { categoryIds: [a.ids.categories.pizzas], excludedItemIds: [a.ids.items.Flan] },
  } } } });

  assert.equal(store.size, 2);
  assert.equal(store.get(String(a.user._id)).config.games.roulette.promoText, "Promo de A");
  assert.equal(store.get(String(b.user._id)).config.games.roulette.promoText, "");

  const forA = (await call("GET", "/settings", { owner: a.user })).body;
  const forB = (await call("GET", "/settings", { owner: b.user })).body;
  const idsOfA = new Set(Object.values(a.ids.items));
  assert.ok(forA.catalog.products.every((p) => idsOfA.has(p.id)));
  assert.ok(forB.catalog.products.every((p) => !idsOfA.has(p.id)), "el catálogo de B no trae productos de A");
  assert.equal(forA.settings.games.roulette.pool.categoryIds.length, 0);

  // En la carta pública de B, apuntar a una categoría de A no trae nada de A: la ruleta queda sin productos.
  const publicA = (await call("GET", "/public/local-a")).body;
  const publicB = (await call("GET", "/public/local-b")).body;
  assert.ok(publicA.games[0].itemIds.every((id) => idsOfA.has(id)));
  assert.deepEqual(publicB, { enabled: false, venueOnly: false, games: [] });
});

test("carta pública: juegos habilitados con productos reales y pedibles", async (t) => {
  const v = venue(t, { slug: "bar-publico" });
  // Uno pausado y uno oculto: no participan de ningún juego.
  v.items.find((item) => item.title === "Negra").available = false;
  v.items.find((item) => item.title === "Napolitana").hidden = true;
  mockGamesDb(t, { users: USERS, menus: v.menus, items: v.items });

  await call("PUT", "/settings", { owner: v.user, body: { games: {
    roulette: { enabled: true, pool: { categoryIds: [], excludedItemIds: [v.ids.items.Flan] } },
    questions: { enabled: true, challenges: { pool: { categoryIds: [v.ids.categories.cervezas], excludedItemIds: [] } } },
    duel: { enabled: true },
  } } });

  const res = await call("GET", "/public/bar-publico");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  const [roulette, questions, duel] = res.body.games;
  const names = (ids) => ids.map((id) => Object.keys(v.ids.items).find((title) => v.ids.items[title] === id));
  assert.deepEqual(names(roulette.itemIds), ["Rubia", "Muzzarella", "Fugazzeta", "Helado"], "sin el excluido, el pausado ni el oculto");
  assert.deepEqual(names(questions.challenges.itemIds), ["Rubia"], "los desafíos, solo con su categoría");
  assert.equal(duel.rounds, 5);
  // Sin datos del dueño ni precios: la carta ya los tiene y son los que valen.
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("password") && !raw.includes("9000") && !raw.includes(String(v.user._id)));
});

test("carta pública: un local que no existe, sin el plan o sin juegos encendidos responde «sin juegos»", async (t) => {
  const none = { enabled: false, venueOnly: false, games: [] };
  const off = venue(t, { slug: "bar-apagado" });
  const free = venue(t, { slug: "bar-sin-plan", subscription: "free", subscriptionExpiresAt: null });
  const inactive = venue(t, { slug: "bar-inactivo", active: false });
  const { store } = mockGamesDb(t, { users: USERS, menus: off.menus, items: off.items });
  // Aunque tengan juegos guardados como encendidos de cuando tenían el plan.
  const enabled = { games: { roulette: { enabled: true } } };
  store.set(String(free.user._id), { config: enabled });
  store.set(String(inactive.user._id), { config: enabled });
  const Item = require("../src/models/Item");

  for (const slug of ["no-existe", "bar-sin-plan", "bar-inactivo", "bar-apagado", "x".repeat(200)]) {
    const res = await call("GET", `/public/${slug}`);
    assert.equal(res.status, 200, slug);
    assert.deepEqual(res.body, none, slug);
  }
  assert.equal(Item.find.mock.callCount(), 0, "sin juegos encendidos no se va a buscar la carta");
});
