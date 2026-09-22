const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const ExcelJS = require("exceljs");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const { confirmMassive, previewMassive, getTemplate } = require("../src/controllers/massiveController");

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

// Reproduce el bug reportado en producción: un archivo que no es un .xlsx
// real (renombrado, .xls viejo, corrupto) hacía que ExcelJS tirara un
// TypeError interno ("Cannot read properties of undefined (reading 'sheets')")
// que se colaba como 500 genérico. Debe responder 400 con un mensaje
// accionable, no crashear.
test("previewMassive responde 400 (no 500) si el archivo no es un .xlsx válido", async () => {
  const res = response();
  await previewMassive(
    { file: { buffer: Buffer.from("esto no es un excel, es texto plano") }, user: { _id: "u1" } },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "INVALID_EXCEL_FILE");
  assert.match(res.body.message, /no pudimos leer el archivo/i);
});

test("previewMassive responde 400 si el Excel no tiene las hojas correctas", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Hoja1").addRow(["codigo", "titulo"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const res = response();
  await previewMassive({ file: { buffer }, user: { _id: "u1" } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "INVALID_EXCEL_FILE");
  assert.match(res.body.message, /hojas correctas/i);
});

// ──────────────────────────────────────────────
// Orden (tarjeta "Poder ordenar el menú"): lo que crea el Excel va al final
// de su categoría, lo que cambia de categoría va al final de la nueva, y la
// plantilla descargada sale en el orden de la carta.
// ──────────────────────────────────────────────

const OTHER_MENU_ID = "64f000000000000000000202";

test("confirmMassive: los productos nuevos van al final de su categoría, en el orden de las filas", async (t) => {
  const buffer = await buildWorkbook([
    ["PROD-2", "Empanada", "", "CAT-1", 900, "", "", "", "NO", "NO", "NO", "SI"],
    ["PROD-3", "Tarta", "", "CAT-1", 1200, "", "", "", "NO", "NO", "NO", "SI"],
  ]);
  t.mock.method(Menu, "find", async () => [{ _id: MENU_ID, code: "CAT-1" }]);
  t.mock.method(Item, "find", async () => [{ _id: ITEM_ID, code: "PROD-1", menuID: MENU_ID, order: 4 }]);
  const created = [];
  t.mock.method(Item, "create", async (data) => { created.push(data); return data; });

  const res = response();
  await confirmMassive({ file: { buffer }, user: { _id: "u1" }, plan: { features: { item_limit: null } } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(created.map((item) => [item.code, item.order]), [["PROD-2", 5], ["PROD-3", 6]]);
});

test("confirmMassive: un producto que el Excel cambia de categoría va al final de la nueva", async (t) => {
  const buffer = await buildWorkbook([
    ["PROD-1", "Milanesa", "", "CAT-2", 4500, "", "", "", "NO", "NO", "NO", "SI"],
  ]);
  t.mock.method(Menu, "find", async () => [
    { _id: MENU_ID, code: "CAT-1" },
    { _id: OTHER_MENU_ID, code: "CAT-2" },
  ]);
  t.mock.method(Item, "find", async () => [
    { _id: ITEM_ID, code: "PROD-1", menuID: MENU_ID, order: 0 },
    { _id: "64f000000000000000000302", code: "PROD-9", menuID: OTHER_MENU_ID, order: 2 },
  ]);
  let update;
  t.mock.method(Item, "findByIdAndUpdate", async (_id, received) => { update = received; return {}; });

  const res = response();
  await confirmMassive({ file: { buffer }, user: { _id: "u1" }, plan: { features: { item_limit: null } } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(String(update.$set.menuID), OTHER_MENU_ID);
  assert.equal(update.$set.order, 3);
});

test("getTemplate exporta en el orden de la carta: cada sección con sus categorías y los productos agrupados", async (t) => {
  const seccion = { _id: "64f000000000000000000401", code: "SEC", title: "Comidas", section: true, order: 0 };
  const pizzas = { _id: "64f000000000000000000402", code: "PIZ", title: "Pizzas", sectionID: seccion._id, order: 1 };
  const empanadas = { _id: "64f000000000000000000403", code: "EMP", title: "Empanadas", sectionID: seccion._id, order: 0 };
  const suelta = { _id: "64f000000000000000000404", code: "SUE", title: "Sueltas" };
  t.mock.method(Menu, "find", async () => [suelta, pizzas, empanadas, seccion]);
  t.mock.method(Item, "find", async () => [
    { _id: "64f000000000000000000501", code: "P2", title: "Napolitana", menuID: pizzas._id, order: 1 },
    { _id: "64f000000000000000000502", code: "S1", title: "Suelto", menuID: suelta._id },
    { _id: "64f000000000000000000503", code: "E1", title: "Carne", menuID: empanadas._id, order: 0 },
    { _id: "64f000000000000000000504", code: "P1", title: "Muzzarella", menuID: pizzas._id, order: 0 },
  ]);

  // La respuesta es un stream: se junta lo escrito y se vuelve a leer como Excel.
  const res = new PassThrough();
  res.setHeader = () => {};
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve) => res.on("end", resolve));
  await getTemplate({ user: { _id: "u1" } }, res);
  await finished;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  const codes = (sheetName) => {
    const rows = [];
    workbook.getWorksheet(sheetName).eachRow((row, rowNumber) => {
      if (rowNumber > 1) rows.push(row.getCell(1).value);
    });
    return rows;
  };
  assert.deepEqual(codes("🟦 Categorías"), ["SEC", "EMP", "PIZ", "SUE"]);
  assert.deepEqual(codes("🟩 Productos"), ["E1", "P1", "P2", "S1"]);
});
