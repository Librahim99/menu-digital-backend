// Código automático de producto/categoría/sección (panelSettings.autoGenerateCodes
// — ver tarjeta Trello "Generación automática de codigo de productos").
//
// Combina 4 caracteres entre el nombre y el ID de Mongo: primer y último
// carácter de cada uno. Si ese código ya está en uso, se prueba con el
// segundo y anteúltimo carácter de cada uno, y así sucesivamente.
const MAX_ATTEMPTS = 6;

const charAt = (str, indexFromStart) =>
  indexFromStart >= 0 && indexFromStart < str.length ? str[indexFromStart] : "";

const buildCandidate = (name, id, attempt) => {
  const namePart = charAt(name, attempt) + charAt(name, name.length - 1 - attempt);
  const idPart = charAt(id, attempt) + charAt(id, id.length - 1 - attempt);
  return (namePart + idPart).toUpperCase();
};

// existingCodes: códigos ya usados por otros documentos del mismo user
// (otros productos, u otras categorías/secciones según el caso).
function generateAutoCode(name, id, existingCodes) {
  const cleanName = String(name || "").trim();
  const cleanId = String(id || "");
  const taken = new Set((existingCodes || []).filter(Boolean).map((c) => c.toUpperCase()));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = buildCandidate(cleanName, cleanId, attempt);
    if (candidate.length === 4 && !taken.has(candidate)) return candidate;
  }

  // Última instancia (prácticamente inalcanzable con IDs de 24 caracteres):
  // no bloquea la creación aunque los intentos anteriores hayan colisionado.
  return `${cleanId.slice(-4).toUpperCase()}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

module.exports = { generateAutoCode };
