const test = require("node:test");
const assert = require("node:assert/strict");
const Plan = require("../src/models/Plan");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const PageView = require("../src/models/PageView");
const PendingServiceAction = require("../src/models/PendingServiceAction");
const mailer = require("../src/utils/mailer");
const { fetchUser, fetchUserWithMenu, getAuthUser, editUser, newUser } = require("../src/controllers/userController");

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

// ──────────────────────────────────────────────
// contactInfo.mail obligatorio y con formato válido — ver PENDIENTES.md:
// una cuenta con basura ahí ("ididid") queda sin forma de recibir el
// código de confirmación de baja/arrepentimiento.
// ──────────────────────────────────────────────

test("el modelo User rechaza un contactInfo.mail vacío o con formato inválido", () => {
  const sinMail = new User({ contactInfo: { ...activeContact, mail: undefined } });
  assert.ok(sinMail.validateSync()?.errors["contactInfo.mail"], "debe exigir el email");

  const mailInvalido = new User({ contactInfo: { ...activeContact, mail: "ididid" } });
  assert.ok(mailInvalido.validateSync()?.errors["contactInfo.mail"], "debe rechazar un email sin formato válido");

  const mailValido = new User({ contactInfo: activeContact });
  assert.equal(mailValido.validateSync()?.errors["contactInfo.mail"], undefined);
});

test("newUser normaliza el username a minúsculas antes de chequear disponibilidad", async (t) => {
  let receivedFilter;
  // Devolver algo truthy corta la función en el chequeo de "ya está en uso"
  // (antes de getPlanForUser/createUserWithUniqueSlug, que no son mockeables
  // acá porque userController.js los importa por destructuring — el mismo
  // motivo por el que mailer.js se llama como `mailer.sendMail` en vez de
  // destructurado). Alcanza para confirmar qué username arma la query.
  t.mock.method(User, "findOne", async (filter) => {
    receivedFilter = filter;
    return { _id: "alguien-mas" };
  });

  const res = response();
  await newUser({
    body: {
      username: "MiLocal",
      password: "password-seguro",
      acceptedTerms: true,
      contactInfo: activeContact,
    },
  }, res);

  assert.equal(receivedFilter.username, "milocal");
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "El username ya está en uso");
});

test("newUser rechaza un email de contacto ausente o inválido antes de tocar la base", async () => {
  for (const mail of [undefined, "", "ididid", "sin-arroba.com"]) {
    const res = response();
    await newUser({
      body: {
        username: "nuevo-local",
        password: "password-seguro",
        acceptedTerms: true,
        contactInfo: { ...activeContact, mail },
      },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /email/i);
  }
});

test("editUser no bloquea una edición que no toca contactInfo, aunque la cuenta ya tenga un mail inválido guardado", async (t) => {
  let saved;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    saved = update.$set;
    return saved;
  });

  const res = response();
  await editUser({
    user: {
      _id: "64f000000000000000000123",
      subscription: "free",
      contactInfo: { ...activeContact, mail: "ididid" }, // cuenta vieja, ya con basura
    },
    body: { hasDelivery: true }, // no manda "contactInfo": no debe disparar el chequeo de mail
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(saved, { hasDelivery: true });
});

test("editUser rechaza actualizar contactInfo con un email inválido", async (t) => {
  t.mock.method(User, "findByIdAndUpdate", async () => assert.fail("no debe guardar con un email inválido"));

  const res = response();
  await editUser({
    user: {
      _id: "64f000000000000000000123",
      subscription: "free",
      contactInfo: activeContact,
    },
    body: { contactInfo: { mail: "ididid" } },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /email/i);
});

test("editUser resetea emailVerified y reenvía el código cuando cambia el mail real de la cuenta", async (t) => {
  t.mock.method(console, "error", () => {});
  // activeContact.businessName está seteado, así que editUser pasa por
  // updateUserWithUniqueSlug (ver editUser en userController.js) — sin este
  // mock, generateUniqueSlug cuelga 10s en un User.exists() sin conexión.
  t.mock.method(User, "exists", async () => false);
  t.mock.method(PendingServiceAction, "deleteMany", async () => ({ deletedCount: 0 }));
  t.mock.method(PendingServiceAction, "create", async (data) => ({ _id: "pending-1", ...data }));
  let sentTo = null;
  let sentAction = null;
  t.mock.method(mailer, "sendConfirmationCodeEmail", async ({ to, action }) => {
    sentTo = to;
    sentAction = action;
  });

  let saved;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    saved = update.$set;
    return { _id: "64f000000000000000000123", ...saved };
  });

  const res = response();
  await editUser({
    user: {
      _id: "64f000000000000000000123",
      subscription: "free",
      emailVerified: true,
      contactInfo: activeContact,
    },
    body: { contactInfo: { mail: "nuevo-mail@example.com" } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saved.contactInfo.mail, "nuevo-mail@example.com");
  assert.equal(saved.emailVerified, false, "el mail nuevo todavía no está confirmado");
  assert.equal(sentTo, "nuevo-mail@example.com", "el código nuevo va al mail nuevo, no al viejo");
  assert.equal(sentAction, "verificacion_email");
});

test("editUser no toca emailVerified ni manda mail si contactInfo se edita sin cambiar el mail", async (t) => {
  t.mock.method(User, "exists", async () => false);
  t.mock.method(mailer, "sendConfirmationCodeEmail", async () => assert.fail("no debe mandar mail"));
  t.mock.method(PendingServiceAction, "create", async () => assert.fail("no debe crear un pedido de verificación"));

  let saved;
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    saved = update.$set;
    return { _id: "64f000000000000000000123", ...saved };
  });

  const res = response();
  await editUser({
    user: {
      _id: "64f000000000000000000123",
      subscription: "free",
      emailVerified: true,
      contactInfo: activeContact,
    },
    body: { contactInfo: { address: "Otra dirección 456" } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saved.contactInfo.mail, activeContact.mail);
  assert.equal(saved.emailVerified, undefined, "no debe tocar emailVerified si el mail no cambió");
});
