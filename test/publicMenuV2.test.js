const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Plan = require("../src/models/Plan");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const PageView = require("../src/models/PageView");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { getEmptySchedule } = require("../src/utils/itemAvailability");
const { getEmptyOfferSchedule } = require("../src/utils/offers");
const { fetchUserWithMenu } = require("../src/controllers/userController");
const { mockQuery } = require("../test-support/queryMock");

// ──────────────────────────────────────────────
// GET /api/users/:slug/menu?v=2 (contrato v2 de la carta pública).
//
// Los mocks históricos del repo (`async () => valor`) no encadenan
// .select/.sort/.lean; acá se usa test-support/queryMock.js, que además de
// registrar lo pedido APLICA la proyección de verdad: un campo que el
// handler olvide pedir desaparece del resultado y el test lo detecta.
// El reloj se fija (horario de Buenos Aires, -03:00): lunes 17 de agosto de
// 2026, 19:00.
// ──────────────────────────────────────────────

const NOW = new Date("2026-08-17T19:00:00-03:00");
const USER_ID = new mongoose.Types.ObjectId("64f000000000000000000123");
const OTHER_USER_ID = new mongoose.Types.ObjectId("64f000000000000000000999");
const SLUG = "cafe-de-prueba";

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const id = () => new mongoose.Types.ObjectId();

const schedule = (days, extra = {}) => ({ ...getEmptySchedule(), enabled: true, ...days, ...extra });
const offerSchedule = (days) => ({ ...getEmptyOfferSchedule(), enabled: true, ...days });

// El dueño completo, con todo lo que la carta NO debe mandar (mail, redes,
// ubicación, horario, passwords, imágenes pendientes...).
const owner = (fields = {}) => new User({
  _id: USER_ID,
  username: "cafe",
  password: "no-debe-leerse-123",
  slug: SLUG,
  active: true,
  subscription: "pro",
  subscriptionExpiresAt: new Date("2099-01-01T00:00:00Z"),
  hasDelivery: true,
  hasTakeAway: true,
  template: 3,
  menuStyle: "bistro",
  contactInfo: {
    businessName: "Café de prueba",
    mail: "local@example.com",
    number: 1123456789,
    address: "Calle Falsa 123",
    orderMessage: "Gracias por tu pedido",
    reservationMessage: "Quiero reservar",
    social: { instagram: "cafe.prueba", facebook: "cafeprueba" },
    location: { lat: -34.6, lng: -58.4 },
  },
  media: {
    backgroundPicture: "https://res.cloudinary.com/demo/image/upload/fondo.jpg",
    pictures: [
      "https://res.cloudinary.com/demo/image/upload/1.jpg",
      "https://res.cloudinary.com/demo/image/upload/2.jpg",
      "https://res.cloudinary.com/demo/image/upload/3.jpg",
    ],
  },
  pendingMenuImages: ["https://res.cloudinary.com/demo/image/upload/pendiente.jpg"],
  schedule: { mon: { enabled: true, open: "09:00", close: "18:00" } },
  panelSettings: {
    password: "panel-secreto-123",
    landingVisibility: { mail: false },
    menuDisplay: { featuredSection: false, collapsibleCategories: false, hidePrices: false },
  },
  ...fields,
});

const withMenuDisplay = (menuDisplay, fields = {}) => owner({
  panelSettings: { menuDisplay: { featuredSection: false, collapsibleCategories: false, hidePrices: false, ...menuDisplay } },
  ...fields,
});

