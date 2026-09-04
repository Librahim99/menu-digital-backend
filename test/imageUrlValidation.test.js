// `image` en Item/Menu solo debería contener URLs que realmente vengan de
// Cloudinary (la única fuente legítima, ver src/utils/imageUrl.js). Antes
// de este fix, cualquier string llegaba tal cual al HTML que Puppeteer
// procesa para generar el PDF del menú (SSRF/XSS — ver DEVLOG-LUCAS.md).
const test = require("node:test");
const assert = require("node:assert/strict");

const ORIGINAL_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";

const { isValidImageUrl } = require("../src/utils/imageUrl");
const Item = require("../src/models/Item");
const Menu = require("../src/models/Menu");
const { buildMenuHTML } = require("../src/utils/menuPdfTemplate");

test.after(() => {
  process.env.CLOUDINARY_CLOUD_NAME = ORIGINAL_CLOUD_NAME;
});

const VALID_URL = "https://res.cloudinary.com/test-cloud/image/upload/v1/menu-digital/items/foo.jpg";

test("isValidImageUrl acepta vacío y URLs del cloud de Cloudinary configurado", () => {
  assert.equal(isValidImageUrl(""), true);
  assert.equal(isValidImageUrl(undefined), true);
  assert.equal(isValidImageUrl(null), true);
  assert.equal(isValidImageUrl(VALID_URL), true);
});

test("isValidImageUrl rechaza hosts arbitrarios, IPs internas y otros cloud names", () => {
  assert.equal(isValidImageUrl("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isValidImageUrl("https://evil.example.com/img.jpg"), false);
  assert.equal(isValidImageUrl("https://res.cloudinary.com/otro-cloud/x.jpg"), false);
  assert.equal(isValidImageUrl("javascript:alert(1)"), false);
  assert.equal(isValidImageUrl("x\" onerror=\"alert(1)"), false);
});

test("isValidImageUrl rechaza cualquier URL no vacía si no hay CLOUDINARY_CLOUD_NAME configurado", () => {
  const prev = process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_CLOUD_NAME;
  try {
    assert.equal(isValidImageUrl(VALID_URL), false);
    assert.equal(isValidImageUrl(""), true);
  } finally {
    process.env.CLOUDINARY_CLOUD_NAME = prev;
  }
});

test("Item rechaza una imagen que no sea de Cloudinary", () => {
  const item = new Item({
    menuID: new (require("mongoose").Types.ObjectId)(),
    title: "Pizza",
    image: "http://169.254.169.254/latest/meta-data/",
  });
  const err = item.validateSync();
  assert.ok(err?.errors?.image, "debe rechazar la imagen");
});

test("Item acepta una imagen de Cloudinary", () => {
  const item = new Item({
    menuID: new (require("mongoose").Types.ObjectId)(),
    title: "Pizza",
    image: VALID_URL,
  });
  const err = item.validateSync();
  assert.equal(err?.errors?.image, undefined);
});

test("Menu rechaza una imagen que no sea de Cloudinary", () => {
  const menu = new Menu({
    userID: new (require("mongoose").Types.ObjectId)(),
    title: "Bebidas",
    image: "https://evil.example.com/img.jpg",
  });
  const err = menu.validateSync();
  assert.ok(err?.errors?.image, "debe rechazar la imagen");
});

test("buildMenuHTML escapa una imagen maliciosa en vez de inyectarla cruda en el HTML", () => {
  const html = buildMenuHTML({
    businessName: "Mi Local",
    menuArmado: {
      sinSeccion: [
        {
          title: "Pizzas",
          image: 'x" onerror="fetch(1)',
          items: [
            {
              title: "Napolitana",
              image: 'y" onerror="fetch(2)',
              price: 1000,
              available: true,
              hidden: false,
            },
          ],
        },
      ],
    },
  });

  assert.ok(!html.includes('onerror="fetch'), "no debe quedar un atributo onerror sin escapar");
  assert.ok(html.includes("&quot;"), "las comillas del valor malicioso deben quedar escapadas");
});
