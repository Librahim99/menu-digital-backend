const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const { editUser } = require("../src/controllers/userController");
const { toPublicContactInfo } = require("../src/utils/publicMenu");

// Retiro en el local (hasTakeAway): junto con hasDelivery define qué
// modalidades ofrece el pedido por WhatsApp en la carta. Cada modalidad
// tiene su texto extra: contactInfo.orderMessage (delivery) y
// contactInfo.takeAwayMessage (take away).

const USER_ID = "64f000000000000000000123";

const contact = {
  businessName: "Café de prueba",
  mail: "local@example.com",
  number: 1123456789,
  address: "Av. de prueba 123",
  orderMessage: "Dirección y entre calles:",
  takeAwayMessage: "¿A qué hora pasás?",
};

const response = () => ({
  statusCode: 200,
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

const edit = async (body) => {
  const res = response();
  await editUser({
    user: { _id: USER_ID, subscription: "free", contactInfo: structuredClone(contact) },
    body,
  }, res);
  return res;
};

test("las cuentas previas no ofrecen take away hasta que el dueño lo activa", () => {
  const user = new User();
  assert.equal(user.hasTakeAway, false);
  assert.equal(User.schema.path("hasTakeAway").instance, "Boolean");
  assert.equal(user.toObject().contactInfo.takeAwayMessage, "");
});

test("PUT /me guarda delivery y take away juntos", async (t) => {
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    assert.deepEqual(update, { $set: { hasDelivery: false, hasTakeAway: true } });
    return update.$set;
  });
  const res = response();
  await editUser({
    user: { _id: "usuario" },
    body: { hasDelivery: false, hasTakeAway: true },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { hasDelivery: false, hasTakeAway: true });
});

test("el modelo rechaza un mensaje take away de más de 500 caracteres", () => {
  const largo = new User({ contactInfo: { ...contact, takeAwayMessage: "a".repeat(501) } });
  assert.ok(largo.validateSync()?.errors["contactInfo.takeAwayMessage"]);

  const justo = new User({ contactInfo: { ...contact, takeAwayMessage: "a".repeat(500) } });
  assert.equal(justo.validateSync()?.errors["contactInfo.takeAwayMessage"], undefined);
});

test("PUT /me guarda el mensaje take away sin espacios de más y conserva el de delivery", async (t) => {
  const saved = mockSave(t);
  const res = await edit({ contactInfo: { takeAwayMessage: "  Nombre para el retiro:  \n" } });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(saved.value.contactInfo, { ...contact, takeAwayMessage: "Nombre para el retiro:" });
});

test("PUT /me conserva el mensaje take away guardado si la edición no lo trae", async (t) => {
  const saved = mockSave(t);
  const res = await edit({ contactInfo: { orderMessage: "Dirección:" } });

  assert.equal(res.statusCode, 200);
  assert.equal(saved.value.contactInfo.takeAwayMessage, contact.takeAwayMessage);
  assert.equal(saved.value.contactInfo.orderMessage, "Dirección:");
});

test("PUT /me rechaza un mensaje take away largo o que no es texto, con su propio mensaje", async (t) => {
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe guardar"));
  t.mock.method(User, "exists", async () => assert.fail("no debe siquiera llegar a tocar el slug"));

  const largo = await edit({ contactInfo: { takeAwayMessage: "a".repeat(501) } });
  assert.equal(largo.statusCode, 400);
  assert.equal(largo.body.message, "El mensaje de pedido take away no puede superar los 500 caracteres.");

  for (const takeAwayMessage of [123, null, true, ["hola"], { texto: "hola" }]) {
    const res = await edit({ contactInfo: { takeAwayMessage } });
    assert.equal(res.statusCode, 400, `debe rechazar ${JSON.stringify(takeAwayMessage)}`);
    assert.equal(res.body.message, "El mensaje de pedido take away no es válido.");
  }
});

test("la carta pública recibe los dos mensajes de pedido y omite el vacío", () => {
  assert.deepEqual(toPublicContactInfo(contact), {
    businessName: "Café de prueba",
    number: 1123456789,
    address: "Av. de prueba 123",
    orderMessage: "Dirección y entre calles:",
    takeAwayMessage: "¿A qué hora pasás?",
  });
  assert.equal(toPublicContactInfo({ ...contact, takeAwayMessage: "" }).takeAwayMessage, undefined);
});