// Carta de prueba. Devuelve los documentos tal como los guardaría Mongo:
// con sus categorías huérfanas, ocultas, de otro local (las queries y el
// serializador las descartan) y sus items agotados o fuera de horario (viajan
// con available: false).
const buildCatalog = () => {
  const comidas = new Menu({ userID: USER_ID, title: "Comidas", section: true, code: "S-1", description: "Platos" });
  const seccionOculta = new Menu({ userID: USER_ID, title: "Sección oculta", section: true, hidden: true });
  const pizzas = new Menu({ userID: USER_ID, title: "Pizzas", sectionID: comidas._id, code: "C-1", description: "Al horno", image: "https://res.cloudinary.com/demo/image/upload/cat.jpg" });
  const postres = new Menu({ userID: USER_ID, title: "Postres", sectionID: comidas._id });
  const bebidas = new Menu({ userID: USER_ID, title: "Bebidas" });
  const huerfana = new Menu({ userID: USER_ID, title: "Huérfana", sectionID: seccionOculta._id });
  const oculta = new Menu({ userID: USER_ID, title: "Categoría oculta", hidden: true });
  const deOtroLocal = new Menu({ userID: OTHER_USER_ID, title: "De otro local" });

  const muzza = new Item({
    menuID: pizzas._id,
    code: "P-1",
    title: "Muzzarella",
    description: "La de siempre",
    price: 1500,
    offerPrice: 1200,
    options: { Chica: 800, Grande: 2000 },
    image: "https://res.cloudinary.com/demo/image/upload/muzza.jpg",
    recommended: true,
    apt: { vegetariano: true },
  });
  // Oferta programada que todavía no rige: el precio viaja sin offerPrice.
  const fugazzeta = new Item({
    menuID: pizzas._id,
    title: "Fugazzeta",
    price: 1800,
    offerPrice: 1600,
    offerRange: { from: new Date("2099-01-01T00:00:00Z"), to: null },
    offerSchedule: offerSchedule({ mon: [{ from: "10:00", to: "12:00" }] }),
  });
  const agotada = new Item({ menuID: pizzas._id, title: "Agotada", price: 999, available: false });
  const nocturna = new Item({
    menuID: pizzas._id,
    title: "Nocturna",
    price: 1700,
    availabilitySchedule: schedule({ mon: [{ from: "20:00", to: "02:00" }] }),
  });
  const escondida = new Item({ menuID: pizzas._id, title: "Escondida", price: 500, hidden: true });
  const flan = new Item({ menuID: postres._id, title: "Flan agotado", price: 700, available: false });
  const agua = new Item({ menuID: bebidas._id, title: "Agua", price: 400 });
  const deHuerfana = new Item({ menuID: huerfana._id, title: "De huérfana", price: 100 });
  const deOculta = new Item({ menuID: oculta._id, title: "De oculta", price: 100 });
  const ajeno = new Item({ menuID: deOtroLocal._id, title: "Ajeno", price: 100 });

  return {
    menus: [comidas, seccionOculta, pizzas, postres, bebidas, huerfana, oculta, deOtroLocal],
    items: [muzza, fugazzeta, agotada, nocturna, escondida, flan, agua, deHuerfana, deOculta, ajeno],
    ids: { comidas, pizzas, postres, bebidas, huerfana, oculta },
  };
};

const mockPlans = (t) => t.mock.method(
  Plan,
  "findOne",
  async ({ name }) => new Plan(INITIAL_PLANS.find((plan) => plan.name === name)),
);

// Deja todo mockeado para una petición v2 y devuelve lo que pidió cada query.
const setup = (t, { user = owner(), menus, items } = {}) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const catalog = buildCatalog();
  const plan = mockPlans(t);
  const track = t.mock.method(PageView, "findOneAndUpdate", async () => ({}));
  return {
    catalog,
    plan,
    track,
    calls: {
      user: mockQuery(t, User, "findOne", user),
      menu: mockQuery(t, Menu, "find", menus ?? catalog.menus),
      item: mockQuery(t, Item, "find", items ?? catalog.items),
    },
  };
};

const getMenuV2 = async (slug = SLUG) => {
  const res = response();
  await fetchUserWithMenu({ params: { slug }, query: { v: "2" } }, res);
  return res;
};

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

const FORBIDDEN_KEYS = [
  "code", "hidden", "createdAt", "updatedAt", "__v", "userID", "menuID", "sectionID",
  "offerRange", "offerSchedule", "availabilitySchedule", "isExtra",
  "section", "subscription", "schedule",
];

const flattenItems = (menu) => [
  ...menu.secciones.flatMap((s) => s.categorias.flatMap((c) => c.items)),
  ...menu.sinSeccion.flatMap((c) => c.items),
];

// ──────────────────────────────────────────────
// Forma de la respuesta
// ──────────────────────────────────────────────

test("v2: 404 si el local no existe o está inactivo, sin tocar menús, items, plan ni visitas", async (t) => {
  const { calls, plan, track } = setup(t, { user: null });

  const res = await getMenuV2("no-existe");

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Local no encontrado" });
  assert.equal(calls.menu.length, 0);
  assert.equal(calls.item.length, 0);
  assert.equal(plan.mock.callCount(), 0);
  assert.equal(track.mock.callCount(), 0);
});

test("v2: un local inactivo no se sirve (el filtro active:true lo deja afuera)", async (t) => {
  const { calls, track } = setup(t, { user: owner({ active: false }) });

  const res = await getMenuV2();

  assert.equal(res.statusCode, 404);
  assert.deepEqual(calls.user[0].filter, { slug: SLUG, active: true });
  assert.equal(track.mock.callCount(), 0);
});

test("v2: el slug se normaliza igual que en la carta legacy", async (t) => {
  const { calls } = setup(t);

  const res = await getMenuV2("  Café De Prueba ");

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.user[0].filter, { slug: SLUG, active: true });
});

