const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Item = require("../src/models/Item");
const Menu = require("../src/models/Menu");
const { getEmptySchedule } = require("../src/utils/itemAvailability");
const { getEmptyOfferSchedule } = require("../src/utils/offers");
const {
  isItemAvailableNow,
  resolveOfferPrice,
  toPublicItem,
  getReachableCategoryIds,
  buildPublicMenu,
  toPublicContactInfo,
  toPublicMedia,
  toPublicFeatures,
} = require("../src/utils/publicMenu");

// ──────────────────────────────────────────────
// utils/publicMenu.js es puro: la hora entra por parámetro, así que todo se
// prueba con fechas fijas en horario de Buenos Aires (-03:00, sin horario de
// verano) y sin mocks de Mongoose.
// ──────────────────────────────────────────────

// 2026-08-17 es lunes.
const LUNES_19 = new Date("2026-08-17T19:00:00-03:00");
const LUNES_21 = new Date("2026-08-17T21:00:00-03:00");
// Martes de madrugada: cae dentro del horario nocturno del lunes.
const MARTES_01 = new Date("2026-08-18T01:00:00-03:00");
const MARTES_03 = new Date("2026-08-18T03:00:00-03:00");

const PRO = { programacion_productos: true };
const FREE = { programacion_productos: false };

const id = () => new mongoose.Types.ObjectId();

const schedule = (days, extra = {}) => ({ ...getEmptySchedule(), enabled: true, ...days, ...extra });
const offerSchedule = (days) => ({ ...getEmptyOfferSchedule(), enabled: true, ...days });

// Lo que devuelve una query lean() sin proyección: todos los campos que el
// schema guarda, incluidos los que la carta v2 nunca debe mandar.
const leanItem = (menuID, fields = {}) => ({
  _id: id(),
  menuID,
  code: "A-1",
  title: "Muzzarella",
  description: "La de siempre",
  price: 1500,
  offerPrice: null,
  offerRange: { from: null, to: null },
  offerSchedule: getEmptyOfferSchedule(),
  options: {},
  image: "https://res.cloudinary.com/demo/image/upload/pizza.jpg",
  available: true,
  availabilitySchedule: getEmptySchedule(),
  isExtra: false,
  recommended: false,
  hidden: false,
  apt: {},
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  __v: 0,
  ...fields,
});

const leanMenu = (userID, fields = {}) => ({
  _id: id(),
  userID,
  sectionID: null,
  code: "",
  title: "Pizzas",
  description: "Descripción de la categoría",
  image: "https://res.cloudinary.com/demo/image/upload/cat.jpg",
  section: false,
  hidden: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  __v: 0,
  ...fields,
});

const FORBIDDEN_KEYS = [
  "code", "hidden", "createdAt", "updatedAt", "__v", "userID", "menuID", "sectionID",
  "available", "offerRange", "offerSchedule", "availabilitySchedule", "isExtra",
  "section", "subscription", "schedule",
];

// Todas las claves de un valor JSON, a cualquier profundidad.
const collectKeys = (value, acc = new Set()) => {
  if (Array.isArray(value)) value.forEach((entry) => collectKeys(entry, acc));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      acc.add(key);
      collectKeys(entry, acc);
    }
  }
  return acc;
};

// ──────────────────────────────────────────────
// isItemAvailableNow
// ──────────────────────────────────────────────

test("disponibilidad: sin `available` guardado (lean no aplica defaults) el producto está disponible", () => {
  assert.equal(isItemAvailableNow({ title: "Sin campo" }, PRO, LUNES_19), true);
  assert.equal(isItemAvailableNow({ available: true }, FREE, LUNES_19), true);
});

test("disponibilidad: el interruptor manual `available: false` lo saca siempre, con o sin horario", () => {
  assert.equal(isItemAvailableNow({ available: false }, PRO, LUNES_19), false);
  assert.equal(isItemAvailableNow({ available: false }, FREE, LUNES_19), false);
  // Un horario que lo dejaría disponible no pisa el interruptor manual.
  const item = { available: false, availabilitySchedule: schedule({ mon: [{ from: "18:00", to: "20:00" }] }) };
  assert.equal(isItemAvailableNow(item, PRO, LUNES_19), false);
});

