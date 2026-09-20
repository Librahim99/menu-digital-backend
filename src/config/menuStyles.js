// La familia de portada y carta es independiente de las paletas del plan.
// Conservamos los IDs anteriores; no se migran las cuentas existentes.
const MENU_STYLE_LABELS = {
  classic: "Clásico",
  bistro: "Bistró",
  coffee: "Cafetería",
  "fast-food": "Fast food",
  grill: "Parrilla / Restaurante",
  premium: "Bistró / Premium",
  bakery: "Pastelería / Bakery",
};
const MENU_STYLES = Object.keys(MENU_STYLE_LABELS);

// Los dos diseños originales quedan abiertos a todos los planes: ya había
// cuentas gratuitas usándolos antes de que existiera el gating, y quitárselos
// sería degradarles la carta. Todo lo que se sume de acá en adelante es
// familia y queda gateado solo, sin tocar esta lista.
const LEGACY_MENU_STYLES = ["classic", "bistro"];
const VISUAL_FAMILIES = MENU_STYLES.filter(style => !LEGACY_MENU_STYLES.includes(style));

const getMenuStyle = (value) => MENU_STYLES.includes(value) ? value : "classic";
const isVisualFamily = (value) => VISUAL_FAMILIES.includes(value);

// Espejo de getTemplateForFeatures (config/plans.js) para el diseño de carta:
// si el plan vigente no incluye las familias, la API responde Clásico. Es un
// recorte de LECTURA — el valor elegido sigue guardado en Mongo, así que al
// renovar la suscripción la carta recupera su familia sin volver a elegirla.
// El fallback es el literal "classic" y no un valor del plan porque el permiso
// es un booleano, no una lista de estilos permitidos como templateIds.
const getMenuStyleForFeatures = (value, features) => {
  const style = getMenuStyle(value);
  return isVisualFamily(style) && features.menu_styles !== true ? "classic" : style;
};

module.exports = {
  MENU_STYLES, MENU_STYLE_LABELS, LEGACY_MENU_STYLES, VISUAL_FAMILIES,
  getMenuStyle, isVisualFamily, getMenuStyleForFeatures,
};