test("v2: el bloque user es una whitelist y la carta trae solo lo que se dibuja", async (t) => {
  setup(t);

  const res = await getMenuV2();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body), ["user", "menu"]);
  assert.deepEqual(res.body.user, {
    contactInfo: {
      businessName: "Café de prueba",
      number: 1123456789,
      address: "Calle Falsa 123",
      orderMessage: "Gracias por tu pedido",
    },
    media: {
      backgroundPicture: "https://res.cloudinary.com/demo/image/upload/fondo.jpg",
      // Solo la primera foto: es la que usa BusinessSEO.
      pictures: ["https://res.cloudinary.com/demo/image/upload/1.jpg"],
    },
    hasDelivery: true,
    hasTakeAway: true,
    template: 3,
    menuStyle: "bistro",
    features: { sin_publicidad: true, landing_page: true, pedido_whatsapp: true },
    menuDisplay: { featuredSection: false, collapsibleCategories: false, hidePrices: false },
  });
  assert.deepEqual(
    Object.keys(res.body.user).sort(),
    ["contactInfo", "features", "hasDelivery", "hasTakeAway", "media", "menuDisplay", "menuStyle", "template"],
  );
});

test("v2: la carta arma secciones y categorías sueltas, poda lo vacío y descarta lo que no se ve", async (t) => {
  const { catalog } = setup(t);
  const [muzza, fugazzeta, agotada, nocturna, , flan, agua] = catalog.items;

  const res = await getMenuV2();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.menu, {
    secciones: [{
      title: "Comidas",
      categorias: [{
        title: "Pizzas",
        items: [
          {
            _id: muzza._id,
            title: "Muzzarella",
            price: 1500,
            offerPrice: 1200,
            description: "La de siempre",
            image: "https://res.cloudinary.com/demo/image/upload/muzza.jpg",
            options: { Chica: 800, Grande: 2000 },
            recommended: true,
            apt: { vegetariano: true },
          },
          // La oferta programada no rige todavía: el precio viaja sin offerPrice.
          { _id: fugazzeta._id, title: "Fugazzeta", price: 1800 },
          // Pausada y fuera de horario (lunes 19:00, abre a las 20:00): viajan
          // como no disponibles.
          { _id: agotada._id, title: "Agotada", price: 999, available: false },
          { _id: nocturna._id, title: "Nocturna", price: 1700, available: false },
        ],
      }, {
        title: "Postres",
        items: [{ _id: flan._id, title: "Flan agotado", price: 700, available: false }],
      }],
    }],
    sinSeccion: [{ title: "Bebidas", items: [{ _id: agua._id, title: "Agua", price: 400 }] }],
  });

  // No viajan la huérfana, la oculta, la de otro local ni el producto oculto.
  const titles = JSON.stringify(res.body.menu);
  for (const hidden of ["Huérfana", "oculta", "otro local", "Escondida", "Ajeno"]) {
    assert.equal(titles.includes(hidden), false, `${hidden} no debe viajar`);
  }
});

test("v2: la respuesta no contiene ninguna clave prohibida ni datos que la carta no usa", async (t) => {
  setup(t);

  const res = await getMenuV2();
  const json = JSON.stringify(res.body);
  const keys = collectKeys(JSON.parse(json));

  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, `no debe viajar la clave ${forbidden}`);
  }
  // available solo viaja en false (los disponibles no llevan la clave).
  for (const item of flattenItems(res.body.menu)) {
    assert.ok(!("available" in item) || item.available === false, `${item.title}: available solo en false`);
  }
  assert.equal("_id" in res.body.user, false, "user no lleva _id");
  for (const category of [...res.body.menu.secciones.flatMap((s) => s.categorias), ...res.body.menu.sinSeccion]) {
    assert.deepEqual(Object.keys(category), ["title", "items"]);
  }
  for (const section of res.body.menu.secciones) {
    assert.deepEqual(Object.keys(section), ["title", "categorias"]);
  }
  // Ni los valores sensibles del dueño ni códigos de categorías/productos.
  assert.doesNotMatch(json, /local@example\.com|cafe\.prueba|cafeprueba|no-debe-leerse|panel-secreto|pendiente\.jpg|Quiero reservar|C-1|S-1|P-1|-34\.6/);
  // Las imágenes de categorías no se mandan: solo las de los productos.
  assert.doesNotMatch(json, /cat\.jpg|2\.jpg|3\.jpg/);
});

test("v2: sin menús no hay items que pedir: la respuesta es una carta vacía", async (t) => {
  const { calls } = setup(t, { menus: [], items: [] });

  const res = await getMenuV2();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.menu, { secciones: [], sinSeccion: [] });
  assert.equal(calls.menu.length, 1);
  assert.equal(calls.item.length, 0, "sin categorías alcanzables se ahorra el round-trip de items");
});

test("v2: contactInfo omite lo vacío (number null, address y orderMessage sin cargar)", async (t) => {
  setup(t, { user: owner({ contactInfo: { businessName: "Solo nombre", mail: "local@example.com" } }) });

  const res = await getMenuV2();

  assert.deepEqual(res.body.user.contactInfo, { businessName: "Solo nombre" });
});

test("v2: media omite lo vacío y siempre existe", async (t) => {
  setup(t, { user: owner({ media: { pictures: [], backgroundPicture: "" } }) });

  const res = await getMenuV2();

  assert.deepEqual(res.body.user.media, {});
});

// ──────────────────────────────────────────────
// Lo que se le pide a Mongo
// ──────────────────────────────────────────────

