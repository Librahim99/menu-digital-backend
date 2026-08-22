const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const {
  createUserWithUniqueSlug,
  generateUniqueSlug,
  updateUserWithUniqueSlug,
} = require("../src/utils/slug");

test("agrega un sufijo incremental cuando el slug ya existe", async (t) => {
  const answers = [true, true, false];
  t.mock.method(User, "exists", async () => answers.shift());

  assert.equal(await generateUniqueSlug("Café Roma"), "cafe-roma-3");
});

test("reintenta la creación si el índice detecta una carrera de slug", async (t) => {
  const existence = [false, true, false];
  t.mock.method(User, "exists", async () => existence.shift());

  let attempts = 0;
  t.mock.method(User, "create", async (data) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("duplicate key");
      error.code = 11000;
      error.keyPattern = { slug: 1 };
      throw error;
    }
    return data;
  });

  const user = await createUserWithUniqueSlug({
    username: "cafe-roma",
    password: "password-seguro",
    contactInfo: { businessName: "Café Roma" },
  });

  assert.equal(attempts, 2);
  assert.equal(user.slug, "cafe-roma-2");
});

test("reintenta una edición si otro usuario toma el slug al mismo tiempo", async (t) => {
  const existence = [false, true, false];
  t.mock.method(User, "exists", async () => existence.shift());

  let attempts = 0;
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("duplicate key");
      error.code = 11000;
      error.keyValue = { slug: "cafe-roma" };
      throw error;
    }
    return { id, ...update.$set };
  });

  const user = await updateUserWithUniqueSlug("user-1", {
    contactInfo: { businessName: "Café Roma" },
  });

  assert.equal(attempts, 2);
  assert.equal(user.slug, "cafe-roma-2");
});
