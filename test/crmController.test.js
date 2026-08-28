const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const CrmProfile = require("../src/models/CrmProfile");
const { getClient, updateProfile } = require("../src/controllers/crmController");

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
