const { isScheduleAvailableAt } = require("./itemAvailability");
const { isOfferActive } = require("./offers");

// ──────────────────────────────────────────────
// Serializador de la carta pública v2 (GET /api/users/:slug/menu?v=2).
//
// Módulo PURO a propósito: no requiere mongoose ni los modelos, y la hora se
// inyecta (`now`), para poder testear ofertas y horarios con fechas fijas sin
// mocks. Reusa las reglas de utils/offers.js y utils/itemAvailability.js tal
// cual (ya resuelven día y hora en America/Argentina/Buenos_Aires), así que
// no hay una segunda definición de "oferta vigente" ni de "disponible ahora".
//
// A diferencia del camino legacy (getPublicMenuItem en userController.js),
// acá el JSON solo lleva lo que la carta dibuja:
//   - lo vacío se OMITE (description '', image '', recommended false,
//     apt {}, options {}, offerPrice null...): el front lo tolera ausente.
//   - los productos pausados (interruptor manual) o fuera de su horario
//     programado SÍ viajan, con `available: false`, y la carta los muestra
//     como "No disponible" (igual que el legacy). Los disponibles ahora no
//     llevan la clave. Solo `hidden` saca un producto de la carta.
//   - offerRange/offerSchedule/availabilitySchedule no viajan: solo se manda
//     offerPrice cuando la oferta rige AHORA (el front ya no la re-resuelve).
//   - las secciones y categorías sin _id ni metadatos, y las que quedan
//     vacías se podan (igual que ya hace el PDF).
// El camino legacy y el PDF NO usan este módulo: el template del PDF exige
// hidden/available e image/description en categorías y secciones.
// ──────────────────────────────────────────────

// Acepta documentos lean (objetos planos) y documentos Mongoose: los tests
// existentes construyen `new Item(...)`. flattenMaps convierte options (Map)
// en objeto plano.
const plain = (doc) => doc?.toObject?.({ flattenMaps: true }) ?? doc;

const hasKeys = (value) =>
  value != null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;

// options puede llegar como Map si alguien pasa un documento sin aplanar.
const plainOptions = (options) => {
  if (options instanceof Map) return Object.fromEntries(options);
  return options != null && typeof options === "object" ? options : {};
};

// ──────────────────────────────────────────────
// Reglas de vigencia
// ──────────────────────────────────────────────

// lean() no aplica los defaults del schema: un item sin `available` guardado
// es "disponible" (default true), así que solo un `false` explícito lo saca.
// La programación semanal solo restringe con el permiso del plan y
// habilitada, igual que getPublicItemForPlan; fuera de su rango de fechas
// isScheduleAvailableAt devuelve true (manda el interruptor manual).
const isItemAvailableNow = (raw, features = {}, now = new Date()) => {
  const item = plain(raw);
  if (item.available === false) return false;
  if (features?.programacion_productos && item.availabilitySchedule?.enabled) {
    return isScheduleAvailableAt(item.availabilitySchedule, now);
  }
  return true;
};

// Precio de oferta que rige AHORA, o null. Mismas reglas que
// getPublicItemForPlan: sin programacion_productos una oferta con rango o
// horario se ignora (queda solo lo que sea manual/permanente), y después
// isOfferActive decide con el rango de fechas y el horario semanal. Exige
// price: nunca hay oferta sin precio original con el que compararla.
const resolveOfferPrice = (raw, features = {}, now = new Date()) => {
  const item = plain(raw);
  if (item.offerPrice == null) return null;
  const isScheduled = item.offerRange?.from || item.offerRange?.to || item.offerSchedule?.enabled;
  if (isScheduled && !features?.programacion_productos) return null;
  const active = isOfferActive({
    price: item.price,
    offerPrice: item.offerPrice,
    offerRange: item.offerRange,
    offerSchedule: item.offerSchedule,
  }, now);
  return active ? item.offerPrice : null;
};

// ──────────────────────────────────────────────
// Item
// ──────────────────────────────────────────────

// Item v2 o null si no debe viajar (solo si está oculto). Pausado o fuera de
// horario viaja con `available: false`.
// `_id` es imprescindible: las vistas por plato y el carrito se identifican
// con él.
// Con hidePrices no se manda price ni offerPrice, pero options conserva las
// CLAVES con valor 0: el pedido por variante depende de los nombres (mismo
// criterio que hideItemPrices en userController.js).
const toPublicItem = (raw, { features = {}, hidePrices = false, now = new Date() } = {}) => {
  const item = plain(raw);
  if (!item || item.hidden === true) return null;

  const publicItem = { _id: item._id, title: item.title };
  if (!isItemAvailableNow(item, features, now)) publicItem.available = false;

  if (!hidePrices && item.price != null) {
    publicItem.price = item.price;
    const offerPrice = resolveOfferPrice(item, features, now);
    if (offerPrice != null) publicItem.offerPrice = offerPrice;
  }
  if (item.description) publicItem.description = item.description;
  if (item.image) publicItem.image = item.image;

  const options = plainOptions(item.options);
  const optionNames = Object.keys(options);
  if (optionNames.length > 0) {
    publicItem.options = hidePrices
      ? Object.fromEntries(optionNames.map((name) => [name, 0]))
      : { ...options };
  }

  if (item.recommended === true) publicItem.recommended = true;
  if (hasKeys(item.apt)) publicItem.apt = item.apt;

  return publicItem;
};

// ──────────────────────────────────────────────
// Estructura de la carta
// ──────────────────────────────────────────────

