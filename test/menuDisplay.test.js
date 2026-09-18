const test = require("node:test");
const assert = require("node:assert/strict");
const Plan = require("../src/models/Plan");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const PageView = require("../src/models/PageView");
const { getEmptyOfferSchedule } = require("../src/utils/offers");
const { buildMenuHTML } = require("../src/utils/menuPdfTemplate");

// userController.js importa getBrowser por destructuring, así que no se puede
// mockear con t.mock.method: se reemplaza en el módulo ANTES de requerir el
// controller. En vez de levantar Chrome, guarda el HTML que se iba a
// imprimir para poder revisar qué precios lleva el PDF.
const pdfBrowser = require("../src/utils/pdfBrowser");
let printedHtml;
pdfBrowser.getBrowser = async () => ({
  newPage: async () => ({
    setContent: async (html) => { printedHtml = html; },
    pdf: async () => new Uint8Array([1, 2, 3]),
    close: async () => {},
  }),
});

const {
  fetchUserWithMenu,
  downloadMenuPdf,
  fetchOwnMenu,
  getPanelSettingsStatus,
  verifyPanelSettingsPassword,
  updatePanelSettings,
} = require("../src/controllers/userController");

// ──────────────────────────────────────────────
// Tarjetas "Destacados", "Categorías desplegables" y "Ocultar precios":
// panelSettings.menuDisplay.
// ──────────────────────────────────────────────

const ALL_OFF = { featuredSection: false, collapsibleCategories: false, hidePrices: false };

const contact = {
  businessName: "Café de prueba",
  mail: "local@example.com",
  number: 1123456789,
};

const USER_ID = "64f000000000000000000123";

const response = () => ({
  statusCode: 200,
  body: null,
  headers: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  set(headers) { this.headers = headers; return this; },
  send(body) { this.body = body; return this; },
});

const ars = (value) => new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 0,
}).format(value);

// Una categoría con dos productos: uno con oferta vigente y variantes, y otro
// con una oferta programada (rango + horario semanal) que todavía no rige.
const buildMenu = () => {
  const categoria = new Menu({ userID: USER_ID, title: "Pizzas", section: false });
  const items = [
    new Item({
      menuID: categoria._id,
      title: "Muzzarella",
      description: "La de siempre",
      price: 1500,
      offerPrice: 1200,
      options: { Chica: 800, Grande: 2000 },
      recommended: true,
    }),
    new Item({
      menuID: categoria._id,
      title: "Fugazzeta",
      price: 1800,
      offerPrice: 1600,
      offerRange: { from: new Date("2099-01-01"), to: null },
      offerSchedule: { enabled: true, mon: [{ from: "10:00", to: "12:00" }] },
    }),
  ];
  return { categoria, items };
};

const mockPublicMenu = (t, menuDisplay) => {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find(plan => plan.name === name)));
  const user = {
    _id: USER_ID,
    slug: "cafe-de-prueba",
    template: 1,
    subscription: "pro",
    subscriptionExpiresAt: new Date("2099-01-01"),
    contactInfo: structuredClone(contact),
    panelSettings: menuDisplay === undefined ? undefined : { menuDisplay },
  };
  const { categoria, items } = buildMenu();
  t.mock.method(User, "findOne", async () => user);
  t.mock.method(Menu, "find", async () => [categoria]);
  t.mock.method(PageView, "findOneAndUpdate", async () => ({}));
  return { user, items };
};

const publicItems = (res) => res.body.menu.sinSeccion[0].items;

test("el modelo arranca con las opciones de la carta apagadas", () => {
  const user = new User({ contactInfo: contact });
  assert.deepEqual(user.toObject().panelSettings.menuDisplay, ALL_OFF);
});

