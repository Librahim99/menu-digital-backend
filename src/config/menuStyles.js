// La familia de portada y carta es independiente de las paletas del plan.
// Conservamos los IDs anteriores; no se migran las cuentas existentes.
//
// Catálogo único de diseños: sumar uno es agregar UNA fila acá (y su gemela en
// el frontend, src/lib/menuStyles.ts). No hay tope de cantidad. `feature` es la
// clave del plan que lo habilita:
//   null                  → abierto a todos los planes. Solo los dos originales:
//                           ya había cuentas gratuitas usándolos antes de que
//                           existiera el gating, y quitárselos sería degradarles
//                           la carta. No sumar diseños nuevos con null.
//   "menu_styles"         → familia visual común.
//   "premium_menu_styles" → diseño premium: familia como las demás (los colores
//                           salen de la paleta), con feature propia para poder
//                           abrir las comunes en otro plan sin regalar estas.
// Todo lo demás (enum del modelo, validación del PATCH, recorte de lectura) se
// deriva de esta tabla.
const MENU_STYLE_CATALOG = {
  classic: { label: "Clásico", feature: null },
  bistro: { label: "Bistró", feature: null },
  coffee: { label: "Cafetería", feature: "menu_styles" },
  "fast-food": { label: "Fast food", feature: "menu_styles" },
  grill: { label: "Parrilla / Restaurante", feature: "menu_styles" },
  premium: { label: "Bistró / Premium", feature: "menu_styles" },
  bakery: { label: "Pastelería / Bakery", feature: "menu_styles" },
  "neo-brutalism": { label: "Neobrutalismo", feature: "premium_menu_styles" },
  tactile: { label: "Maximalismo táctil", feature: "premium_menu_styles" },
  "retro-diner": { label: "Retro diner", feature: "premium_menu_styles" },
  neon: { label: "Neón nocturno", feature: "premium_menu_styles" },
  swiss: { label: "Editorial suizo", feature: "premium_menu_styles" },
  "art-deco": { label: "Art déco", feature: "premium_menu_styles" },
};
const MENU_STYLES = Object.keys(MENU_STYLE_CATALOG);
const MENU_STYLE_LABELS = Object.fromEntries(MENU_STYLES.map(style => [style, MENU_STYLE_CATALOG[style].label]));
const stylesWith = (test) => MENU_STYLES.filter(style => test(MENU_STYLE_CATALOG[style].feature));

const LEGACY_MENU_STYLES = stylesWith(feature => feature === null);
const VISUAL_FAMILIES = stylesWith(feature => feature !== null);
// Espejo de PREMIUM_MENU_STYLES en el frontend (src/lib/menuStyles.ts).
const PREMIUM_MENU_STYLES = stylesWith(feature => feature === "premium_menu_styles");

const getMenuStyle = (value) => MENU_STYLES.includes(value) ? value : "classic";
const isVisualFamily = (value) => VISUAL_FAMILIES.includes(value);
const isPremiumMenuStyle = (value) => PREMIUM_MENU_STYLES.includes(value);

// Feature del catálogo que habilita un diseño; null = abierto a todos los planes
// (también para un valor desconocido, que getMenuStyle resuelve a Clásico).
const getMenuStyleFeature = (value) =>
  (MENU_STYLES.includes(value) ? MENU_STYLE_CATALOG[value].feature : null);

// Espejo de getTemplateForFeatures (config/plans.js) para el diseño de carta:
// si el plan vigente no incluye las familias, la API responde Clásico. Es un
// recorte de LECTURA — el valor elegido sigue guardado en Mongo, así que al
// renovar la suscripción la carta recupera su familia sin volver a elegirla.
// El fallback es el literal "classic" y no un valor del plan porque el permiso
// es un booleano, no una lista de estilos permitidos como templateIds.
const getMenuStyleForFeatures = (value, features) => {
  const style = getMenuStyle(value);
  const feature = getMenuStyleFeature(style);
  return feature && features[feature] !== true ? "classic" : style;
};

module.exports = {
  MENU_STYLE_CATALOG, MENU_STYLES, MENU_STYLE_LABELS, LEGACY_MENU_STYLES, VISUAL_FAMILIES, PREMIUM_MENU_STYLES,
  getMenuStyle, isVisualFamily, isPremiumMenuStyle, getMenuStyleFeature, getMenuStyleForFeatures,
};
