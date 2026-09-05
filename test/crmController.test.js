const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const CrmProfile = require("../src/models/CrmProfile");
const PaymentTransaction = require("../src/models/PaymentTransaction");
const PageView = require("../src/models/PageView");
const Seller = require("../src/models/Seller");
const {
  listClients,
  getClient,
  updateProfile,
  getOverdueCount,
} = require("../src/controllers/crmController");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("listClients arma la vista 360 y resume las alertas sin consultas por cliente", async (t) => {
  const userID = "64f000000000000000000123";
  const menuID = "64f000000000000000000201";
  const user = {
    _id: userID,
    username: "cliente-prueba",
    slug: "cliente-prueba",
    subscription: "basic",
    subscriptionExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
    active: true,
    createdAt: new Date("2019-01-01T00:00:00.000Z"),
    contactInfo: {
      businessName: "Bar de prueba",
      mail: "contacto@example.com",
      number: 1112345678,
      address: "Calle 123",
    },
    media: { pictures: [], backgroundPicture: "" },
    schedule: {},
  };
  const profile = {
    userID,
    stage: "en_riesgo",
    tags: ["prioridad"],
    nextFollowUp: new Date("2020-01-02T00:00:00.000Z"),
  };
  const paymentDate = new Date("2026-08-20T12:00:00.000Z");

  t.mock.method(User, "find", () => ({
    select() { return this; },
    async sort() { return [user]; },
  }));
  t.mock.method(CrmProfile, "find", () => ({ select: async () => [profile] }));
  t.mock.method(Menu, "find", () => ({
    select: async () => [{ _id: menuID, userID, section: false }],
  }));
  t.mock.method(Item, "aggregate", async () => [{ _id: menuID, count: 2 }]);
  t.mock.method(PaymentTransaction, "aggregate", async () => [{
    _id: userID,
    latestPayment: {
      status: "approved",
      entitlementStatus: "not_applied",
      amount: 39999,
      currency: "ARS",
      createdAt: paymentDate,
    },
    attentionCount: 1,
  }]);
  t.mock.method(PageView, "aggregate", async () => []);

  const res = response();
  await listClients({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.clients.length, 1);
  assert.deepEqual(res.body.clients[0].contactInfo, {
    mail: "contacto@example.com",
    number: 1112345678,
  });
  assert.deepEqual(res.body.clients[0].attention, [
    "payment_issue",
    "subscription_expired",
    "follow_up_overdue",
    "onboarding_incomplete",
  ]);
  assert.equal(res.body.clients[0].onboarding.completedCount, 5);
  assert.equal(res.body.clients[0].lastPayment.amount, 39999);
  assert.deepEqual(res.body.attentionSummary, {
    clients: 1,
    paymentIssues: 1,
    expiredSubscriptions: 1,
    expiringSubscriptions: 0,
    missingExpirySubscriptions: 0,
    overdueFollowUps: 1,
    incompleteOnboarding: 1,
    noTraffic: 0,
  });
});

test("listClients suma el tráfico de la carta y el vendedor que trajo la cuenta", async (t) => {
  const userID = "64f000000000000000000123";
  const sellerID = "64f000000000000000000999";
  const menuID = "64f000000000000000000201";

  t.mock.method(User, "find", () => ({
    select() { return this; },
    async sort() {
      return [{
        _id: userID,
        username: "cliente-pro",
        slug: "cliente-pro",
        subscription: "pro",
        subscriptionExpiresAt: new Date(Date.now() + (90 * 24 * 60 * 60 * 1000)),
        active: true,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        sellerID,
        contactInfo: { businessName: "Bar", mail: "a@b.com", number: 1, address: "Calle 1" },
        media: { pictures: ["foto"], backgroundPicture: "portada" },
        schedule: { mon: { enabled: true, open: "09:00", close: "18:00" } },
      }];
    },
  }));
  t.mock.method(CrmProfile, "find", () => ({ select: async () => [] }));
  t.mock.method(Menu, "find", () => ({
    select: async () => [{ _id: menuID, userID, section: false }],
  }));
  t.mock.method(Item, "aggregate", async () => [{ _id: menuID, count: 4 }]);
  t.mock.method(PaymentTransaction, "aggregate", async () => []);
  t.mock.method(PageView, "aggregate", async () => [
    { _id: userID, last30d: 140, previous30d: 90 },
  ]);
  t.mock.method(Seller, "find", () => ({
    select: async () => [{ _id: sellerID, name: "Ana Vendedora", code: "ANA-001" }],
  }));

  const res = response();
  await listClients({}, res);

  assert.equal(res.statusCode, 200);
  const client = res.body.clients[0];
  assert.deepEqual(client.views, { last30d: 140, previous30d: 90 });
  assert.equal(client.seller.name, "Ana Vendedora");
  assert.equal(client.seller.code, "ANA-001");
  // Con tráfico real no se marca la alerta de carta sin visitas.
  assert.equal(client.attention.includes("no_traffic"), false);
});

test("listClients marca no_traffic solo si la cuenta paga tiene la carta publicada y cero visitas", async (t) => {
  const menuID = "64f000000000000000000201";
  const pagoSinVisitas = "64f000000000000000000001";
  const gratisSinVisitas = "64f000000000000000000002";

  const baseUser = {
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    subscriptionExpiresAt: new Date(Date.now() + (90 * 24 * 60 * 60 * 1000)),
    contactInfo: { businessName: "Bar", mail: "a@b.com", number: 1, address: "Calle 1" },
    media: { pictures: ["foto"], backgroundPicture: "portada" },
    schedule: { mon: { enabled: true, open: "09:00", close: "18:00" } },
  };

  t.mock.method(User, "find", () => ({
    select() { return this; },
    async sort() {
      return [
        { ...baseUser, _id: pagoSinVisitas, username: "paga", slug: "paga", subscription: "pro" },
        { ...baseUser, _id: gratisSinVisitas, username: "gratis", slug: "gratis", subscription: "free" },
      ];
    },
  }));
  t.mock.method(CrmProfile, "find", () => ({ select: async () => [] }));
  t.mock.method(Menu, "find", () => ({
    select: async () => [
      { _id: menuID, userID: pagoSinVisitas, section: false },
      { _id: "64f000000000000000000202", userID: gratisSinVisitas, section: false },
    ],
  }));
  t.mock.method(Item, "aggregate", async () => [
    { _id: menuID, count: 3 },
    { _id: "64f000000000000000000202", count: 3 },
  ]);
  t.mock.method(PaymentTransaction, "aggregate", async () => []);
  t.mock.method(PageView, "aggregate", async () => []);

  const res = response();
  await listClients({}, res);

  const paga = res.body.clients.find((c) => c.username === "paga");
  const gratis = res.body.clients.find((c) => c.username === "gratis");

  assert.equal(paga.attention.includes("no_traffic"), true);
  assert.deepEqual(paga.views, { last30d: 0, previous30d: 0 });
  // Una cuenta gratuita sin visitas no es una señal de baja: no hay plata en
  // juego y su carta puede ser una prueba.
  assert.equal(gratis.attention.includes("no_traffic"), false);
  assert.equal(res.body.attentionSummary.noTraffic, 1);
});

test("getOverdueCount no considera vencido un seguimiento del día actual", async (t) => {
  let filter;
  t.mock.method(CrmProfile, "countDocuments", async (receivedFilter) => {
    filter = receivedFilter;
    return 2;
  });

  const res = response();
  await getOverdueCount({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { count: 2 });
  assert.equal(filter.nextFollowUp.$ne, null);
  assert.match(filter.nextFollowUp.$lt.toISOString(), /T00:00:00\.000Z$/);
});

test("getClient rechaza un ID inválido antes de consultar la base", async (t) => {
  t.mock.method(User, "findOne", () => {
    throw new Error("No debe consultar User para un ID inválido");
  });

  const res = response();
  await getClient({ params: { userID: "id-invalido" } }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "ID inválido" });
});

test("getClient limita el detalle a clientes no admin y calcula el onboarding", async (t) => {
  const userID = "64f000000000000000000123";
  const createdAt = new Date("2026-08-01T12:00:00.000Z");
  const expiresAt = new Date("2026-09-01T12:00:00.000Z");
  let userFilter;
  let projection;

  const user = {
    _id: userID,
    username: "cliente-prueba",
    slug: "cliente-prueba",
    subscription: "basic",
    subscriptionExpiresAt: expiresAt,
    active: true,
    hasDelivery: true,
    createdAt,
    contactInfo: {
      businessName: "Bar de prueba",
      mail: "contacto@example.com",
      number: 1112345678,
      address: "Calle 123",
    },
    media: { pictures: ["https://example.com/logo.webp"], backgroundPicture: "" },
    schedule: { mon: { enabled: true, open: "09:00", close: "18:00" } },
    password: "no-debe-salir",
    acceptedTerms: true,
  };
  const profile = { stage: "onboarding", tags: ["nuevo"], nextFollowUp: null, notes: [] };
  const menus = [
    { _id: "64f000000000000000000201", section: false },
    { _id: "64f000000000000000000202", section: true },
  ];

  t.mock.method(User, "findOne", (filter) => {
    userFilter = filter;
    return {
      select: async (fields) => {
        projection = fields;
        return user;
      },
    };
  });
  t.mock.method(CrmProfile, "findOne", () => ({ populate: async () => profile }));
  t.mock.method(Menu, "find", () => ({ select: async () => menus }));
  t.mock.method(Item, "countDocuments", async () => 3);

  const res = response();
  await getClient({ params: { userID } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(userFilter, { _id: userID, admin: false });
  assert.match(projection, /contactInfo\.businessName/);
  assert.doesNotMatch(projection, /password/);
  assert.deepEqual(Object.keys(res.body.user).sort(), [
    "_id",
    "active",
    "contactInfo",
    "createdAt",
    "hasDelivery",
    "slug",
    "subscription",
    "subscriptionExpiresAt",
    "username",
  ]);
  assert.equal(res.body.user.password, undefined);
  assert.equal(res.body.user.acceptedTerms, undefined);
  assert.deepEqual(res.body.activity, { categoryCount: 1, sectionCount: 1, itemCount: 3 });
  assert.deepEqual(res.body.onboarding, {
    businessInfo: true,
    contactChannel: true,
    schedule: true,
    branding: true,
    menuStructure: true,
    products: true,
    publicMenu: true,
    completedCount: 7,
    total: 7,
    completed: true,
  });
});

test("getClient responde 404 cuando el ID no pertenece a un cliente", async (t) => {
  const userID = "64f000000000000000000123";
  t.mock.method(User, "findOne", () => ({ select: async () => null }));

  const res = response();
  await getClient({ params: { userID } }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Cliente no encontrado" });
});

test("updateProfile rechaza fechas inválidas y limita la búsqueda a clientes", async (t) => {
  const userID = "64f000000000000000000123";
  let existsFilter;
  t.mock.method(User, "exists", async (filter) => {
    existsFilter = filter;
    return { _id: userID };
  });
  t.mock.method(CrmProfile, "findOneAndUpdate", () => {
    throw new Error("No debe guardar una fecha inválida");
  });

  const res = response();
  await updateProfile({ params: { userID }, body: { nextFollowUp: "fecha-imposible" } }, res);

  assert.deepEqual(existsFilter, { _id: userID, admin: false });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Fecha de seguimiento inválida" });
});

test("updateProfile normaliza tags de texto y elimina duplicados", async (t) => {
  const userID = "64f000000000000000000123";
  let savedUpdate;
  const updatedProfile = { stage: "lead", tags: ["prioridad"], nextFollowUp: null, notes: [] };
  t.mock.method(User, "exists", async () => ({ _id: userID }));
  t.mock.method(CrmProfile, "findOneAndUpdate", (_filter, update) => {
    savedUpdate = update;
    return { populate: async () => updatedProfile };
  });

  const res = response();
  await updateProfile(
    { params: { userID }, body: { tags: [" prioridad ", "prioridad", ""] } },
    res
  );

  assert.deepEqual(savedUpdate.$set.tags, ["prioridad"]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, updatedProfile);
});