test("disponibilidad: el horario semanal solo restringe con el permiso del plan y habilitado", () => {
  const item = { available: true, availabilitySchedule: schedule({ mon: [{ from: "18:00", to: "20:00" }] }) };
  assert.equal(isItemAvailableNow(item, PRO, LUNES_19), true);
  assert.equal(isItemAvailableNow(item, PRO, LUNES_21), false);

  // Sin programacion_productos el horario se ignora (mismo criterio que la carta legacy).
  assert.equal(isItemAvailableNow(item, FREE, LUNES_21), true);
  assert.equal(isItemAvailableNow(item, {}, LUNES_21), true);

  // Horario guardado pero apagado: no restringe.
  const apagado = { available: true, availabilitySchedule: { ...item.availabilitySchedule, enabled: false } };
  assert.equal(isItemAvailableNow(apagado, PRO, LUNES_21), true);
});

test("disponibilidad: un horario nocturno sigue vigente después de medianoche, en horario de Buenos Aires", () => {
  const item = { available: true, availabilitySchedule: schedule({ mon: [{ from: "20:00", to: "02:00" }] }) };
  assert.equal(isItemAvailableNow(item, PRO, LUNES_21), true);
  assert.equal(isItemAvailableNow(item, PRO, MARTES_01), true);
  assert.equal(isItemAvailableNow(item, PRO, MARTES_03), false);
  assert.equal(isItemAvailableNow(item, PRO, LUNES_19), false);
  // El mismo instante en UTC: 01:00 de Buenos Aires son las 04:00Z.
  assert.equal(isItemAvailableNow(item, PRO, new Date("2026-08-18T04:00:00Z")), true);
});

test("disponibilidad: fuera del rango de fechas del horario manda el interruptor manual", () => {
  const item = {
    available: true,
    availabilitySchedule: schedule(
      { mon: [{ from: "12:00", to: "13:00" }] },
      { dateRange: { from: new Date("2026-09-01T00:00:00-03:00"), to: null } },
    ),
  };
  // El horario recién rige desde septiembre: el 17 de agosto el producto está disponible.
  assert.equal(isItemAvailableNow(item, PRO, LUNES_19), true);
});

// ──────────────────────────────────────────────
// resolveOfferPrice
// ──────────────────────────────────────────────

test("oferta: manual (sin rango ni horario) rige siempre, con y sin permiso de programación", () => {
  const item = { price: 1000, offerPrice: 800, offerRange: { from: null, to: null }, offerSchedule: getEmptyOfferSchedule() };
  assert.equal(resolveOfferPrice(item, PRO, LUNES_19), 800);
  assert.equal(resolveOfferPrice(item, FREE, LUNES_19), 800);
  // Un item lean sin offerRange ni offerSchedule guardados es lo mismo.
  assert.equal(resolveOfferPrice({ price: 1000, offerPrice: 800 }, FREE, LUNES_19), 800);
});

test("oferta: sin offerPrice, o sin precio original, o igual/mayor al precio, no hay oferta", () => {
  assert.equal(resolveOfferPrice({ price: 1000, offerPrice: null }, PRO, LUNES_19), null);
  assert.equal(resolveOfferPrice({ price: 1000 }, PRO, LUNES_19), null);
  assert.equal(resolveOfferPrice({ price: null, offerPrice: 800 }, PRO, LUNES_19), null);
  assert.equal(resolveOfferPrice({ offerPrice: 800 }, PRO, LUNES_19), null);
  assert.equal(resolveOfferPrice({ price: 1000, offerPrice: 1000 }, PRO, LUNES_19), null);
  assert.equal(resolveOfferPrice({ price: 1000, offerPrice: 1200 }, PRO, LUNES_19), null);
});

