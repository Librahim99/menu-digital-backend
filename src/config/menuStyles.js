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
const getMenuStyle = (value) => MENU_STYLES.includes(value) ? value : "classic";

module.exports = { MENU_STYLES, MENU_STYLE_LABELS, getMenuStyle };
