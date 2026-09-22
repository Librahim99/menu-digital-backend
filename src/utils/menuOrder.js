// ──────────────────────────────────────────────
// Orden de la carta: la posición de cada sección, categoría y producto.
//
// `order` (en Menu y en Item) es la posición dentro de su contenedor:
//   - un producto, dentro de su categoría (menuID);
//   - una categoría, dentro de su sección (sectionID; null = "sin sección");
//   - una sección, entre las secciones del local.
//
// Todo lo que dibuja la carta ordena por `order` y, a igualdad, por `_id`
// (orden de creación). Los documentos anteriores a este campo no lo tienen:
// quedan primero y por orden de creación, que es exactamente como se veían
// antes, así que no hace falta migrar nada. Mongo ordena un campo ausente
// como null, antes que cualquier número; compareMenuOrder replica ese mismo
// criterio para lo que se ordena en memoria.
//
// Las altas van al final de su contenedor (el `order` más alto + 1), y
// reordenar reescribe el contenedor entero con 0, 1, 2... (buildReorder),
// así que con el uso los números quedan compactos.
// ──────────────────────────────────────────────

const MENU_ORDER_SORT = Object.freeze({ order: 1, _id: 1 });

const hasOrder = (doc) => typeof doc?.order === "number" && Number.isFinite(doc.order);

// Mismo criterio que MENU_ORDER_SORT: sin `order` primero, después por
// `order`, y a igualdad por `_id` (el hex de un ObjectId ordena igual que
// Mongo). Acepta documentos Mongoose y objetos planos.
const compareMenuOrder = (a, b) => {
  const aHasOrder = hasOrder(a);
  const bHasOrder = hasOrder(b);
  if (aHasOrder !== bHasOrder) return aHasOrder ? 1 : -1;
  if (aHasOrder && a.order !== b.order) return a.order - b.order;
  const aId = String(a._id);
  const bId = String(b._id);
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
};

// Copia ordenada (no toca el array original).
const sortByMenuOrder = (docs) => [...(docs ?? [])].sort(compareMenuOrder);

// Secciones y categorías en el orden en que se leen en la carta: cada sección
// seguida de sus categorías, después las categorías sin sección y al final
// las que apuntan a una sección que ya no existe (la carta no las muestra,
// pero una exportación no debe perderlas).
const flattenMenusInOrder = (menus) => {
  const sorted = sortByMenuOrder(menus);
  const sections = sorted.filter((menu) => menu.section === true);
  const sectionIds = new Set(sections.map((section) => String(section._id)));
  const categories = sorted.filter((menu) => menu.section !== true);

  return [
    ...sections.flatMap((section) => [
      section,
      ...categories.filter((category) => category.sectionID && String(category.sectionID) === String(section._id)),
    ]),
    ...categories.filter((category) => !category.sectionID),
    ...categories.filter((category) => category.sectionID && !sectionIds.has(String(category.sectionID))),
  ];
};

// ──────────────────────────────────────────────
// Contenedores
// ──────────────────────────────────────────────

// Clave del contenedor de un Menu: las secciones de un local comparten uno;
// cada categoría vive en el de su sección, o en el de las sueltas.
const menuContainerKey = ({ section, sectionID }) => (section === true
  ? "sections"
  : `categories:${sectionID ? String(sectionID) : "loose"}`);

const itemContainerKey = ({ menuID }) => String(menuID);

// Filtro de Mongo para el contenedor de un Menu. `section` puede faltar en
// documentos viejos: todo lo que no es sección es categoría. `sectionID: null`
// también encuentra los que no tienen el campo.
const menuContainerFilter = (userID, { section, sectionID }) => (section === true
  ? { userID, section: true }
  : { userID, section: { $ne: true }, sectionID: sectionID || null });

// ──────────────────────────────────────────────
// Altas: posición al final del contenedor
// ──────────────────────────────────────────────

// Para una alta suelta (newItem, newMenu y los move): una posición después de
// la última del contenedor que describe `filter`, o 0 si ninguno tiene `order`
// todavía (así queda después de los que no lo tienen).
const getNextOrder = async (Model, filter) => {
  const last = await Model.findOne({ ...filter, order: { $ne: null } })
    .sort({ order: -1 })
    .select("order")
    .lean();
  return hasOrder(last) ? last.order + 1 : 0;
};

// Para altas en lote (plantillas, Excel): parte de lo que ya hay en cada
// contenedor (`docs`, ya cargados) y reparte posiciones al final, de a una,
// sin una consulta por alta. `getKey` es menuContainerKey o itemContainerKey.
const createOrderAllocator = (docs, getKey) => {
  const nextByKey = new Map();
  for (const doc of docs ?? []) {
    const key = getKey(doc);
    const next = hasOrder(doc) ? doc.order + 1 : 0;
    if (next > (nextByKey.get(key) ?? 0)) nextByKey.set(key, next);
  }
  return (key) => {
    const order = nextByKey.get(key) ?? 0;
    nextByKey.set(key, order + 1);
    return order;
  };
};

// ──────────────────────────────────────────────
// Reordenar un contenedor
// ──────────────────────────────────────────────

// Tope de ids por pedido: el mismo que cubre una carta real entera en la
// carta pública (PUBLIC_MENU_ITEMS_BATCH_SIZE).
const MAX_REORDER_IDS = 2000;

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

const isObjectIdString = (value) => typeof value === "string" && OBJECT_ID_PATTERN.test(value);

// La lista de un pedido de reordenamiento: un array no vacío de ObjectId en
// texto, sin repetidos (un id repetido tendría dos posiciones). null si no
// cumple.
const parseReorderIds = (value) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REORDER_IDS) return null;
  if (!value.every(isObjectIdString)) return null;
  if (new Set(value.map((id) => id.toLowerCase())).size !== value.length) return null;
  return value.map((id) => id.toLowerCase());
};

// Orden final de un contenedor: primero `requestedIds`, en ese orden, y
// después lo que ya estaba en el contenedor y el pedido no nombra (por
// ejemplo, un producto creado desde otra pestaña), en su orden actual.
// Devuelve esos ids y las operaciones de bulkWrite que dejan a cada uno con
// order 0, 1, 2... Los que llegan desde otro contenedor reciben además
// `containerPatch` ({ menuID } o { sectionID }). Solo escribe lo que cambia.
// `docsById` tiene todos los documentos involucrados (los del contenedor y
// los pedidos), con clave String(_id).
const buildReorder = ({ requestedIds, containerDocs, docsById, containerPatch }) => {
  const requested = requestedIds.map(String);
  const requestedSet = new Set(requested);
  const containerIds = new Set(containerDocs.map((doc) => String(doc._id)));
  const rest = sortByMenuOrder(containerDocs)
    .map((doc) => String(doc._id))
    .filter((id) => !requestedSet.has(id));
  const orderedIds = [...requested, ...rest];

  const operations = [];
  orderedIds.forEach((id, order) => {
    const doc = docsById.get(id);
    const joins = !containerIds.has(id);
    if (!joins && doc.order === order) return;
    operations.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: joins ? { order, ...containerPatch } : { order } },
      },
    });
  });

  return { orderedIds, operations };
};

module.exports = {
  MENU_ORDER_SORT,
  MAX_REORDER_IDS,
  compareMenuOrder,
  sortByMenuOrder,
  flattenMenusInOrder,
  menuContainerKey,
  itemContainerKey,
  menuContainerFilter,
  getNextOrder,
  createOrderAllocator,
  isObjectIdString,
  parseReorderIds,
  buildReorder,
};
