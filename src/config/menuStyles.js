// El diseño de la carta es independiente de las paletas habilitadas por plan.
const MENU_STYLES = ["classic", "bistro"];
const getMenuStyle = (value) => MENU_STYLES.includes(value) ? value : "classic";

module.exports = { MENU_STYLES, getMenuStyle };
