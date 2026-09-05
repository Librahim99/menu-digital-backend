const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const { confirmMassive } = require("../src/controllers/massiveController");

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

// Arma un .xlsx con las dos hojas que espera la importación. Se construye de
// verdad (no se mockea parseExcel) para que el test recorra el mismo camino
// que un archivo subido por un usuario.
async function buildWorkbook(itemRows) {
  const workbook = new ExcelJS.Workbook();

  const categorias = workbook.addWorksheet("🟦 Categorías");
  categorias.addRow(["codigo", "titulo", "codigo_seccion_padre"]);

  const productos = workbook.addWorksheet("🟩 Productos");
  productos.addRow([
    "codigo", "titulo", "descripcion", "codigo_categoria", "precio",
    "precio_oferta", "inicio_oferta", "fin_oferta",
    "extra", "destacado", "oculto", "disponible",
  ]);
  itemRows.forEach((row) => productos.addRow(row));

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const MENU_ID = "64f000000000000000000201";
const ITEM_ID = "64f000000000000000000301";

test("confirmMassive corre los validators al actualizar: un precio negativo del Excel no se persiste", async (t) => {
  const buffer = await buildWorkbook([
    // Producto ya existente (código PROD-1) con precio negativo.
    ["PROD-1", "Milanesa", "", "CAT-1", -500, "", "", "", "NO", "NO", "NO", "SI"],
  ]);

  t.mock.method(Menu, "find", async () => [{ _id: MENU_ID, code: "CAT-1" }]);
  t.mock.method(Item, "find", async () => [{ _id: ITEM_ID, code: "PROD-1", menuID: MENU_ID }]);

  let updateOptions = null;
  t.mock.method(Item, "findByIdAndUpdate", async (_id, _update, options) => {
    updateOptions = options;
    // Con runValidators, Mongoose rechaza el precio negativo igual que en el
    // editor normal; se simula ese rechazo para comprobar que el error se
    // reporta como fila con error en vez de guardarse.
    if (options?.runValidators) {
      const error = new Error("El precio no puede ser negativo");
      error.name = "ValidationError";
      throw error;
    }
    return {};
  });

  const res = response();
  // req.plan precargado: getRequestPlan lo respeta y no consulta la base.
  await confirmMassive(
    { file: { buffer }, user: { _id: "u1" }, plan: { features: { item_limit: null } } },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(updateOptions, "findByIdAndUpdate no fue llamado");
  assert.equal(
    updateOptions.runValidators,
    true,
    "la actualización masiva debe correr los validators del schema",
  );
  assert.equal(res.body.resultado.productos.actualizados.length, 0);
  assert.equal(res.body.resultado.productos.errores.length, 1);
  assert.match(res.body.resultado.productos.errores[0].razon, /negativo/i);
});

test("confirmMassive actualiza normalmente un producto con precio válido", async (t) => {
  const buffer = await buildWorkbook([
    ["PROD-1", "Milanesa", "", "CAT-1", 4500, "", "", "", "NO", "NO", "NO", "SI"],
  ]);

  t.mock.method(Menu, "find", async () => [{ _id: MENU_ID, code: "CAT-1" }]);
  t.mock.method(Item, "find", async () => [{ _id: ITEM_ID, code: "PROD-1", menuID: MENU_ID }]);

  let persistedPrice;
  t.mock.method(Item, "findByIdAndUpdate", async (_id, update) => {
    persistedPrice = update.$set.price;
    return {};
  });

  const res = response();
  // req.plan precargado: getRequestPlan lo respeta y no consulta la base.
  await confirmMassive(
    { file: { buffer }, user: { _id: "u1" }, plan: { features: { item_limit: null } } },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(persistedPrice, 4500);
  assert.equal(res.body.resultado.productos.actualizados.length, 1);
  assert.equal(res.body.resultado.productos.errores.length, 0);
});
