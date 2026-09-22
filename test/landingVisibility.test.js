const test = require("node:test");
const assert = require("node:assert/strict");
const Plan = require("../src/models/Plan");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const PageView = require("../src/models/PageView");
const {
  fetchUser,
  fetchUserWithMenu,
  getPanelSettingsStatus,
  updatePanelSettings,
} = require("../src/controllers/userController");

// ──────────────────────────────────────────────
// Tarjeta "Agregar config para mostrar opcionalmente la info de contacto en
// landing page user": panelSettings.landingVisibility.
// ──────────────────────────────────────────────

const ALL_VISIBLE = {
  phone: true,
  whatsappReserve: true,
  mail: true,
  address: true,
  schedule: true,
  instagram: true,
  facebook: true,
};

const contact = {
  businessName: "Café de prueba",
  mail: "local@example.com",
  number: 1123456789,
  location: { lat: -34.6, lng: -58.4 },
  address: "Av. de prueba 123",
  social: { instagram: "cafedeprueba", facebook: "cafedeprueba.fb" },
  reservationMessage: "Quiero reservar una mesa",
};

const schedule = {
  mon: { enabled: true, open: "09:00", close: "18:00" },
  tue: { enabled: true, open: "09:00", close: "18:00" },
  wed: { enabled: true, open: "09:00", close: "18:00" },
  thu: { enabled: true, open: "09:00", close: "18:00" },
  fri: { enabled: true, open: "09:00", close: "18:00" },
  sat: { enabled: false, open: "09:00", close: "18:00" },
  sun: { enabled: false, open: "09:00", close: "18:00" },
};

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const mockPublicUser = (t, landingVisibility) => {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find(plan => plan.name === name)));
  const user = {
    _id: "64f000000000000000000123",
    slug: "cafe-de-prueba",
    template: 1,
    subscription: "pro",
    subscriptionExpiresAt: new Date("2099-01-01"),
    contactInfo: structuredClone(contact),
    schedule,
    panelSettings: landingVisibility === undefined ? undefined : { landingVisibility },
  };
  t.mock.method(User, "findOne", async () => user);
  t.mock.method(Menu, "find", async () => []);
  t.mock.method(Item, "find", async () => []);
  t.mock.method(PageView, "findOneAndUpdate", async () => ({}));
  return user;
};

test("el modelo arranca con todos los datos de la landing visibles", () => {
  const user = new User({ contactInfo: contact });
  assert.deepEqual(user.toObject().panelSettings.landingVisibility, ALL_VISIBLE);
});

test("landing: sin configuración guardada se envía todo, igual que antes de la opción", async (t) => {
  mockPublicUser(t, undefined);
  const res = response();
  await fetchUser({ params: { slug: "cafe-de-prueba" } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.contactInfo, contact);
  assert.deepEqual(res.body.schedule, schedule);
  assert.deepEqual(res.body.landingVisibility, ALL_VISIBLE);
});

test("landing: los datos ocultos no viajan en la respuesta pública", async (t) => {
  const user = mockPublicUser(t, {
    phone: false,
    whatsappReserve: false,
    mail: false,
    address: false,
    schedule: false,
    instagram: false,
    facebook: false,
  });
  const res = response();
  await fetchUser({ params: { slug: "cafe-de-prueba" } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.contactInfo, {
    businessName: contact.businessName,
    mail: "",
    number: null,
    location: {},
    address: "",
    social: {},
    reservationMessage: contact.reservationMessage,
  });
  assert.equal(res.body.schedule, undefined);
  assert.equal(JSON.stringify(res.body).includes("local@example.com"), false);
  assert.equal(JSON.stringify(res.body).includes("1123456789"), false);
  // No muta el documento: el dato sigue guardado, solo no se muestra.
  assert.deepEqual(user.contactInfo, contact);
});

test("landing: el número se sigue enviando si el botón de reservas está visible", async (t) => {
  mockPublicUser(t, { phone: false, whatsappReserve: true });
  const res = response();
  await fetchUser({ params: { slug: "cafe-de-prueba" } }, res);

  assert.equal(res.body.contactInfo.number, contact.number);
  assert.equal(res.body.landingVisibility.phone, false);
  assert.equal(res.body.landingVisibility.whatsappReserve, true);
  // Claves sin guardar (documento con la opción a medio completar) = visibles.
  assert.equal(res.body.landingVisibility.mail, true);
  assert.equal(res.body.contactInfo.mail, contact.mail);
});

test("landing: ocultar una red deja la otra intacta", async (t) => {
  mockPublicUser(t, { ...ALL_VISIBLE, instagram: false });
  const res = response();
  await fetchUser({ params: { slug: "cafe-de-prueba" } }, res);

  assert.deepEqual(res.body.contactInfo.social, { facebook: contact.social.facebook });
});

test("carta: oculta mail y redes pero conserva número, dirección y horario", async (t) => {
  mockPublicUser(t, {
    phone: false,
    whatsappReserve: false,
    mail: false,
    address: false,
    schedule: false,
    instagram: false,
    facebook: false,
  });
  const res = response();
  await fetchUserWithMenu({ params: { slug: "cafe-de-prueba" } }, res);

  assert.equal(res.statusCode, 200);
  const { contactInfo } = res.body.user;
  assert.equal(contactInfo.mail, "");
  assert.deepEqual(contactInfo.social, {});
  assert.equal(contactInfo.number, contact.number); // pedidos por WhatsApp
  assert.equal(contactInfo.address, contact.address); // cabecera de la carta
  assert.deepEqual(contactInfo.location, contact.location);
  assert.deepEqual(res.body.user.schedule, schedule);
  assert.equal(res.body.user.landingVisibility, undefined);
});

test("GET /me/settings devuelve la visibilidad vigente con defaults", async (t) => {
  t.mock.method(User, "findById", () => ({ select: async () => ({ panelSettings: { password: "hash" } }) }));
  const res = response();
  await getPanelSettingsStatus({
    user: { _id: "64f000000000000000000123", panelSettings: { landingVisibility: { mail: false } } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    hasPassword: true,
    autoGenerateCodes: false,
    disableMenuDelete: false,
    deleteMenusWithContent: false,
    landingVisibility: { ...ALL_VISIBLE, mail: false },
    menuDisplay: { featuredSection: false, collapsibleCategories: false, hidePrices: false },
  });
});

test("PATCH /me/settings guarda solo las claves de visibilidad conocidas y booleanas", async (t) => {
  let received;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    received = update.$set;
    return { panelSettings: { landingVisibility: { phone: false, facebook: true } } };
  });
  const res = response();
  await updatePanelSettings({
    user: { _id: "64f000000000000000000123" },
    body: {
      landingVisibility: {
        phone: false,
        facebook: true,
        mail: "false", // no booleano: se ignora
        "$where": false, // clave desconocida: se ignora
      },
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, {
    "panelSettings.landingVisibility.phone": false,
    "panelSettings.landingVisibility.facebook": true,
  });
  assert.deepEqual(res.body.landingVisibility, { ...ALL_VISIBLE, phone: false });
});

test("PATCH /me/settings rechaza una visibilidad sin cambios válidos", async (t) => {
  const update = t.mock.method(User, "findByIdAndUpdate", async () => ({}));
  for (const landingVisibility of [null, "mail", [], { mail: "no" }, { otra: false }]) {
    const res = response();
    await updatePanelSettings({ user: { _id: "64f000000000000000000123" }, body: { landingVisibility } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(update.mock.callCount(), 0);
});