test("v2: user sin lean y con proyección mínima; menús e items lean, con proyección y orden explícitos", async (t) => {
  const { calls, catalog } = setup(t);

  await getMenuV2();

  // (a) user: findOne con la proyección mínima, sin lean (un solo documento).
  assert.equal(calls.user.length, 1);
  const [userCall] = calls.user;
  assert.deepEqual(userCall.filter, { slug: SLUG, active: true });
  assert.equal(userCall.lean, false);
  const userFields = userCall.select.split(/\s+/);
  for (const field of [
    "contactInfo.businessName", "contactInfo.number", "contactInfo.address", "contactInfo.orderMessage",
    "media", "hasDelivery", "hasTakeAway", "template", "menuStyle", "subscription", "subscriptionExpiresAt", "panelSettings.menuDisplay",
  ]) {
    assert.ok(userFields.includes(field), `el user debe pedir ${field}`);
  }
  for (const field of userFields) {
    assert.doesNotMatch(field, /password|mail$|social|location|reservationMessage|pendingMenuImages|schedule|landingVisibility|lastConnection|assignedSeller|sellerID/);
    assert.equal(field.startsWith("-") || field.startsWith("+"), false, "solo inclusión: nada de exclusiones ni +campos");
  }

  // (b) menús: solo los visibles del local, con título/tipo/sección, en el
  // orden que eligió el dueño (y a igualdad, el de creación).
  assert.equal(calls.menu.length, 1);
  const [menuCall] = calls.menu;
  assert.deepEqual(menuCall.filter, { userID: USER_ID, hidden: false });
  assert.equal(menuCall.select, "title section sectionID");
  assert.deepEqual(menuCall.sort, { order: 1, _id: 1 });
  assert.equal(menuCall.lean, true);

  // (c) items: solo de las categorías alcanzables (no la huérfana ni la oculta).
  assert.equal(calls.item.length, 1);
  const [itemCall] = calls.item;
  const { ids } = catalog;
  assert.deepEqual(
    itemCall.filter.menuID.$in.map(String).sort(),
    [ids.pizzas, ids.postres, ids.bebidas].map((menu) => String(menu._id)).sort(),
  );
  assert.equal(itemCall.filter.hidden, false);
  assert.deepEqual(Object.keys(itemCall.filter).sort(), ["hidden", "menuID"]);
  assert.deepEqual(itemCall.sort, { order: 1, _id: 1 });
  assert.equal(itemCall.lean, true);
  assert.equal(itemCall.batchSize, 2000, "un solo batch: sin getMore para cartas de cientos de productos");

  const itemFields = itemCall.select.split(/\s+/);
  for (const field of [
    "menuID", "title", "price", "offerPrice", "offerRange", "offerSchedule", "available",
    "availabilitySchedule", "description", "image", "options", "recommended", "apt",
  ]) {
    assert.ok(itemFields.includes(field), `el item debe pedir ${field}`);
  }
  for (const field of ["code", "isExtra", "hidden", "createdAt", "updatedAt", "__v"]) {
    assert.equal(itemFields.includes(field), false, `el item no debe pedir ${field}`);
  }
});

test("v2: la carta sale en el orden que eligió el dueño, con lo anterior al campo primero", async (t) => {
  const comidas = new Menu({ userID: USER_ID, title: "Comidas", section: true, order: 1 });
  const bebidas = new Menu({ userID: USER_ID, title: "Bebidas", section: true, order: 0 });
  const pizzas = new Menu({ userID: USER_ID, title: "Pizzas", sectionID: comidas._id, order: 1 });
  const empanadas = new Menu({ userID: USER_ID, title: "Empanadas", sectionID: comidas._id, order: 0 });
  const gaseosas = new Menu({ userID: USER_ID, title: "Gaseosas", sectionID: bebidas._id });
  setup(t, {
    menus: [comidas, bebidas, pizzas, empanadas, gaseosas],
    items: [
      new Item({ menuID: pizzas._id, title: "Última", price: 100, order: 2 }),
      new Item({ menuID: pizzas._id, title: "Segunda", price: 100, order: 0 }),
      new Item({ menuID: pizzas._id, title: "Primera, anterior al campo", price: 100 }),
      new Item({ menuID: empanadas._id, title: "Carne", price: 100 }),
      new Item({ menuID: gaseosas._id, title: "Agua", price: 100 }),
    ],
  });

  const res = await getMenuV2();

  assert.equal(res.statusCode, 200);
  const { secciones } = res.body.menu;
  assert.deepEqual(secciones.map((sec) => sec.title), ["Bebidas", "Comidas"]);
  assert.deepEqual(secciones[1].categorias.map((cat) => cat.title), ["Empanadas", "Pizzas"]);
  assert.deepEqual(
    secciones[1].categorias[1].items.map((item) => item.title),
    ["Primera, anterior al campo", "Segunda", "Última"],
  );
});

