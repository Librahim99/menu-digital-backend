// Plantilla de página: la COMPOSICIÓN de la portada y la carta en escritorio.
// Tercer eje de la apariencia, independiente de los otros dos: template elige
// la paleta y menuStyle la familia (tipografía y formas). En el celular todas
// las plantillas se ven igual; ahí no hay lugar para otra composición.
//
// Catálogo único: sumar una es agregar UNA fila acá (y su gemela en el
// frontend, src/lib/pageLayouts.ts). `feature` es la clave del plan que la
// habilita:
//   null           → abierta a todos los planes. Solo "standard", que es como
//                    se veían todas las cuentas antes de que existiera el campo.
//   "page_layouts" → plantilla que se desbloquea por plan.
// El enum del modelo, la validación del PATCH y el recorte de lectura se
// derivan de esta tabla.
const PAGE_LAYOUT_CATALOG = {
  standard: { label: "Estándar", feature: null },
  immersive: { label: "Inmersiva", feature: "page_layouts" },
  split: { label: "Partida", feature: "page_layouts" },
};
const PAGE_LAYOUTS = Object.keys(PAGE_LAYOUT_CATALOG);
const PAGE_LAYOUT_LABELS = Object.fromEntries(PAGE_LAYOUTS.map(layout => [layout, PAGE_LAYOUT_CATALOG[layout].label]));

const getPageLayout = (value) => PAGE_LAYOUTS.includes(value) ? value : "standard";

// Feature del catálogo que habilita una plantilla; null = abierta a todos los
// planes (también para un valor desconocido, que getPageLayout resuelve a Estándar).
const getPageLayoutFeature = (value) =>
  (PAGE_LAYOUTS.includes(value) ? PAGE_LAYOUT_CATALOG[value].feature : null);

// Mismo criterio que getMenuStyleForFeatures (config/menuStyles.js): recorte
// de LECTURA. Si el plan vigente no incluye la plantilla la API responde
// Estándar, pero el valor elegido sigue guardado en Mongo y vuelve solo al
// renovar la suscripción.
const getPageLayoutForFeatures = (value, features) => {
  const layout = getPageLayout(value);
  const feature = getPageLayoutFeature(layout);
  return feature && features[feature] !== true ? "standard" : layout;
};

module.exports = {
  PAGE_LAYOUT_CATALOG, PAGE_LAYOUTS, PAGE_LAYOUT_LABELS,
  getPageLayout, getPageLayoutFeature, getPageLayoutForFeatures,
};