test("oferta programada por fechas: vigente rige, la que todavía no empezó y la vencida no", () => {
  const base = { price: 1000, offerPrice: 800 };
  const vigente = { ...base, offerRange: { from: new Date("2026-08-15T00:00:00-03:00"), to: new Date("2026-08-20T23:59:59-03:00") } };
  const futura = { ...base, offerRange: { from: new Date("2026-08-20T00:00:00-03:00"), to: null } };
  const vencida = { ...base, offerRange: { from: null, to: new Date("2026-08-16T23:59:59-03:00") } };

  assert.equal(resolveOfferPrice(vigente, PRO, LUNES_19), 800);
  assert.equal(resolveOfferPrice(futura, PRO, LUNES_19), null);
  assert.equal(resolveOfferPrice(vencida, PRO, LUNES_19), null);
  // Cruzando el límite horario el resultado cambia con `now`: no hay estado escondido.
  assert.equal(resolveOfferPrice(futura, PRO, new Date("2026-08-20T10:00:00-03:00")), 800);
  assert.equal(resolveOfferPrice(vigente, PRO, new Date("2026-08-21T00:00:00-03:00")), null);
});

test("oferta programada por horario semanal: solo rige dentro de sus días y horas", () => {
  const item = {
    price: 1000,
    offerPrice: 800,
    offerRange: { from: null, to: null },
    offerSchedule: offerSchedule({ mon: [{ from: "18:00", to: "20:00" }] }),
  };
  assert.equal(resolveOfferPrice(item, PRO, LUNES_19), 800);
  assert.equal(resolveOfferPrice(item, PRO, LUNES_21), null);
  assert.equal(resolveOfferPrice(item, PRO, MARTES_01), null);
});

test("oferta programada: sin el permiso programacion_productos se ignora, aunque hoy estaría vigente", () => {
  const conRango = {
    price: 1000,
    offerPrice: 800,
    offerRange: { from: new Date("2026-08-15T00:00:00-03:00"), to: null },
  };
  const conHorario = {
    price: 1000,
    offerPrice: 800,
    offerSchedule: offerSchedule({ mon: [{ from: "18:00", to: "20:00" }] }),
  };
  for (const item of [conRango, conHorario]) {
    assert.equal(resolveOfferPrice(item, PRO, LUNES_19), 800);
    assert.equal(resolveOfferPrice(item, FREE, LUNES_19), null);
    assert.equal(resolveOfferPrice(item, undefined, LUNES_19), null);
  }
});

// ──────────────────────────────────────────────
// toPublicItem
// ──────────────────────────────────────────────

test("item: un producto completo viaja solo con lo que la carta dibuja", () => {
  const menuID = id();
  const raw = leanItem(menuID, {
    offerPrice: 1200,
    options: { Chica: 800, Grande: 2000 },
    recommended: true,
    apt: { vegano: true },
  });

  const publicItem = toPublicItem(raw, { features: PRO, now: LUNES_19 });

  assert.deepEqual(publicItem, {
    _id: raw._id,
    title: "Muzzarella",
    price: 1500,
    offerPrice: 1200,
    description: "La de siempre",
    image: "https://res.cloudinary.com/demo/image/upload/pizza.jpg",
    options: { Chica: 800, Grande: 2000 },
    recommended: true,
    apt: { vegano: true },
  });
});

test("item: lo vacío se omite (description, image, recommended, apt, options, offerPrice, price)", () => {
  const raw = leanItem(id(), {
    description: "",
    image: "",
    recommended: false,
    apt: {},
    options: {},
    offerPrice: null,
    price: null,
  });

  assert.deepEqual(toPublicItem(raw, { features: PRO, now: LUNES_19 }), { _id: raw._id, title: "Muzzarella" });

  // price undefined (ausente) también se omite, y la oferta nunca viaja sin precio.
  const sinPrecio = leanItem(id(), { price: undefined, offerPrice: 800 });
  const publicItem = toPublicItem(sinPrecio, { features: PRO, now: LUNES_19 });
  assert.equal("price" in publicItem, false);
  assert.equal("offerPrice" in publicItem, false);
});

test("item: un documento lean mínimo (sin defaults del schema) se resuelve como disponible y sin extras", () => {
  const raw = { _id: id(), menuID: id(), title: "Mínimo", price: 500 };
  assert.deepEqual(toPublicItem(raw, { features: FREE, now: LUNES_19 }), { _id: raw._id, title: "Mínimo", price: 500 });
});