test("v2: son 3 pasos (user, plan + menús en paralelo, items) y el plan se lee en cada petición", async (t) => {
  const { calls, plan } = setup(t);

  await getMenuV2();
  assert.equal(plan.mock.callCount(), 1);
  assert.equal(calls.user.length, 1);
  assert.equal(calls.menu.length, 1);
  assert.equal(calls.item.length, 1);

  // Sin cache compartida: la segunda petición vuelve a leer todo (y cuenta otra visita).
  await getMenuV2();
  assert.equal(plan.mock.callCount(), 2);
  assert.equal(calls.user.length, 2);
  assert.equal(calls.menu.length, 2);
  assert.equal(calls.item.length, 2);
});

test("v2: el plan y los menús se piden en paralelo, y los items recién cuando ya se conocen las categorías", async (t) => {
  const order = [];
  const { catalog } = setup(t);
  t.mock.method(Plan, "findOne", async ({ name }) => {
    order.push("plan:start");
    await new Promise((resolve) => setImmediate(resolve));
    order.push("plan:end");
    return new Plan(INITIAL_PLANS.find((plan) => plan.name === name));
  });
  mockQuery(t, Menu, "find", (filter) => {
    order.push("menu:start");
    return catalog.menus.filter((menu) => String(menu.userID) === String(filter.userID) && !menu.hidden);
  });
  mockQuery(t, Item, "find", () => {
    order.push("items:start");
    return catalog.items;
  });

  await getMenuV2();

  // Plan y menús arrancan antes de que el plan termine; los items, después de ambos.
  assert.deepEqual(order.slice(0, 2), ["plan:start", "menu:start"]);
  assert.ok(order.indexOf("items:start") > order.indexOf("plan:end"));
  assert.ok(order.indexOf("items:start") > order.indexOf("menu:start"));
});

test("v2: cuenta una visita del local por petición, con upsert y sin esperarla", async (t) => {
  const { track } = setup(t);

  const res = await getMenuV2();

  assert.equal(res.statusCode, 200);
  assert.equal(track.mock.callCount(), 1);
  const [filter, update, options] = track.mock.calls[0].arguments;
  assert.equal(String(filter.userID), String(USER_ID));
  assert.match(filter.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(update, { $inc: { count: 1 } });
  assert.deepEqual(options, { upsert: true });
});

test("v2: un fallo del contador de visitas no rompe la carta", async (t) => {
  setup(t);
  t.mock.method(PageView, "findOneAndUpdate", async () => { throw new Error("contador caído"); });

  const res = await getMenuV2();

  assert.equal(res.statusCode, 200);
  assert.equal(flattenItems(res.body.menu).length, 6);
});

// ──────────────────────────────────────────────
// Plan, oferta, disponibilidad y "Ocultar precios"
// ──────────────────────────────────────────────

test("v2: plan Free recorta template, menuStyle y features, y no aplica la programación", async (t) => {
  setup(t, {
    user: owner({ subscription: "free", subscriptionExpiresAt: null, template: 7, menuStyle: "coffee" }),
  });

  const res = await getMenuV2();

  assert.equal(res.statusCode, 200);
  // Free: una sola plantilla y solo las familias abiertas a todos los planes.
  assert.equal(res.body.user.template, 1);
  assert.equal(res.body.user.menuStyle, "classic");
  assert.deepEqual(res.body.user.features, { sin_publicidad: false, landing_page: true, pedido_whatsapp: true });

  const items = flattenItems(res.body.menu);
  const byTitle = Object.fromEntries(items.map((item) => [item.title, item]));
  // Sin programacion_productos el horario no restringe: la nocturna está disponible...
  assert.equal("available" in byTitle.Nocturna, false, "sin el permiso el horario de disponibilidad se ignora");
  // ...la oferta programada se ignora, pero la manual (sin rango ni horario) rige.
  assert.equal("offerPrice" in byTitle.Fugazzeta, false);
  assert.equal(byTitle.Muzzarella.offerPrice, 1200);
  // El interruptor manual sigue mandando en cualquier plan.
  assert.equal(byTitle.Agotada.available, false);
});

test("v2: una suscripción paga vencida se sirve con las funciones de Free", async (t) => {
  setup(t, {
    user: owner({ subscription: "pro", subscriptionExpiresAt: new Date("2026-08-01T00:00:00Z"), template: 7 }),
  });

  const res = await getMenuV2();

  assert.equal(res.body.user.template, 1);
  assert.deepEqual(res.body.user.features, { sin_publicidad: false, landing_page: true, pedido_whatsapp: true });
});

test("v2: plan Pro conserva template y familia visual, y aplica el horario de disponibilidad", async (t) => {
  setup(t, { user: owner({ template: 7, menuStyle: "coffee" }) });

  const res = await getMenuV2();

  assert.equal(res.body.user.template, 7);
  assert.equal(res.body.user.menuStyle, "coffee");
  const nocturna = flattenItems(res.body.menu).find((item) => item.title === "Nocturna");
  // Lunes 19:00: la nocturna (20:00-02:00) todavía no está disponible.
  assert.equal(nocturna.available, false);
});

test("v2: el horario nocturno y la oferta programada cambian con la hora, sin estado escondido", async (t) => {
  const { catalog } = setup(t);
  // La oferta de la fugazzeta rige los lunes de 10 a 12 desde el 1/8/2026.
  const fugazzeta = catalog.items[1];
  fugazzeta.offerRange = { from: new Date("2026-08-01T00:00:00-03:00"), to: null };

  const at = async (iso) => {
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ["Date"], now: new Date(iso) });
    return flattenItems((await getMenuV2()).body.menu).reduce((acc, item) => ({ ...acc, [item.title]: item }), {});
  };

  const lunes11 = await at("2026-08-17T11:00:00-03:00");
  assert.equal(lunes11.Fugazzeta.offerPrice, 1600);
  assert.equal(lunes11.Nocturna.available, false);

  const lunes21 = await at("2026-08-17T21:00:00-03:00");
  assert.equal("offerPrice" in lunes21.Fugazzeta, false);
  assert.equal("available" in lunes21.Nocturna, false);

  const martes01 = await at("2026-08-18T01:00:00-03:00");
  assert.equal("available" in martes01.Nocturna, false, "el horario nocturno sigue vigente pasada la medianoche");
  const martes03 = await at("2026-08-18T03:00:00-03:00");
  assert.equal(martes03.Nocturna.available, false);
});

