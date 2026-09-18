const test = require("node:test");
const assert = require("node:assert/strict");
const Plan = require("../src/models/Plan");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const PageView = require("../src/models/PageView");
const { fetchUserWithMenu, getAuthUser, editUser } = require("../src/controllers/userController");

// ──────────────────────────────────────────────
// Tarjeta "Texto extra en el mensaje de pedido por WhatsApp":
// contactInfo.orderMessage, que se carga en "Mi negocio".
// ──────────────────────────────────────────────

const contact = {
  businessName: "Café de prueba",
  mail: "local@example.com",
  number: 1123456789,
  address: "Av. de prueba 123",
  reservationMessage: "Quiero reservar una mesa",
  orderMessage: "Aceptamos transferencia y efectivo",
};

const USER_ID = "64f000000000000000000123";

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

// editUser con businessName pasa por updateUserWithUniqueSlug (User.exists +
// findByIdAndUpdate); devuelve lo que llegó a guardarse.
const mockSave = (t) => {
  const saved = {};
  t.mock.method(User, "exists", async () => false);
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    saved.value = update.$set;
    return update.$set;
  });
  return saved;
};

const edit = async (body, contactInfo = contact) => {
  const res = response();
  await editUser({
    user: { _id: USER_ID, subscription: "free", contactInfo: structuredClone(contactInfo) },
    body,
  }, res);
  return res;
};

test("el modelo arranca sin mensaje de pedido y rechaza uno de más de 500 caracteres", () => {
  const { orderMessage: _omitido, ...sinMensaje } = contact;
  assert.equal(new User({ contactInfo: sinMensaje }).toObject().contactInfo.orderMessage, "");

  const largo = new User({ contactInfo: { ...contact, orderMessage: "a".repeat(501) } });
  assert.ok(largo.validateSync()?.errors["contactInfo.orderMessage"]);

  const justo = new User({ contactInfo: { ...contact, orderMessage: "a".repeat(500) } });
  assert.equal(justo.validateSync()?.errors["contactInfo.orderMessage"], undefined);
});

test("el mensaje de pedido viaja en la carta pública y en el panel", async (t) => {
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find(plan => plan.name === name)));
  const user = {
    _id: USER_ID,
    slug: "cafe-de-prueba",
    template: 1,
    subscription: "pro",
    subscriptionExpiresAt: new Date("2099-01-01"),
    contactInfo: structuredClone(contact),
    toObject() { return { ...this, toObject: undefined }; },
  };
  t.mock.method(User, "findOne", async () => user);
  t.mock.method(User, "findByIdAndUpdate", async () => user);
  t.mock.method(Menu, "find", async () => []);
  t.mock.method(Item, "find", async () => []);
  t.mock.method(Item, "countDocuments", async () => 0);
  t.mock.method(PageView, "findOneAndUpdate", async () => ({}));

  const carta = response();
  await fetchUserWithMenu({ params: { slug: user.slug } }, carta);
  assert.equal(carta.statusCode, 200);
  assert.equal(carta.body.user.contactInfo.orderMessage, contact.orderMessage);

  const panel = response();
  await getAuthUser({ user }, panel);
  assert.equal(panel.statusCode, 200);
  assert.equal(panel.body.contactInfo.orderMessage, contact.orderMessage);
});

test("PUT /me guarda el mensaje de pedido sin espacios de más y conserva el resto", async (t) => {
  const saved = mockSave(t);
  const res = await edit({ contactInfo: { orderMessage: "  Pagás al retirar  \n" } });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(saved.value.contactInfo, { ...contact, orderMessage: "Pagás al retirar" });
});

test("PUT /me permite vaciar el mensaje de pedido", async (t) => {
  const saved = mockSave(t);
  const res = await edit({ contactInfo: { orderMessage: "   " } });

  assert.equal(res.statusCode, 200);
  assert.equal(saved.value.contactInfo.orderMessage, "");
});

test("PUT /me conserva el mensaje de pedido guardado si la edición no lo trae", async (t) => {
  const saved = mockSave(t);
  const res = await edit({ contactInfo: { address: "Otra dirección 456" } });

  assert.equal(res.statusCode, 200);
  assert.equal(saved.value.contactInfo.orderMessage, contact.orderMessage);
  assert.equal(saved.value.contactInfo.address, "Otra dirección 456");
});

test("PUT /me mide el tope de 500 caracteres después de sacar los espacios", async (t) => {
  const saved = mockSave(t);
  const res = await edit({ contactInfo: { orderMessage: `   ${"a".repeat(500)}   ` } });

  assert.equal(res.statusCode, 200);
  assert.equal(saved.value.contactInfo.orderMessage, "a".repeat(500));
});

test("PUT /me rechaza un mensaje de pedido de más de 500 caracteres", async (t) => {
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe guardar"));
  t.mock.method(User, "exists", async () => assert.fail("no debe siquiera llegar a tocar el slug"));
  const res = await edit({ contactInfo: { orderMessage: "a".repeat(501) } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "El mensaje de pedido no puede superar los 500 caracteres.");
});

test("PUT /me rechaza un mensaje de pedido que no es texto", async (t) => {
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe guardar"));
  t.mock.method(User, "exists", async () => assert.fail("no debe siquiera llegar a tocar el slug"));
  for (const orderMessage of [123, null, true, ["hola"], { texto: "hola" }]) {
    const res = await edit({ contactInfo: { orderMessage } });
    assert.equal(res.statusCode, 400, `debe rechazar ${JSON.stringify(orderMessage)}`);
    assert.match(res.body.message, /mensaje de pedido/i);
  }
});
