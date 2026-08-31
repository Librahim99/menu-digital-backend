const test = require("node:test");
const assert = require("node:assert/strict");
const Plan = require("../src/models/Plan");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const PageView = require("../src/models/PageView");
const { fetchUser, fetchUserWithMenu, getAuthUser, editUser } = require("../src/controllers/userController");

const activeContact = {
  businessName: "Café de prueba",
  mail: "local@example.com",
  number: 1123456789,
  location: { lat: -34.6, lng: -58.4 },
  address: "Av. de prueba 123",
  social: { instagram: "cafedeprueba" },
  reservationMessage: "Quiero reservar una mesa",
};
const retiredContact = {
  googleReviewUrl: "https://example.com/review",
  googlePlaceId: "legacy-place-id",
  googleRating: 4.8,
  googleReviewCount: 25,
};
const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("las lecturas de panel, landing y carta omiten campos retirados sin alterar el documento", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find(plan => plan.name === name)));
  const originalContact = { ...activeContact, ...retiredContact };
  const user = {
    _id: "64f000000000000000000123",
    slug: "cafe-de-prueba",
    template: 1,
    contactInfo: originalContact,
    subscriptionExpiresAt: new Date("2099-01-01"),
    toObject() { return { ...this, toObject: undefined }; },
  };
  t.mock.method(User, "findOne", async () => user);
  t.mock.method(User, "findById", async () => user);
  t.mock.method(Menu, "find", async () => []);
  t.mock.method(Item, "find", async () => []);
  t.mock.method(Item, "countDocuments", async () => 0);
  t.mock.method(PageView, "findOneAndUpdate", async () => ({}));

  for (const subscription of ["free", "basic", "pro"]) {
    user.subscription = subscription;
    for (const controller of [fetchUser, fetchUserWithMenu, getAuthUser]) {
      const res = response();
      await controller({ params: { slug: user.slug }, user }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual((res.body.user ?? res.body).contactInfo, activeContact);
    }
  }
  assert.deepEqual(originalContact, { ...activeContact, ...retiredContact });
});

test("editar contacto conserva datos vigentes y descarta campos de clientes antiguos", async (t) => {
  t.mock.method(User, "exists", async () => false);
  let saved;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update, options) => {
    assert.equal(options.runValidators, true);
    saved = update.$set;
    return saved;
  });
  const res = response();
  await editUser({
    user: {
      _id: "64f000000000000000000123",
      subscription: "free",
      contactInfo: { ...activeContact, ...retiredContact },
    },
    body: { contactInfo: { address: "Otra dirección 456", ...retiredContact } },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(saved.contactInfo, { ...activeContact, address: "Otra dirección 456" });
});

test("las cuentas nuevas no incorporan campos de reseñas desde un payload antiguo", () => {
  const user = new User({ contactInfo: { ...activeContact, ...retiredContact } });
  assert.deepEqual(user.toObject().contactInfo, activeContact);
});