// Cada campo que decide vigencia o disponibilidad es lo ÚNICO que distingue a
// su producto de uno común: si el select del handler lo olvidara, la
// proyección lo quitaría (queryMock la aplica de verdad) y el producto
// viajaría con una oferta que no rige o sin excluirse.
test("v2: cada campo del select cumple su función (una proyección incompleta se detectaría)", async (t) => {
  const suelta = new Menu({ userID: USER_ID, title: "Suelta" });
  const item = (title, fields) => new Item({ menuID: suelta._id, title, price: 1000, ...fields });
  const items = [
    item("Control"),
    item("Oferta por fechas", { offerPrice: 800, offerRange: { from: new Date("2099-01-01T00:00:00Z"), to: null } }),
    item("Oferta por horario", { offerPrice: 800, offerSchedule: offerSchedule({ mon: [{ from: "10:00", to: "12:00" }] }) }),
    item("Oferta manual", { offerPrice: 800 }),
    item("Agotado", { available: false }),
    item("Fuera de horario", { availabilitySchedule: schedule({ mon: [{ from: "10:00", to: "12:00" }] }) }),
    item("Con variantes", { options: { Chica: 1 } }),
    item("Recomendado", { recommended: true }),
    item("Con apt", { apt: { celiaco: true } }),
    item("Con descripción e imagen", { description: "Rico", image: "https://res.cloudinary.com/demo/image/upload/a.jpg" }),
  ];
  setup(t, { menus: [suelta], items });

  const res = await getMenuV2();

  const byTitle = Object.fromEntries(res.body.menu.sinSeccion[0].items.map((entry) => [entry.title, entry]));
  assert.deepEqual(Object.keys(byTitle), [
    "Control", "Oferta por fechas", "Oferta por horario", "Oferta manual", "Agotado", "Fuera de horario",
    "Con variantes", "Recomendado", "Con apt", "Con descripción e imagen",
  ]);
  assert.equal("available" in byTitle.Control, false);
  assert.equal(byTitle.Agotado.available, false, "available");
  assert.equal(byTitle["Fuera de horario"].available, false, "availabilitySchedule");
  assert.equal("offerPrice" in byTitle["Oferta por fechas"], false, "offerRange futuro");
  assert.equal("offerPrice" in byTitle["Oferta por horario"], false, "offerSchedule fuera de horario");
  assert.equal(byTitle["Oferta manual"].offerPrice, 800);
  assert.deepEqual(byTitle["Con variantes"].options, { Chica: 1 });
  assert.equal(byTitle.Recomendado.recommended, true);
  assert.deepEqual(byTitle["Con apt"].apt, { celiaco: true });
  assert.equal(byTitle["Con descripción e imagen"].description, "Rico");
  assert.equal(byTitle["Con descripción e imagen"].image, "https://res.cloudinary.com/demo/image/upload/a.jpg");
});

test("v2: con Ocultar precios no viaja ningún precio y las variantes conservan sus nombres en 0", async (t) => {
  setup(t, { user: withMenuDisplay({ hidePrices: true }) });

  const res = await getMenuV2();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.menuDisplay.hidePrices, true);
  const items = flattenItems(res.body.menu);
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.equal("price" in item, false, `${item.title} no debe llevar price`);
    assert.equal("offerPrice" in item, false, `${item.title} no debe llevar offerPrice`);
  }
  const muzza = items.find((item) => item.title === "Muzzarella");
  assert.deepEqual(muzza.options, { Chica: 0, Grande: 0 });
  assert.equal(muzza.description, "La de siempre");
  assert.doesNotMatch(JSON.stringify(res.body), /:(1500|1200|1800|800|2000|400)\b/);
});

