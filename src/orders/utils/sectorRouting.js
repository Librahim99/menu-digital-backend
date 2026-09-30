// A qué sector va cada línea de un pedido. Puro (sin base) para poder
// probarlo solo.
//
// La asignación es en cascada, de lo más específico a lo más general:
//   producto > categoría > sección > sector por defecto del local.
// Así, si "Comidas" va a Cocina, todas sus categorías y productos van a
// Cocina salvo los que tengan un sector propio (ej. "Postres" → Pastelería,
// y dentro de Postres "Café con torta" → Barra).

const TARGET_TYPES = ["section", "category", "item"];

const keyOf = (targetType, targetId) => `${targetType}:${targetId}`;

/**
 * Índice de asignaciones para resolver rápido.
 * @param {Array<{ target_type: string, target_id: string, sector_id: number|string }>} rows
 * @returns {Map<string, number>}
 */
const indexAssignments = (rows) => {
  const index = new Map();
  for (const row of rows) index.set(keyOf(row.target_type, row.target_id), Number(row.sector_id));
  return index;
};

/**
 * Sector de una línea, o null si el local no tiene a dónde mandarla.
 * @param {{ itemId: string, categoryId?: string|null, sectionId?: string|null }} line
 * @param {{ assignments: Map<string, number>, activeSectorIds: Set<number>, defaultSectorId: number|null }} routing
 */
const resolveSectorId = (line, { assignments, activeSectorIds, defaultSectorId }) => {
  const candidates = [
    ["item", line.itemId],
    ["category", line.categoryId],
    ["section", line.sectionId],
  ];
  for (const [type, id] of candidates) {
    if (!id) continue;
    const sectorId = assignments.get(keyOf(type, String(id)));
    // Una asignación a un sector dado de baja no cuenta: sigue la cascada.
    if (sectorId !== undefined && activeSectorIds.has(sectorId)) return sectorId;
  }
  return defaultSectorId !== null && activeSectorIds.has(defaultSectorId) ? defaultSectorId : null;
};

/**
 * Agrupa las líneas por sector (en el orden en que aparece cada sector).
 * Las líneas sin sector quedan afuera.
 * @returns {Map<number, Array>}
 */
const groupLinesBySector = (lines, routing) => {
  const groups = new Map();
  for (const line of lines) {
    const sectorId = resolveSectorId(line, routing);
    if (sectorId === null) continue;
    if (!groups.has(sectorId)) groups.set(sectorId, []);
    groups.get(sectorId).push(line);
  }
  return groups;
};

/**
 * Datos para resolver a partir de los sectores activos del local: si no hay
 * uno marcado como "por defecto", el primero cumple ese papel (nunca queda
 * una línea sin sector cuando el local tiene sectores).
 * @param {Array<{ id, is_default }>} sectors  activos, ordenados por posición
 */
const buildRouting = (sectors, assignmentRows) => {
  const activeSectorIds = new Set(sectors.map((sector) => Number(sector.id)));
  const fallback = sectors.find((sector) => sector.is_default) ?? sectors[0] ?? null;
  return {
    assignments: indexAssignments(assignmentRows),
    activeSectorIds,
    defaultSectorId: fallback ? Number(fallback.id) : null,
  };
};

module.exports = { TARGET_TYPES, indexAssignments, resolveSectorId, groupLinesBySector, buildRouting };
