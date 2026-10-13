const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const CrmProfile = require("../src/models/CrmProfile");
const PaymentTransaction = require("../src/models/PaymentTransaction");
const PageView = require("../src/models/PageView");
const Seller = require("../src/models/Seller");
const { getStats } = require("../src/controllers/adminController");
const { getPlanUsage } = require("../src/controllers/planController");
const { listClients, getCrmSummary, getOverdueCount } = require("../src/controllers/crmController");
const { attributionForUser, createSaleSnapshot } = require("../src/services/sellerSaleService");
const { EXCLUDE_TEST_USERS } = require("../src/utils/testUsers");

// Los usuarios de prueba de los vendedores (User.testUser) no cuentan en
// ninguna estadística. Cada test comprueba el filtro que llega a Mongo: es lo
// que los deja afuera, incluidas las cuentas viejas sin el campo guardado.

const NOT_TEST = { testUser: { $ne: true } };
const TEST_USER_ID = "64f000000000000000000abc";
const TEST_MENU_ID = "64f000000000000000000def";

function response() {
  return {
    statusCode: 200,
    body: null,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("el filtro excluye solo testUser:true, así entran las cuentas anteriores al campo", () => {
  assert.deepEqual(EXCLUDE_TEST_USERS, NOT_TEST);
  assert.equal(new User({ username: "x", password: "12345678", contactInfo: { mail: "a@b.co" } }).testUser, false);
});

function mockStats(t, { testUserIDs, testMenuIDs }) {
  const calls = { users: [], menus: [], items: [], recents: null };
  t.mock.method(User, "find", (filter) => (filter.testUser === true
    ? { distinct: async () => testUserIDs }
    : {
        sort() { calls.recents = filter; return this; },
        limit() { return this; },
        select: async () => [],
      }));
  t.mock.method(Menu, "find", (filter) => {
    calls.testMenusFilter = filter;
    return { distinct: async () => testMenuIDs };
  });
  t.mock.method(User, "countDocuments", async (filter) => { calls.users.push(filter); return 0; });
  t.mock.method(Menu, "countDocuments", async (filter) => { calls.menus.push(filter); return 0; });
  t.mock.method(Item, "countDocuments", async (filter) => { calls.items.push(filter); return 0; });
  return calls;
}

test("getStats no cuenta a los usuarios de prueba ni a sus menús y productos", async (t) => {
  const calls = mockStats(t, { testUserIDs: [TEST_USER_ID], testMenuIDs: [TEST_MENU_ID] });

  const res = response();
  await getStats({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.users, [
    { admin: false, ...NOT_TEST },
    { admin: false, ...NOT_TEST, active: true },
    { admin: false, ...NOT_TEST, active: false },
    { admin: false, ...NOT_TEST, menu: true },
  ]);
  assert.deepEqual(calls.recents, { admin: false, ...NOT_TEST });

  const withoutTestMenus = { userID: { $nin: [TEST_USER_ID] } };
  assert.deepEqual(calls.testMenusFilter, { userID: { $in: [TEST_USER_ID] } });
  assert.deepEqual(calls.menus, [
    withoutTestMenus,
    { ...withoutTestMenus, section: true },
    { ...withoutTestMenus, section: false },
  ]);

  const withoutTestItems = { menuID: { $nin: [TEST_MENU_ID] } };
  assert.deepEqual(calls.items, [
    withoutTestItems,
    { ...withoutTestItems, available: true, hidden: false },
    { ...withoutTestItems, hidden: true },
  ]);
});

test("getStats sin usuarios de prueba cuenta menús y productos como siempre", async (t) => {
  const calls = mockStats(t, { testUserIDs: [], testMenuIDs: [] });
  t.mock.method(Menu, "find", () => assert.fail("sin usuarios de prueba no hay menús que buscar"));

  await getStats({}, response());

  assert.deepEqual(calls.menus, [{}, { section: true }, { section: false }]);
  assert.deepEqual(calls.items, [{}, { available: true, hidden: false }, { hidden: true }]);
});

test("getPlanUsage no cuenta a los usuarios de prueba en las cuentas por plan", async (t) => {
  let filter;
  t.mock.method(User, "find", (received) => { filter = received; return { select: async () => [] }; });
  t.mock.method(PaymentTransaction, "aggregate", async () => []);

  const res = response();
  await getPlanUsage({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(filter, { admin: false, ...NOT_TEST });
});

function mockCrmJoins(t) {
  t.mock.method(CrmProfile, "find", () => ({ select: async () => [] }));
  t.mock.method(Menu, "find", () => ({ select: async () => [] }));
  t.mock.method(Item, "aggregate", async () => []);
  t.mock.method(PaymentTransaction, "aggregate", async () => []);
  t.mock.method(PageView, "aggregate", async () => []);
  t.mock.method(Seller, "find", () => ({ select: async () => [] }));
}

test("el CRM y el resumen del dashboard dejan afuera a los usuarios de prueba, también en la cartera de un vendedor", async (t) => {
  const filters = [];
  t.mock.method(User, "find", (filter) => {
    filters.push(filter);
    return { select() { return this; }, async sort() { return []; } };
  });
  mockCrmJoins(t);
  const seller = { _id: "64f000000000000000000901" };

  const adminRes = response();
  await listClients({ user: { admin: true } }, adminRes);
  const summaryRes = response();
  await getCrmSummary({ user: { admin: true } }, summaryRes);
  const sellerRes = response();
  await listClients({ seller }, sellerRes);

  assert.deepEqual([adminRes.statusCode, summaryRes.statusCode, sellerRes.statusCode], [200, 200, 200]);
  assert.equal(summaryRes.body.totalClients, 0);
  assert.deepEqual(filters, [
    { admin: false, ...NOT_TEST },
    { admin: false, ...NOT_TEST },
    // El usuario de prueba lleva el sellerID del vendedor: sin el filtro
    // entraría por la primera rama del $or.
    { admin: false, ...NOT_TEST, $or: [{ sellerID: seller._id }, { assignedSeller: seller._id }] },
  ]);
});

test("las alertas de seguimiento de un vendedor no miran a su usuario de prueba", async (t) => {
  const seller = { _id: "64f000000000000000000901" };
  let filter;
  t.mock.method(User, "find", (received) => { filter = received; return { distinct: async () => [] }; });
  t.mock.method(Seller, "findById", () => ({ select: async () => ({ crmAlertsSeenAt: null }) }));
  t.mock.method(User, "countDocuments", async () => 0);
  t.mock.method(CrmProfile, "countDocuments", async () => 0);

  const res = response();
  await getOverdueCount({ seller }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(filter, {
    admin: false,
    ...NOT_TEST,
    $or: [{ sellerID: seller._id }, { assignedSeller: seller._id }],
  });
});

test("un pago de un usuario de prueba no comisiona ni suma al ranking de su vendedor", () => {
  const sellerID = "64f000000000000000000901";
  const sale = { plan: "pro", months: 1, amount: 1000, subscriptionDate: new Date(0) };

  const client = attributionForUser({ sellerID });
  assert.deepEqual(client, { sellerID });
  assert.equal(createSaleSnapshot({ attribution: client, ...sale }).sellerID, sellerID);

  const demo = attributionForUser({ sellerID, testUser: true });
  assert.deepEqual(demo, { sellerID: null });
  assert.equal(createSaleSnapshot({ attribution: demo, ...sale }), undefined);

  assert.deepEqual(attributionForUser({ sellerID, testUser: false }), { sellerID });
  assert.deepEqual(attributionForUser(null), { sellerID: null });
});