test("v2: menuDisplay viaja como en la carta legacy (solo un true guardado activa cada opción)", async (t) => {
  setup(t, {
    user: withMenuDisplay({ featuredSection: true, collapsibleCategories: true, hidePrices: false }),
  });

  const res = await getMenuV2();

  assert.deepEqual(res.body.user.menuDisplay, { featuredSection: true, collapsibleCategories: true, hidePrices: false });
});

test("v2: un local sin nada guardado en panelSettings ni en el resto de los campos usa los defaults del schema", async (t) => {
  setup(t, {
    user: new User({
      _id: USER_ID,
      slug: SLUG,
      contactInfo: { businessName: "Mínimo", mail: "local@example.com" },
    }),
  });

  const res = await getMenuV2();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.user, {
    contactInfo: { businessName: "Mínimo" },
    media: {},
    hasDelivery: false,
    hasTakeAway: false,
    template: 1,
    menuStyle: "classic",
    features: { sin_publicidad: false, landing_page: true, pedido_whatsapp: true },
    menuDisplay: { featuredSection: false, collapsibleCategories: false, hidePrices: false },
  });
});

// ──────────────────────────────────────────────
// Contrato legacy intacto y despacho
// ──────────────────────────────────────────────

// Mocks a la vieja usanza (Promises nativas sin .select/.lean): la carta legacy
// no encadena, y estos tests no deben cambiar por la existencia de v2.
const mockLegacy = (t, { user = owner(), menus, items } = {}) => {
  const catalog = buildCatalog();
  mockPlans(t);
  t.mock.method(PageView, "findOneAndUpdate", async () => ({}));
  const userMock = t.mock.method(User, "findOne", async () => user);
  const menuMock = t.mock.method(Menu, "find", async () => (menus ?? catalog.menus).filter((menu) => !menu.hidden && String(menu.userID) === String(USER_ID)));
  const itemMock = t.mock.method(Item, "find", async () => (items ?? catalog.items).filter((item) => !item.hidden));
  return { catalog, userMock, menuMock, itemMock };
};

for (const [name, req] of [
  ["sin query (los tests históricos llaman solo con params)", { params: { slug: SLUG } }],
  ["con query vacía", { params: { slug: SLUG }, query: {} }],
  ["con otra versión (v=1)", { params: { slug: SLUG }, query: { v: "1" } }],
  ["con v=2 repetido (llega como arreglo)", { params: { slug: SLUG }, query: { v: ["2", "2"] } }],
  ["con un parámetro ajeno", { params: { slug: SLUG }, query: { debug: "2" } }],
]) {
  test(`el contrato legacy sigue idéntico ${name}`, async (t) => {
    const { userMock, menuMock, itemMock } = mockLegacy(t);
    const res = response();

    await fetchUserWithMenu(req, res);

    assert.equal(res.statusCode, 200);
    // Forma legacy: user completo con _id, subscription, schedule, features y media completos.
    assert.deepEqual(
      Object.keys(res.body.user).sort(),
      ["_id", "contactInfo", "features", "hasDelivery", "media", "menuDisplay", "menuStyle", "schedule", "subscription", "template"],
    );
    assert.equal(String(res.body.user._id), String(USER_ID));
    assert.equal(res.body.user.subscription, "pro");
    assert.equal(res.body.user.contactInfo.number, 1123456789);
    assert.equal(res.body.user.contactInfo.location.lat, -34.6);
    assert.equal(res.body.user.media.pictures.length, 3);
    assert.ok(res.body.user.features.menu_editor);

    // Categorías con todos sus campos; items con available y sin poda.
    const [seccion] = res.body.menu.secciones;
    assert.equal(seccion.title, "Comidas");
    assert.equal(seccion.code, "S-1");
    assert.equal(seccion.description, "Platos");
    assert.ok(seccion._id);
    const pizzas = seccion.categorias.find((categoria) => categoria.title === "Pizzas");
    assert.equal(pizzas.code, "C-1");
    assert.deepEqual(pizzas.items.map((item) => item.title), ["Muzzarella", "Fugazzeta", "Agotada", "Nocturna"]);
    assert.equal(pizzas.items.find((item) => item.title === "Agotada").available, false);
    assert.equal(pizzas.items[0].offerRange.from, null);
    assert.equal(pizzas.items[1].offerPrice, null);
    // La categoría sin items visibles (todo agotado) NO se poda en el contrato legacy.
    assert.deepEqual(seccion.categorias.map((categoria) => categoria.title), ["Pizzas", "Postres"]);
    assert.equal(seccion.categorias[1].items.length, 1);

    // Las queries legacy siguen siendo las de siempre: sin proyección ni lean.
    assert.deepEqual(userMock.mock.calls[0].arguments, [{ slug: SLUG, active: true }]);
    assert.deepEqual(menuMock.mock.calls[0].arguments, [{ userID: USER_ID, hidden: false }]);
    assert.equal(itemMock.mock.calls[0].arguments[0].hidden, false);
    assert.equal(itemMock.mock.callCount(), 1);
  });
}