test("item: el precio 0 es un precio (no se omite)", () => {
  const raw = { _id: id(), title: "Cortesía", price: 0 };
  assert.deepEqual(toPublicItem(raw, { features: FREE, now: LUNES_19 }), { _id: raw._id, title: "Cortesía", price: 0 });
});

test("item: oculto, agotado o fuera de horario no viajan (null)", () => {
  const menuID = id();
  assert.equal(toPublicItem(leanItem(menuID, { hidden: true }), { features: PRO, now: LUNES_19 }), null);
  assert.equal(toPublicItem(leanItem(menuID, { available: false }), { features: PRO, now: LUNES_19 }), null);
  const nocturno = leanItem(menuID, { availabilitySchedule: schedule({ mon: [{ from: "20:00", to: "02:00" }] }) });
  assert.equal(toPublicItem(nocturno, { features: PRO, now: LUNES_19 }), null);
  assert.notEqual(toPublicItem(nocturno, { features: PRO, now: MARTES_01 }), null);
  // Sin el permiso del plan el horario no aplica y el producto viaja.
  assert.notEqual(toPublicItem(nocturno, { features: FREE, now: LUNES_19 }), null);
  assert.equal(toPublicItem(null, { features: PRO, now: LUNES_19 }), null);
});

test("item: la oferta viaja solo si rige AHORA y siempre junto con el precio", () => {
  const futura = leanItem(id(), {
    offerPrice: 1200,
    offerRange: { from: new Date("2026-08-20T00:00:00-03:00"), to: null },
  });
  const antes = toPublicItem(futura, { features: PRO, now: LUNES_19 });
  assert.equal(antes.price, 1500);
  assert.equal("offerPrice" in antes, false);

  const despues = toPublicItem(futura, { features: PRO, now: new Date("2026-08-21T12:00:00-03:00") });
  assert.equal(despues.price, 1500);
  assert.equal(despues.offerPrice, 1200);

  // Sin programacion_productos la oferta con rango se ignora aunque ya haya empezado.
  const sinPermiso = toPublicItem(futura, { features: FREE, now: new Date("2026-08-21T12:00:00-03:00") });
  assert.equal("offerPrice" in sinPermiso, false);
});

test("item con hidePrices: sin price ni offerPrice y options con las claves en 0", () => {
  const raw = leanItem(id(), { offerPrice: 1200, options: { Chica: 800, Grande: 2000 } });

  const publicItem = toPublicItem(raw, { features: PRO, hidePrices: true, now: LUNES_19 });

  assert.equal("price" in publicItem, false);
  assert.equal("offerPrice" in publicItem, false);
  // El pedido por variante depende de los nombres: se conservan, con valor 0.
  assert.deepEqual(publicItem.options, { Chica: 0, Grande: 0 });
  assert.equal(publicItem.title, "Muzzarella");
  assert.equal(publicItem.description, "La de siempre");

  // Sin variantes no hay options aunque se ocultaran los precios.
  const simple = toPublicItem(leanItem(id()), { features: PRO, hidePrices: true, now: LUNES_19 });
  assert.equal("options" in simple, false);
  assert.equal("price" in simple, false);

  // hidePrices no cambia qué productos viajan.
  assert.equal(toPublicItem(leanItem(id(), { available: false }), { features: PRO, hidePrices: true, now: LUNES_19 }), null);
});

test("item: acepta documentos de Mongoose (options como Map) y no muta el original", () => {
  const doc = new Item({
    menuID: id(),
    title: "Fugazzeta",
    price: 1800,
    offerPrice: 1600,
    options: { Media: 900, Entera: 1800 },
    recommended: true,
  });
  const before = JSON.stringify(doc.toObject({ flattenMaps: true }));

  const publicItem = toPublicItem(doc, { features: PRO, now: LUNES_19 });

  assert.deepEqual(publicItem, {
    _id: doc._id,
    title: "Fugazzeta",
    price: 1800,
    offerPrice: 1600,
    options: { Media: 900, Entera: 1800 },
    recommended: true,
  });
  assert.equal(JSON.stringify(doc.toObject({ flattenMaps: true })), before);
  assert.ok(doc.options instanceof Map, "el documento original sigue con su Map");

  // Con hidePrices sobre el documento (Map) también quedan las claves en 0.
  assert.deepEqual(
    toPublicItem(doc, { features: PRO, hidePrices: true, now: LUNES_19 }).options,
    { Media: 0, Entera: 0 },
  );
});

