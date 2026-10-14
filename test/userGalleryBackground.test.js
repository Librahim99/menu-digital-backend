// "Usar como portada" de una foto de la galería (menú contextual del editor
// del negocio): PATCH /api/users/background/from-gallery.

const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const { useGalleryAsBackground } = require("../src/controllers/userController");

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const PICTURES = ["https://res.cloudinary.com/x/a.jpg", "https://res.cloudinary.com/x/b.jpg"];

function setup(t, pictures = PICTURES) {
  const updates = [];
  t.mock.method(User, "findById", () => ({ select: async () => ({ media: { pictures } }) }));
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    updates.push(update);
    return { media: { pictures, backgroundPicture: update["media.backgroundPicture"] } };
  });
  return updates;
}

test("pone de portada la foto elegida de la galería", async (t) => {
  const updates = setup(t);
  const res = response();
  await useGalleryAsBackground({ user: { _id: "u1" }, body: { index: 1 } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(updates, [{ "media.backgroundPicture": PICTURES[1] }]);
  assert.equal(res.body.media.backgroundPicture, PICTURES[1]);
});

test("solo acepta un índice de la galería: ni URLs sueltas ni fotos que ya no están", async (t) => {
  const updates = setup(t);
  for (const body of [{ index: 5 }, { index: -1 }, { index: "0" }, { url: "https://evil.example/x.jpg" }, undefined]) {
    const res = response();
    await useGalleryAsBackground({ user: { _id: "u1" }, body }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.deepEqual(updates, []);
});
