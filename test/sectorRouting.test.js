const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRouting, groupLinesBySector, resolveSectorId } = require("../src/orders/utils/sectorRouting");
const { normalizePairingCode, randomPairingCode, formatPairingCode } = require("../src/orders/utils/tokens");

// Comandas: a qué sector va cada línea del pedido. Cascada producto >
// categoría > sección > sector por defecto.

const COCINA = { id: "1", is_default: true };
const BARRA = { id: "2", is_default: false };
const POSTRES = { id: "3", is_default: false };

const line = (itemId, categoryId, sectionId) => ({ itemId, categoryId, sectionId });

const routing = buildRouting([COCINA, BARRA, POSTRES], [
  { target_type: "section", target_id: "sec-bebidas", sector_id: "2" },
  { target_type: "category", target_id: "cat-postres", sector_id: "3" },
  { target_type: "item", target_id: "item-cafe", sector_id: "2" },
]);

test("sin asignación, la línea va al sector por defecto", () => {
  assert.equal(resolveSectorId(line("item-milanesa", "cat-platos", "sec-comidas"), routing), 1);
});

test("la sección manda sobre el sector por defecto", () => {
  assert.equal(resolveSectorId(line("item-cerveza", "cat-cervezas", "sec-bebidas"), routing), 2);
});

test("la categoría manda sobre la sección y el producto sobre la categoría", () => {
  assert.equal(resolveSectorId(line("item-flan", "cat-postres", "sec-comidas"), routing), 3);
  assert.equal(resolveSectorId(line("item-cafe", "cat-postres", "sec-comidas"), routing), 2);
});

test("una categoría sin sección hereda directo del sector por defecto", () => {
  assert.equal(resolveSectorId(line("item-x", "cat-suelta", null), routing), 1);
});

test("una asignación a un sector dado de baja no cuenta: sigue la cascada", () => {
  const sinBarra = buildRouting([COCINA, POSTRES], [
    { target_type: "item", target_id: "item-cafe", sector_id: "2" },
    { target_type: "category", target_id: "cat-postres", sector_id: "3" },
  ]);
  assert.equal(resolveSectorId(line("item-cafe", "cat-postres", null), sinBarra), 3);
});

test("sin sector marcado por defecto, el primero cumple ese papel", () => {
  const sinDefault = buildRouting([BARRA, POSTRES], []);
  assert.equal(sinDefault.defaultSectorId, 2);
});

test("sin sectores no hay a dónde mandar nada", () => {
  const vacio = buildRouting([], []);
  assert.equal(resolveSectorId(line("item-x", "cat", "sec"), vacio), null);
  assert.equal(groupLinesBySector([line("item-x", "cat", "sec")], vacio).size, 0);
});

test("agrupa las líneas por sector en el orden en que aparecen", () => {
  const groups = groupLinesBySector([
    line("item-cerveza", "cat-cervezas", "sec-bebidas"),
    line("item-milanesa", "cat-platos", "sec-comidas"),
    line("item-agua", "cat-aguas", "sec-bebidas"),
  ], routing);
  assert.deepEqual([...groups.keys()], [2, 1]);
  assert.deepEqual(groups.get(2).map((l) => l.itemId), ["item-cerveza", "item-agua"]);
});

test("código de vinculación: se tipea con o sin guion, en minúsculas o con espacios", () => {
  const code = randomPairingCode();
  assert.match(code, /^[A-HJKMNP-Z2-9]{8}$/);
  const shown = formatPairingCode(code);
  assert.equal(normalizePairingCode(shown), code);
  assert.equal(normalizePairingCode(shown.toLowerCase().replace("-", " ")), code);
  assert.equal(normalizePairingCode(code.slice(0, 7)), null);
  // Caracteres que se confunden y no forman parte del alfabeto.
  assert.equal(normalizePairingCode("ABCD-EFG0"), null);
  assert.equal(normalizePairingCode("ABCD-EFGI"), null);
  assert.equal(normalizePairingCode(12345678), null);
});