test("item lean: la copia de options es independiente del origen", () => {
  const raw = leanItem(id(), { options: { Chica: 800 } });
  const publicItem = toPublicItem(raw, { features: PRO, now: LUNES_19 });
  publicItem.options.Chica = 1;
  assert.equal(raw.options.Chica, 800);
});

// ──────────────────────────────────────────────
// buildPublicMenu
// ──────────────────────────────────────────────

const build = (menus, items, extra = {}) => buildPublicMenu({
  menus, items, features: PRO, hidePrices: false, now: LUNES_19, ...extra,
});

test("carta: arma secciones -> categorías -> items y categorías sueltas, en el orden de entrada", () => {
  const userID = id();
  const seccion = leanMenu(userID, { title: "Comidas", section: true, description: "", image: "" });
  const pizzas = leanMenu(userID, { title: "Pizzas", sectionID: seccion._id });
  const postres = leanMenu(userID, { title: "Postres", sectionID: seccion._id });
  const bebidas = leanMenu(userID, { title: "Bebidas" });
  const menus = [seccion, pizzas, postres, bebidas];

  const muzza = leanItem(pizzas._id, { title: "Muzzarella" });
  const fugazza = leanItem(pizzas._id, { title: "Fugazza" });
  const flan = leanItem(postres._id, { title: "Flan" });
  const agua = leanItem(bebidas._id, { title: "Agua" });

  const menu = build(menus, [muzza, agua, fugazza, flan]);

  assert.deepEqual(Object.keys(menu), ["secciones", "sinSeccion"]);
  assert.deepEqual(menu.secciones.map((s) => s.title), ["Comidas"]);
  assert.deepEqual(menu.secciones[0].categorias.map((c) => c.title), ["Pizzas", "Postres"]);
  assert.deepEqual(menu.secciones[0].categorias[0].items.map((i) => i.title), ["Muzzarella", "Fugazza"]);
  assert.deepEqual(menu.secciones[0].categorias[1].items.map((i) => i.title), ["Flan"]);
  assert.deepEqual(menu.sinSeccion.map((c) => c.title), ["Bebidas"]);
  assert.deepEqual(menu.sinSeccion[0].items.map((i) => i.title), ["Agua"]);

  // Secciones y categorías: solo título y jerarquía.
  assert.deepEqual(Object.keys(menu.secciones[0]), ["title", "categorias"]);
  assert.deepEqual(Object.keys(menu.secciones[0].categorias[0]), ["title", "items"]);
  assert.deepEqual(Object.keys(menu.sinSeccion[0]), ["title", "items"]);
});

test("carta: se podan las categorías sin items y las secciones sin categorías", () => {
  const userID = id();
  const seccionLlena = leanMenu(userID, { title: "Llena", section: true });
  const seccionVacia = leanMenu(userID, { title: "Vacía", section: true });
  const seccionSoloAgotados = leanMenu(userID, { title: "Solo agotados", section: true });
  const conItems = leanMenu(userID, { title: "Con items", sectionID: seccionLlena._id });
  const sinItems = leanMenu(userID, { title: "Sin items", sectionID: seccionLlena._id });
  const agotada = leanMenu(userID, { title: "Agotada", sectionID: seccionSoloAgotados._id });
  const sueltaVacia = leanMenu(userID, { title: "Suelta vacía" });
  const sueltaAgotada = leanMenu(userID, { title: "Suelta agotada" });
  const sueltaLlena = leanMenu(userID, { title: "Suelta llena" });

  const menus = [seccionLlena, seccionVacia, seccionSoloAgotados, conItems, sinItems, agotada, sueltaVacia, sueltaAgotada, sueltaLlena];
  const items = [
    leanItem(conItems._id, { title: "A" }),
    leanItem(agotada._id, { title: "B", available: false }),
    leanItem(agotada._id, { title: "C", hidden: true }),
    leanItem(sueltaAgotada._id, { title: "D", available: false }),
    leanItem(sueltaLlena._id, { title: "E" }),
  ];

  const menu = build(menus, items);

  assert.deepEqual(menu.secciones.map((s) => s.title), ["Llena"]);
  assert.deepEqual(menu.secciones[0].categorias.map((c) => c.title), ["Con items"]);
  assert.deepEqual(menu.sinSeccion.map((c) => c.title), ["Suelta llena"]);
});

