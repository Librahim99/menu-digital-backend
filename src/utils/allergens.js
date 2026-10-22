// ──────────────────────────────────────────────
// Catálogo fijo de alérgenos y etiquetas dietarias de los productos.
//
// Los productos guardan solo los CÓDIGOS (Item.allergens, Item.mayContain,
// Item.dietary); el nombre y el orden salen de acá, así nadie escribe
// "Gluten", "gluten" o "TACC" de formas distintas y la carta puede armar
// filtros y grupos sin texto libre. Los alérgenos son los 14 de declaración
// obligatoria de la UE, que cubren la lista del Código Alimentario Argentino.
//
// Los códigos no se renombran nunca: están guardados en los productos. Para
// sumar uno, agregarlo al final de su lista.
// ──────────────────────────────────────────────

const ALLERGENS = [
  { code: "gluten", label: "Gluten" },
  { code: "crustaceos", label: "Crustáceos" },
  { code: "huevo", label: "Huevo" },
  { code: "pescado", label: "Pescado" },
  { code: "mani", label: "Maní" },
  { code: "soja", label: "Soja" },
  { code: "lacteos", label: "Lácteos" },
  { code: "frutos_secos", label: "Frutos secos" },
  { code: "apio", label: "Apio" },
  { code: "mostaza", label: "Mostaza" },
  { code: "sesamo", label: "Sésamo" },
  { code: "sulfitos", label: "Sulfitos" },
  { code: "altramuces", label: "Altramuces" },
  { code: "moluscos", label: "Moluscos" },
];

// `excludes`: alérgenos que el producto no puede contener si lleva la
// etiqueta. Sin TACC además implica cuidar la contaminación cruzada, por eso
// tampoco admite "puede contener gluten".
const DIETARY = [
  { code: "sin_tacc", label: "Sin TACC", excludes: ["gluten"] },
  { code: "vegetariano", label: "Vegetariano", excludes: ["pescado", "crustaceos", "moluscos"] },
  { code: "vegano", label: "Vegano", excludes: ["pescado", "crustaceos", "moluscos", "huevo", "lacteos"] },
];

const ALLERGEN_CODES = ALLERGENS.map((a) => a.code);
const DIETARY_CODES = DIETARY.map((d) => d.code);

const labelOf = (list, code) => list.find((entry) => entry.code === code)?.label ?? code;

// Lista de códigos validada y ordenada según el catálogo (sin repetidos).
// `undefined` = el campo no vino; null o [] = vaciarlo.
const normalizeCodes = (value, validCodes, fieldName) => {
  if (value === undefined) return { codes: undefined };
  if (value === null) return { codes: [] };
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string")) {
    return { error: `${fieldName} debe ser una lista de códigos` };
  }
  const unknown = value.filter((code) => !validCodes.includes(code));
  if (unknown.length > 0) {
    return { error: `${fieldName}: código desconocido "${unknown[0]}"` };
  }
  const chosen = new Set(value);
  return { codes: validCodes.filter((code) => chosen.has(code)) };
};

// Valida allergens, mayContain y dietary juntos. Los que no vinieron (undefined)
// se completan con `current` (lo que ya tiene guardado el producto) para
// chequear las combinaciones, pero en `updates` solo vuelven los que vinieron.
// Reglas:
//   - un alérgeno que el producto CONTIENE no se repite en "puede contener".
//   - una etiqueta dietaria no convive con los alérgenos que excluye
//     (ej. Sin TACC con gluten, ni siquiera como traza).
const validateAllergenFields = (input = {}, current = {}) => {
  const allergens = normalizeCodes(input.allergens, ALLERGEN_CODES, "allergens");
  if (allergens.error) return { error: allergens.error };
  const mayContain = normalizeCodes(input.mayContain, ALLERGEN_CODES, "mayContain");
  if (mayContain.error) return { error: mayContain.error };
  const dietary = normalizeCodes(input.dietary, DIETARY_CODES, "dietary");
  if (dietary.error) return { error: dietary.error };

  const finalAllergens = allergens.codes ?? current.allergens ?? [];
  let finalMayContain = mayContain.codes ?? current.mayContain ?? [];
  const finalDietary = dietary.codes ?? current.dietary ?? [];

  const updates = {};
  if (allergens.codes !== undefined) updates.allergens = allergens.codes;
  if (dietary.codes !== undefined) updates.dietary = dietary.codes;

  // "Contiene" pisa a "puede contener".
  const withoutContained = finalMayContain.filter((code) => !finalAllergens.includes(code));
  if (mayContain.codes !== undefined || withoutContained.length !== finalMayContain.length) {
    finalMayContain = withoutContained;
    updates.mayContain = finalMayContain;
  }

  for (const code of finalDietary) {
    const { label, excludes } = DIETARY.find((d) => d.code === code);
    const conflict = excludes.find((a) => finalAllergens.includes(a) || finalMayContain.includes(a));
    if (conflict) {
      return { error: `Un producto ${label} no puede contener ${labelOf(ALLERGENS, conflict).toLowerCase()}` };
    }
  }

  return { updates };
};

// Lo que expone GET /api/items/allergens: el catálogo para el editor y la
// carta (nombres, orden y qué excluye cada etiqueta).
const getAllergenCatalog = () => ({
  allergens: ALLERGENS.map(({ code, label }) => ({ code, label })),
  dietary: DIETARY.map(({ code, label, excludes }) => ({ code, label, excludes: [...excludes] })),
});

module.exports = {
  ALLERGENS,
  DIETARY,
  ALLERGEN_CODES,
  DIETARY_CODES,
  validateAllergenFields,
  getAllergenCatalog,
};