// Secciones visibles con sus categorías, y las categorías sueltas. Solo entran
// las categorías ALCANZABLES, como hoy: las sueltas (sin sectionID) y las que
// cuelgan de una sección visible. Una categoría con sectionID de una sección
// oculta o inexistente (huérfana) no aparece. Los orígenes son leans, así que
// `section` puede faltar: cualquier cosa que no sea una sección es categoría.
const getReachableMenu = (menus) => {
  const docs = (menus ?? []).map(plain).filter((menu) => menu && menu.hidden !== true);
  const sections = docs.filter((menu) => menu.section === true);
  const sectionKeys = new Set(sections.map((section) => String(section._id)));

  const byOwner = new Map(); // String(sectionID) -> categorías de esa sección
  const loose = [];
  for (const category of docs) {
    if (category.section === true) continue;
    if (!category.sectionID) {
      loose.push(category);
      continue;
    }
    const key = String(category.sectionID);
    if (!sectionKeys.has(key)) continue; // huérfana
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(category);
  }

  return {
    sections: sections.map((section) => ({
      section,
      categories: byOwner.get(String(section._id)) ?? [],
    })),
    loose,
  };
};

// _id (tal cual, ObjectId) de las categorías alcanzables: es lo que el
// handler necesita ANTES de pedir los items, para no traer los de categorías
// que igual no se van a mostrar.
const getReachableCategoryIds = (menus) => {
  const { sections, loose } = getReachableMenu(menus);
  return [
    ...sections.flatMap(({ categories }) => categories.map((category) => category._id)),
    ...loose.map((category) => category._id),
  ];
};

// { secciones, sinSeccion } de la carta v2. `menus` son las secciones y
// categorías (lean o documentos) y `items` los productos ya traídos. Agrupa
// los items por categoría con un Map (una pasada) en vez de filtrar toda la
// lista por cada categoría, y poda lo vacío: categorías sin items tras
// filtrar, y secciones sin categorías.
// El orden es el de los arrays de entrada (el handler los pide con
// MENU_ORDER_SORT, el que eligió el dueño: ver utils/menuOrder.js), que es el
// que muestra la carta.
const buildPublicMenu = ({ menus, items, features = {}, hidePrices = false, now = new Date() }) => {
  const { sections, loose } = getReachableMenu(menus);

  const itemsByCategory = new Map();
  for (const item of items ?? []) {
    const key = String(item.menuID);
    const list = itemsByCategory.get(key);
    if (list) list.push(item);
    else itemsByCategory.set(key, [item]);
  }

  const itemOptions = { features, hidePrices, now };
  const buildCategory = (category) => {
    const publicItems = [];
    for (const raw of itemsByCategory.get(String(category._id)) ?? []) {
      const publicItem = toPublicItem(raw, itemOptions);
      if (publicItem) publicItems.push(publicItem);
    }
    return publicItems.length > 0 ? { title: category.title, items: publicItems } : null;
  };

  const secciones = [];
  for (const { section, categories } of sections) {
    const categorias = categories.map(buildCategory).filter(Boolean);
    if (categorias.length > 0) secciones.push({ title: section.title, categorias });
  }
  const sinSeccion = loose.map(buildCategory).filter(Boolean);

  return { secciones, sinSeccion };
};

// ──────────────────────────────────────────────
// Datos del local (bloque `user` de la respuesta)
// ──────────────────────────────────────────────

const PUBLIC_CONTACT_FIELDS = ["businessName", "number", "address", "orderMessage"];

// Whitelist de contactInfo para la carta: nombre, número y números de
// WhatsApp por sucursal (pedidos por WhatsApp), dirección y mensaje de
// pedido. Sin mail, redes, ubicación ni reservationMessage: la carta no los
// muestra. Las claves ausentes o vacías se omiten (number puede ser null,
// whatsappNumbers una lista vacía); el objeto siempre existe porque el front
// lee user.contactInfo.businessName sin optional chaining.
// Recibe el contactInfo ya pasado por getContactInfo (contrato vigente).
const toPublicContactInfo = (contactInfo) => {
  const source = contactInfo ?? {};
  const info = {};
  for (const field of PUBLIC_CONTACT_FIELDS) {
    const value = source[field];
    if (value !== undefined && value !== null && value !== "") info[field] = value;
  }
  if (Array.isArray(source.whatsappNumbers) && source.whatsappNumbers.length > 0) {
    info.whatsappNumbers = source.whatsappNumbers.map(({ name, number }) => ({ name: name || "", number }));
  }
  return info;
};

// Imágenes del local: la portada, el favicon y SOLO la primera foto
// (BusinessSEO usa pictures[0] para las metas). Lo vacío se omite; media
// siempre existe.
const toPublicMedia = (media) => {
  const source = media ?? {};
  const publicMedia = {};
  if (source.backgroundPicture) publicMedia.backgroundPicture = source.backgroundPicture;
  if (source.favicon) publicMedia.favicon = source.favicon;
  const [firstPicture] = Array.isArray(source.pictures) ? source.pictures : [];
  if (firstPicture) publicMedia.pictures = [firstPicture];
  return publicMedia;
};

// Las tres funciones del plan que usa la carta, siempre como booleanos
// explícitos: el front las compara con === true, así que un plan sin la
// clave tiene que llegar como false y no como ausente.
const toPublicFeatures = (features) => ({
  sin_publicidad: features?.sin_publicidad === true,
  landing_page: features?.landing_page === true,
  pedido_whatsapp: features?.pedido_whatsapp === true,
});

module.exports = {
  isItemAvailableNow,
  resolveOfferPrice,
  toPublicItem,
  getReachableCategoryIds,
  buildPublicMenu,
  toPublicContactInfo,
  toPublicMedia,
  toPublicFeatures,
};