test("carta: si no queda nada, la respuesta es { secciones: [], sinSeccion: [] }", () => {
  const userID = id();
  const categoria = leanMenu(userID, { title: "Vacía" });
  assert.deepEqual(build([], []), { secciones: [], sinSeccion: [] });
  assert.deepEqual(build([categoria], []), { secciones: [], sinSeccion: [] });
  assert.deepEqual(
    build([categoria], [leanItem(categoria._id, { available: false })]),
    { secciones: [], sinSeccion: [] },
  );
  assert.deepEqual(build(undefined, undefined), { secciones: [], sinSeccion: [] });
});

test("carta: una categoría huérfana (sección oculta o inexistente) no aparece, como en la carta legacy", () => {
  const userID = id();
  const seccionOculta = leanMenu(userID, { title: "Oculta", section: true, hidden: true });
  const seccionVisible = leanMenu(userID, { title: "Visible", section: true });
  const enOculta = leanMenu(userID, { title: "En sección oculta", sectionID: seccionOculta._id });
  const enInexistente = leanMenu(userID, { title: "En sección inexistente", sectionID: id() });
  const enVisible = leanMenu(userID, { title: "En sección visible", sectionID: seccionVisible._id });
  const suelta = leanMenu(userID, { title: "Suelta" });
  const categoriaOculta = leanMenu(userID, { title: "Categoría oculta", hidden: true });

  const menus = [seccionOculta, seccionVisible, enOculta, enInexistente, enVisible, suelta, categoriaOculta];
  const items = menus.filter((m) => !m.section).map((m) => leanItem(m._id, { title: `item de ${m.title}` }));

  const menu = build(menus, items);

  assert.deepEqual(menu.secciones.map((s) => s.title), ["Visible"]);
  assert.deepEqual(menu.secciones[0].categorias.map((c) => c.title), ["En sección visible"]);
  assert.deepEqual(menu.sinSeccion.map((c) => c.title), ["Suelta"]);
  assert.doesNotMatch(JSON.stringify(menu), /oculta|inexistente/i);
});

test("carta: los items de categorías no alcanzables o desconocidas se ignoran", () => {
  const userID = id();
  const categoria = leanMenu(userID, { title: "Única" });
  const items = [
    leanItem(categoria._id, { title: "Propio" }),
    leanItem(id(), { title: "De otra categoría" }),
  ];
  const menu = build([categoria], items);
  assert.deepEqual(menu.sinSeccion[0].items.map((i) => i.title), ["Propio"]);
});

test("carta: lean sin `section` guardado se trata como categoría, y sectionID null como suelta", () => {
  const userID = id();
  const categoria = { _id: id(), userID, title: "Sin campos", sectionID: null };
  const item = { _id: id(), menuID: categoria._id, title: "Plato", price: 100 };
  assert.deepEqual(build([categoria], [item]), {
    secciones: [],
    sinSeccion: [{ title: "Sin campos", items: [{ _id: item._id, title: "Plato", price: 100 }] }],
  });
});

