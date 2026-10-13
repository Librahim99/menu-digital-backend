// Puente de solo lectura con la carta del local (MongoDB): los juegos usan
// productos reales, con las mismas reglas de visibilidad, disponibilidad y
// precio que la carta pública (utils/publicMenu.js). Nunca escriben acá.

const User = require("../models/User");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const { getSubscriptionState } = require("../config/plans");
const { getPlanForUser } = require("../services/planCatalog");
const { generateSlug } = require("../utils/slug");
const { MENU_ORDER_SORT } = require("../utils/menuOrder");
const { getReachableCategoryIds, isItemAvailableNow, resolveOfferPrice } = require("../utils/publicMenu");

const OWNER_SELECT = "slug active subscription subscriptionExpiresAt menuDisplay";

// Los juegos son parte del plan Pro (mismo criterio que Pedidos y Reservas).
// Es el único lugar donde se decide: cambiar de plan es cambiar esta función.
const hasGames = (user) =>
  getSubscriptionState(user.subscription, user.subscriptionExpiresAt).effectivePlan === "pro";

// Local público por slug, solo si está activo y tiene juegos. null si no.
const findVenueBySlug = async (slug) => {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 120) return null;
  const user = await User.findOne({ slug: generateSlug(slug), active: true }).select(OWNER_SELECT);
  return user && hasGames(user) ? user : null;
};

const hidesPrices = (user) => user?.menuDisplay?.hidePrices === true;

const plainOptions = (options) => {
  if (options instanceof Map) return Object.fromEntries(options);
  return options != null && typeof options === "object" ? options : {};
};

/**
 * Categorías y productos visibles de la carta del local, en el orden de la
 * carta. Cada producto dice si se puede pedir ahora y su precio vigente (con
 * oferta); null si solo tiene variantes.
 * @returns {{ categories: Array<{id, title}>, products: Array<{id, title, categoryId, categoryTitle,
 *            price, hasOptions, description, available}> }}
 */
const loadCatalog = async (user, now = new Date()) => {
  const [plan, menus] = await Promise.all([
    getPlanForUser(user),
    Menu.find({ userID: user._id, hidden: false }).select("title section sectionID").sort(MENU_ORDER_SORT).lean(),
  ]);
  const categoryIds = getReachableCategoryIds(menus);
  const items = categoryIds.length === 0 ? [] : await Item.find({ menuID: { $in: categoryIds }, hidden: false })
    .select("menuID title description price offerPrice offerRange offerSchedule options available availabilitySchedule")
    .sort(MENU_ORDER_SORT)
    .lean();

  const titleOf = new Map(menus.map((menu) => [String(menu._id), menu.title]));
  const position = new Map(categoryIds.map((id, index) => [String(id), index]));
  const products = items
    .map((item) => ({
      id: String(item._id),
      title: item.title,
      categoryId: String(item.menuID),
      categoryTitle: titleOf.get(String(item.menuID)) ?? "",
      price: resolveOfferPrice(item, plan.features, now) ?? item.price ?? null,
      hasOptions: Object.keys(plainOptions(item.options)).length > 0,
      description: item.description ?? "",
      available: isItemAvailableNow(item, plan.features, now),
    }))
    .sort((a, b) => position.get(a.categoryId) - position.get(b.categoryId));

  return {
    categories: categoryIds.map((id) => ({ id: String(id), title: titleOf.get(String(id)) ?? "" })),
    products,
  };
};

/**
 * Productos que participan de un juego: los que se pueden pedir ahora, de las
 * categorías elegidas (vacío = todas), menos los excluidos uno por uno.
 * @param {{ categoryIds: string[], excludedItemIds: string[] }} pool
 */
const filterPool = (products, pool) => {
  const categories = new Set(pool?.categoryIds ?? []);
  const excluded = new Set(pool?.excludedItemIds ?? []);
  return products.filter((product) =>
    product.available
    && (categories.size === 0 || categories.has(product.categoryId))
    && !excluded.has(product.id));
};

module.exports = { hasGames, findVenueBySlug, hidesPrices, loadCatalog, filterPool };