test("carta: sin configuración guardada viaja todo apagado y con precios", async (t) => {
  const { items } = mockPublicMenu(t, undefined);
  t.mock.method(Item, "find", async () => items);
  const res = response();
  await fetchUserWithMenu({ params: { slug: "cafe-de-prueba" } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.user.menuDisplay, ALL_OFF);
  const [muzza, fugazzeta] = publicItems(res);
  assert.equal(muzza.price, 1500);
  assert.equal(muzza.offerPrice, 1200);
  assert.deepEqual(muzza.options, { Chica: 800, Grande: 2000 });
  assert.equal(fugazzeta.price, 1800);
  assert.equal(fugazzeta.offerRange.from.toISOString(), "2099-01-01T00:00:00.000Z");
  assert.equal(fugazzeta.offerSchedule.enabled, true);
});

test("carta: solo un `true` guardado activa cada opción", async (t) => {
  const { items } = mockPublicMenu(t, { featuredSection: true, collapsibleCategories: "true" });
  t.mock.method(Item, "find", async () => items);
  const res = response();
  await fetchUserWithMenu({ params: { slug: "cafe-de-prueba" } }, res);

  assert.deepEqual(res.body.user.menuDisplay, { ...ALL_OFF, featuredSection: true });
  // Destacados y desplegables son solo de presentación: los precios siguen.
  assert.equal(publicItems(res)[0].price, 1500);
});

test("carta: con precios ocultos los items viajan sin precios pero con los nombres de las variantes", async (t) => {
  const { items } = mockPublicMenu(t, { hidePrices: true });
  t.mock.method(Item, "find", async () => items);
  const res = response();
  await fetchUserWithMenu({ params: { slug: "cafe-de-prueba" } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.user.menuDisplay, { ...ALL_OFF, hidePrices: true });
  const [muzza, fugazzeta] = publicItems(res);
  for (const item of [muzza, fugazzeta]) {
    assert.equal(item.price, null);
    assert.equal(item.offerPrice, null);
    assert.deepEqual(item.offerRange, { from: null, to: null });
    assert.deepEqual(item.offerSchedule, getEmptyOfferSchedule());
  }
  assert.deepEqual(muzza.options, { Chica: 0, Grande: 0 });
  assert.deepEqual(fugazzeta.options, {});
  // El resto del producto queda igual.
  assert.equal(muzza.title, "Muzzarella");
  assert.equal(muzza.description, "La de siempre");
  assert.equal(muzza.recommended, true);
  assert.equal(muzza.available, true);
  // Ningún precio queda en los items, ni siquiera anidado. Los ObjectId se
  // dejan afuera: son hex al azar y pueden contener "800" sin ser un precio.
  const json = JSON.stringify(publicItems(res), (key, value) =>
    key === "_id" || key === "menuID" ? undefined : value);
  for (const price of [1500, 1200, 800, 2000, 1800, 1600]) {
    assert.equal(json.includes(String(price)), false, `el precio ${price} no debe viajar`);
  }
  // No muta los documentos: hideItemPrices arma un objeto nuevo y deja el
  // documento con sus precios (el editor los necesita).
  assert.equal(items[0].price, 1500);
  assert.equal(items[0].options.get("Chica"), 800);
});

// Todos los precios del menú de prueba, incluida la oferta programada de la
// Fugazzeta (1600), que no rige pero tampoco debe filtrarse.
const MENU_PRICES = [1500, 1200, 800, 2000, 1800, 1600];

// Clases del template que solo existen para dibujar un precio.
const PRICE_CLASSES = ["price-block", "price-old", "price-offer", "opt-price", "opt-dots"];

// Solo el <body>: el <head> trae el CSS (que nombra las clases de precio) y
// las fuentes en base64, donde un "800" suelto puede aparecer sin ser precio.
const htmlBody = (html) => html.slice(html.indexOf("<body>"));

const assertNoPrices = (html) => {
  // Ni el CSS ni las fuentes llevan "$": si aparece, es un precio formateado.
  assert.equal(html.includes("$"), false, "el PDF no debe llevar ningún $");
  const body = htmlBody(html);
  for (const price of MENU_PRICES) {
    for (const text of [String(price), price.toLocaleString("es-AR")]) {
      assert.equal(body.includes(text), false, `el precio ${text} no debe aparecer`);
    }
  }
  for (const className of PRICE_CLASSES) {
    assert.equal(body.includes(className), false, `no debe haber .${className}`);
  }
};

const downloadPdf = async (t, menuDisplay) => {
  const { items } = mockPublicMenu(t, menuDisplay);
  t.mock.method(Item, "find", () => ({ select: async () => items }));
  printedHtml = undefined;
  const res = response();
  // Sin req.user a propósito: la ruta es pública (no lleva protect), igual
  // que la carta.
  await downloadMenuPdf({ params: { slug: "cafe-de-prueba" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "application/pdf");
  return printedHtml;
};

test("PDF: con precios ocultos no lleva ningún precio, pero sí los productos y las variantes", async (t) => {
  const html = await downloadPdf(t, { hidePrices: true });

  assertNoPrices(html);
  const body = htmlBody(html);
  for (const text of ["Muzzarella", "La de siempre", "Fugazzeta", "Café de prueba"]) {
    assert.ok(body.includes(text), `el PDF debe incluir "${text}"`);
  }
  // Las variantes quedan listadas solo con el nombre.
  assert.ok(body.includes("<li>Chica</li>"));
  assert.ok(body.includes("<li>Grande</li>"));
});

test("PDF: sin precios ocultos sigue saliendo con precios", async (t) => {
  const html = await downloadPdf(t, undefined);

  // Precio tachado + oferta vigente de la Muzzarella, sus variantes y el
  // precio de lista de la Fugazzeta (su oferta todavía no rige).
  for (const price of [1500, 1200, 800, 2000, 1800]) {
    assert.ok(html.includes(ars(price)), `el PDF debe incluir ${ars(price)}`);
  }
  const body = htmlBody(html);
  for (const className of ["price-old", "price-offer", "price", "opt-dots", "opt-price"]) {
    assert.ok(body.includes(`class="${className}"`), `debe haber .${className}`);
  }
});

test("template del PDF: con hidePrices no dibuja precios aunque los items los traigan", () => {
  // downloadMenuPdf ya manda los items sin precios; esto cubre que el
  // template no dependa de eso (sin el flag, las variantes en 0 saldrían
  // como "$0").
  const items = [
    { title: "Muzzarella", price: 1500, offerPrice: 1200, options: { Chica: 800, Grande: 2000 }, available: true },
    { title: "Fugazzeta", price: 1800, offerPrice: null, options: { Media: 0 }, available: true },
    { title: "Faina", price: 1600, available: true },
  ];
  const menuArmado = {
    secciones: [{ title: "Comidas", categorias: [{ title: "Pizzas", items }] }],
    sinSeccion: [{ title: "Sueltos", items }],
  };

  const html = buildMenuHTML({ businessName: "Café de prueba", menuArmado, hidePrices: true });
  assertNoPrices(html);
  assert.ok(html.includes("<li>Media</li>"));

  // Sin el flag, los mismos items salen con precios (y la variante en 0 como $0).
  const withPrices = buildMenuHTML({ businessName: "Café de prueba", menuArmado });
  assert.ok(withPrices.includes(ars(1500)));
  assert.ok(withPrices.includes(ars(0)));
});

test("editor de menú (GET /me/menu): con precios ocultos en la carta recibe los precios completos", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find(plan => plan.name === name)));
  const { categoria, items } = buildMenu();
  t.mock.method(Menu, "find", async () => [categoria]);
  t.mock.method(Item, "find", async () => items);
  const res = response();
  await fetchOwnMenu({
    user: {
      _id: USER_ID,
      subscription: "pro",
      subscriptionExpiresAt: new Date("2099-01-01"),
      panelSettings: { menuDisplay: { hidePrices: true } },
    },
  }, res);

  assert.equal(res.statusCode, 200);
  const [muzza] = res.body.menu.sinSeccion[0].items;
  assert.equal(muzza.price, 1500);
  assert.equal(muzza.offerPrice, 1200);
  assert.equal(muzza.options.get("Grande"), 2000);
});

test("GET /me/settings devuelve las opciones de la carta con defaults apagados", async (t) => {
  t.mock.method(User, "findById", () => ({ select: async () => ({ panelSettings: { password: "hash" } }) }));

  const sinGuardar = response();
  await getPanelSettingsStatus({ user: { _id: USER_ID } }, sinGuardar);
  assert.equal(sinGuardar.statusCode, 200);
  assert.deepEqual(sinGuardar.body.menuDisplay, ALL_OFF);

  const res = response();
  await getPanelSettingsStatus({
    user: { _id: USER_ID, panelSettings: { menuDisplay: { hidePrices: true, featuredSection: "true" } } },
  }, res);
  assert.deepEqual(res.body.menuDisplay, { ...ALL_OFF, hidePrices: true });
});

test("POST /me/settings/verify-password devuelve las opciones de la carta al entrar", async (t) => {
  t.mock.method(User, "findById", () => ({
    select: async () => ({
      panelSettings: { password: "hash", menuDisplay: { collapsibleCategories: true } },
      matchPanelSettingsPassword: async () => true,
    }),
  }));
  const res = response();
  await verifyPanelSettingsPassword({ user: { _id: USER_ID }, body: { password: "clave-del-panel" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.menuDisplay, { ...ALL_OFF, collapsibleCategories: true });
});

test("PATCH /me/settings guarda solo las opciones de la carta conocidas y booleanas", async (t) => {
  let received;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    received = update.$set;
    return { panelSettings: { menuDisplay: { hidePrices: true, collapsibleCategories: false } } };
  });
  const res = response();
  await updatePanelSettings({
    user: { _id: USER_ID },
    body: {
      menuDisplay: {
        hidePrices: true,
        collapsibleCategories: false,
        featuredSection: "true", // no booleano: se ignora
        "$where": true, // clave desconocida: se ignora
      },
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, {
    "panelSettings.menuDisplay.hidePrices": true,
    "panelSettings.menuDisplay.collapsibleCategories": false,
  });
  assert.deepEqual(res.body.menuDisplay, { ...ALL_OFF, hidePrices: true });
});

test("PATCH /me/settings acepta opciones de la carta y de la landing en el mismo pedido", async (t) => {
  let received;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    received = update.$set;
    return {};
  });
  const res = response();
  await updatePanelSettings({
    user: { _id: USER_ID },
    body: { landingVisibility: { mail: false }, menuDisplay: { featuredSection: true } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, {
    "panelSettings.landingVisibility.mail": false,
    "panelSettings.menuDisplay.featuredSection": true,
  });
});

test("PATCH /me/settings rechaza opciones de la carta sin cambios válidos", async (t) => {
  const update = t.mock.method(User, "findByIdAndUpdate", async () => ({}));
  for (const menuDisplay of [null, "hidePrices", [], { hidePrices: "si" }, { otra: true }]) {
    const res = response();
    await updatePanelSettings({ user: { _id: USER_ID }, body: { menuDisplay } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, "Nada para actualizar.");
  }
  assert.equal(update.mock.callCount(), 0);
});