test("carta: aplica hidePrices y disponibilidad a todos los productos con un mismo `now`", () => {
  const userID = id();
  const categoria = leanMenu(userID, { title: "Pizzas" });
  const items = [
    leanItem(categoria._id, { title: "Con variantes", options: { Chica: 800 }, offerPrice: 1200 }),
    leanItem(categoria._id, { title: "Agotado", available: false }),
    leanItem(categoria._id, {
      title: "Nocturno",
      availabilitySchedule: schedule({ mon: [{ from: "20:00", to: "02:00" }] }),
    }),
  ];

  const conPrecios = build([categoria], items);
  assert.deepEqual(conPrecios.sinSeccion[0].items.map((i) => i.title), ["Con variantes"]);
  assert.equal(conPrecios.sinSeccion[0].items[0].price, 1500);
  assert.equal(conPrecios.sinSeccion[0].items[0].offerPrice, 1200);

  const sinPrecios = build([categoria], items, { hidePrices: true });
  assert.equal("price" in sinPrecios.sinSeccion[0].items[0], false);
  assert.equal("offerPrice" in sinPrecios.sinSeccion[0].items[0], false);
  assert.deepEqual(sinPrecios.sinSeccion[0].items[0].options, { Chica: 0 });

  // A las 21 el producto nocturno ya está disponible: `now` es el único reloj.
  const nocturno = build([categoria], items, { now: LUNES_21 });
  assert.deepEqual(nocturno.sinSeccion[0].items.map((i) => i.title), ["Con variantes", "Nocturno"]);
});

test("carta: con muchas categorías e items cada producto queda en su categoría y en su orden", () => {
  const userID = id();
  const categorias = Array.from({ length: 300 }, (_, i) => leanMenu(userID, { title: `Cat ${i}` }));
  const items = categorias.flatMap((categoria, i) =>
    Array.from({ length: 5 }, (_, j) => leanItem(categoria._id, { title: `Item ${i}-${j}` })));

  const menu = build(categorias, items);

  assert.equal(menu.sinSeccion.length, 300);
  assert.deepEqual(menu.sinSeccion[299].items.map((i) => i.title), ["Item 299-0", "Item 299-1", "Item 299-2", "Item 299-3", "Item 299-4"]);
});

test("carta: acepta documentos de Mongoose (Menu e Item) además de leans", () => {
  const userID = id();
  const seccion = new Menu({ userID, title: "Comidas", section: true });
  const categoria = new Menu({ userID, title: "Pizzas", section: false, sectionID: seccion._id });
  const item = new Item({ menuID: categoria._id, title: "Muzzarella", price: 1500, options: { Chica: 800 } });

  const menu = build([seccion, categoria], [item]);

  assert.deepEqual(menu, {
    secciones: [{
      title: "Comidas",
      categorias: [{
        title: "Pizzas",
        items: [{ _id: item._id, title: "Muzzarella", price: 1500, options: { Chica: 800 } }],
      }],
    }],
    sinSeccion: [],
  });
});

test("carta: la respuesta serializada no contiene ninguna clave prohibida, aunque el origen las traiga todas", () => {
  const userID = id();
  const seccion = leanMenu(userID, { title: "Comidas", section: true });
  const enSeccion = leanMenu(userID, { title: "Pizzas", sectionID: seccion._id, code: "CAT-1" });
  const suelta = leanMenu(userID, { title: "Bebidas", code: "CAT-2" });
  const items = [
    leanItem(enSeccion._id, {
      title: "Con todo",
      offerPrice: 1200,
      offerRange: { from: new Date("2026-08-01T00:00:00-03:00"), to: new Date("2026-08-31T00:00:00-03:00") },
      offerSchedule: offerSchedule({ mon: [{ from: "18:00", to: "20:00" }] }),
      availabilitySchedule: schedule({ mon: [{ from: "18:00", to: "20:00" }] }),
      options: { Chica: 800 },
      recommended: true,
      apt: { vegano: true },
      isExtra: true,
    }),
    leanItem(suelta._id, { title: "Simple" }),
  ];

  const menu = build([seccion, enSeccion, suelta], items);
  const json = JSON.stringify(menu);
  const keys = collectKeys(JSON.parse(json));

  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, `no debe viajar la clave ${forbidden}`);
  }
  // El item con la oferta programada vigente llevó su precio y nada más de la programación.
  const conTodo = menu.secciones[0].categorias[0].items[0];
  assert.equal(conTodo.offerPrice, 1200);
  assert.deepEqual(
    Object.keys(conTodo).sort(),
    ["_id", "apt", "description", "image", "offerPrice", "options", "price", "recommended", "title"],
  );
  // Ni los códigos ni las fechas de creación se filtran como valores.
  assert.doesNotMatch(json, /CAT-1|CAT-2|A-1|2026-01-0[12]/);
});

