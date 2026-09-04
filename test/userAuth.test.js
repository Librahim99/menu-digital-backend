const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const { loginUser } = require("../src/controllers/userController");

function response() {
  return {
    statusCode: null,
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

test("el login manual devuelve el slug requerido por AuthProvider", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "jwt-secret-de-prueba";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const user = {
    _id: "64f000000000000000000123",
    username: "restaurante-test",
    admin: false,
    active: true,
    slug: "restaurante-test",
    subscription: "basic",
    subscriptionExpiresAt: new Date("2099-09-21T15:00:00.000Z"),
    matchPassword: async (password) => password === "password-seguro",
  };
  t.mock.method(User, "findOne", () => ({
    select: async () => user,
  }));

  const req = {
    body: {
      username: user.username,
      password: "password-seguro",
    },
  };
  const res = response();

  await loginUser(req, res);

  assert.equal(res.statusCode, null);
  assert.equal(res.body.slug, user.slug);
  assert.equal(res.body.subscription, "basic");
  assert.equal(res.body.subscriptionStatus, "active");
  assert.equal(
    jwt.verify(res.body.token, process.env.JWT_SECRET).id,
    user._id
  );
});

test("el login informa el downgrade efectivo cuando venció un plan pago", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "jwt-secret-de-prueba";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const user = {
    _id: "64f000000000000000000124",
    username: "restaurante-vencido",
    admin: false,
    active: true,
    slug: "restaurante-vencido",
    subscription: "pro",
    subscriptionExpiresAt: new Date(0),
    matchPassword: async (password) => password === "password-seguro",
  };
  t.mock.method(User, "findOne", () => ({
    select: async () => user,
  }));

  const res = response();
  await loginUser({ body: { username: user.username, password: "password-seguro" } }, res);

  assert.equal(res.body.subscription, "free");
  assert.equal(res.body.subscriptionStatus, "expired");
  assert.equal(res.body.previousSubscription, "pro");
  assert.equal(res.body.downgradeReason, "subscription_expired");
  assert.equal(new Date(res.body.downgradedAt).getTime(), 0);
});