test("con ?v=2 los mocks legacy (sin .select) no sirven: el handler despachado encadena queries", async (t) => {
  mockLegacy(t);
  t.mock.method(console, "error", () => {});
  const res = response();

  await fetchUserWithMenu({ params: { slug: SLUG }, query: { v: "2" } }, res);

  // Demuestra que ?v=2 entra por el handler nuevo (que encadena) y no por el legacy.
  assert.equal(res.statusCode, 500);
});

test("v2 y legacy muestran los mismos productos, con los mismos precios, en el mismo orden", async (t) => {
  const catalog = buildCatalog();
  const now = NOW;
  t.mock.timers.enable({ apis: ["Date"], now });
  const user = owner();
  const legacyMocks = mockLegacy(t, { user, menus: catalog.menus, items: catalog.items });
  const legacy = response();
  await fetchUserWithMenu({ params: { slug: SLUG } }, legacy);
  for (const mocked of [legacyMocks.userMock, legacyMocks.menuMock, legacyMocks.itemMock]) mocked.mock.restore();

  mockQuery(t, User, "findOne", user);
  mockQuery(t, Menu, "find", catalog.menus);
  mockQuery(t, Item, "find", catalog.items);
  const v2 = await getMenuV2();

  // Lo que el contrato v2 conserva del legacy: los mismos productos (los no
  // disponibles con available: false), con los campos que la carta dibuja, sin
  // lo vacío y sin categorías ni secciones vacías.
  const fromLegacy = (item) => {
    const shown = { _id: item._id, title: item.title };
    if (item.available === false) shown.available = false;
    if (item.price != null) {
      shown.price = item.price;
      if (item.offerPrice != null) shown.offerPrice = item.offerPrice;
    }
    if (item.description) shown.description = item.description;
    if (item.image) shown.image = item.image;
    if (item.options && Object.keys(item.options).length) shown.options = item.options;
    if (item.recommended) shown.recommended = true;
    if (item.apt && Object.keys(item.apt).length) shown.apt = item.apt;
    return shown;
  };
  const category = (cat) => ({ title: cat.title, items: cat.items.map(fromLegacy) });
  const expected = {
    secciones: legacy.body.menu.secciones
      .map((sec) => ({ title: sec.title, categorias: sec.categorias.map(category).filter((cat) => cat.items.length) }))
      .filter((sec) => sec.categorias.length),
    sinSeccion: legacy.body.menu.sinSeccion.map(category).filter((cat) => cat.items.length),
  };

  assert.deepEqual(JSON.parse(JSON.stringify(v2.body.menu)), JSON.parse(JSON.stringify(expected)));
  // Y lo mismo del lado del local: los valores de los campos que sí viajan coinciden.
  assert.equal(v2.body.user.template, legacy.body.user.template);
  assert.equal(v2.body.user.menuStyle, legacy.body.user.menuStyle);
  assert.equal(v2.body.user.hasDelivery, legacy.body.user.hasDelivery);
  assert.deepEqual(v2.body.user.menuDisplay, legacy.body.user.menuDisplay);
  for (const key of ["sin_publicidad", "landing_page", "pedido_whatsapp"]) {
    assert.equal(v2.body.user.features[key], legacy.body.user.features[key]);
  }
  assert.equal(v2.body.user.contactInfo.businessName, legacy.body.user.contactInfo.businessName);
});

// ──────────────────────────────────────────────
// Errores
// ──────────────────────────────────────────────

const failing = (message) => () => { throw new Error(message); };

for (const [name, model, method] of [
  ["del usuario", User, "findOne"],
  ["de los menús", Menu, "find"],
  ["de los items", Item, "find"],
]) {
  test(`v2: si falla la lectura ${name}, responde 500 por handleError sin filtrar el error`, async (t) => {
    setup(t);
    t.mock.method(console, "error", () => {});
    mockQuery(t, model, method, failing("mongo interno: E11000 secreto"));

    const res = await getMenuV2();

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: "Ocurrió un error interno. Intentá de nuevo." });
    assert.doesNotMatch(JSON.stringify(res.body), /mongo interno|E11000/);
  });
}

test("v2: contactInfo incluye los WhatsApp por sucursal y omite la lista vacía", () => {
  const { toPublicContactInfo } = require("../src/utils/publicMenu");
  assert.deepEqual(
    toPublicContactInfo({ businessName: "X", whatsappNumbers: [{ name: "Centro", number: "1133334444" }] }),
    { businessName: "X", whatsappNumbers: [{ name: "Centro", number: "1133334444" }] },
  );
  assert.deepEqual(toPublicContactInfo({ businessName: "X", whatsappNumbers: [] }), { businessName: "X" });
});