// ──────────────────────────────────────────────
// getReachableCategoryIds
// ──────────────────────────────────────────────

test("getReachableCategoryIds devuelve los _id de las categorías alcanzables (para pedir solo sus items)", () => {
  const userID = id();
  const seccion = leanMenu(userID, { title: "Sec", section: true });
  const enSeccion = leanMenu(userID, { title: "En sección", sectionID: seccion._id });
  const suelta = leanMenu(userID, { title: "Suelta" });
  const huerfana = leanMenu(userID, { title: "Huérfana", sectionID: id() });
  const seccionSinCategorias = leanMenu(userID, { title: "Otra", section: true });

  const ids = getReachableCategoryIds([seccion, seccionSinCategorias, enSeccion, huerfana, suelta]);

  assert.deepEqual(ids.map(String).sort(), [String(enSeccion._id), String(suelta._id)].sort());
  assert.ok(ids[0] instanceof mongoose.Types.ObjectId, "se devuelven los _id tal cual, listos para $in");
  assert.deepEqual(getReachableCategoryIds([]), []);
  assert.deepEqual(getReachableCategoryIds(undefined), []);
});

// ──────────────────────────────────────────────
// Bloque `user`
// ──────────────────────────────────────────────

test("contactInfo público: solo businessName, number, address y orderMessage; lo vacío se omite", () => {
  assert.deepEqual(
    toPublicContactInfo({
      businessName: "Café",
      number: 1123456789,
      address: "Calle 123",
      orderMessage: "Gracias",
      mail: "local@example.com",
      social: { instagram: "cafe" },
      location: { lat: 1, lng: 2 },
      reservationMessage: "Reservar",
    }),
    { businessName: "Café", number: 1123456789, address: "Calle 123", orderMessage: "Gracias" },
  );
  // number null (default del schema) y strings vacíos no viajan; el objeto siempre existe.
  assert.deepEqual(toPublicContactInfo({ businessName: "Café", number: null, address: "", orderMessage: "" }), { businessName: "Café" });
  assert.deepEqual(toPublicContactInfo({}), {});
  assert.deepEqual(toPublicContactInfo(undefined), {});
});

test("media pública: la portada y solo la primera foto; lo vacío se omite", () => {
  assert.deepEqual(
    toPublicMedia({ backgroundPicture: "https://x/fondo.jpg", pictures: ["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg"] }),
    { backgroundPicture: "https://x/fondo.jpg", pictures: ["https://x/1.jpg"] },
  );
  assert.deepEqual(toPublicMedia({ backgroundPicture: "", pictures: [] }), {});
  assert.deepEqual(toPublicMedia({ pictures: ["https://x/1.jpg"] }), { pictures: ["https://x/1.jpg"] });
  assert.deepEqual(toPublicMedia(undefined), {});
});

test("features públicas: tres booleanos explícitos, sin el resto del plan", () => {
  assert.deepEqual(
    toPublicFeatures({
      sin_publicidad: true, landing_page: true, pedido_whatsapp: false,
      menu_editor: true, programacion_productos: true, item_limit: 15, templateIds: [1],
    }),
    { sin_publicidad: true, landing_page: true, pedido_whatsapp: false },
  );
  // Una clave ausente (o no booleana) llega como false: el front compara con === true.
  assert.deepEqual(
    toPublicFeatures({ sin_publicidad: "true", landing_page: 1 }),
    { sin_publicidad: false, landing_page: false, pedido_whatsapp: false },
  );
  assert.deepEqual(toPublicFeatures(undefined), { sin_publicidad: false, landing_page: false, pedido_whatsapp: false });
});
