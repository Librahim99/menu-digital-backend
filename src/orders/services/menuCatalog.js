// ──────────────────────────────────────────────
// Puente de solo lectura con MongoDB.
//
// El módulo de pedidos nunca escribe en Mongo. Lee de ahí:
//   - el local (User) por slug o id, y su plan vigente (solo PRO usa pedidos);
//   - los productos (Item) para validar y cotizar cada línea del pedido.
// Los precios SIEMPRE salen de acá (con ofertas vigentes y variantes), nunca
// de lo que mande el navegador.
// ──────────────────────────────────────────────

const User = require("../../models/User");
const Menu = require("../../models/Menu");
const Item = require("../../models/Item");
const { getSubscriptionState } = require("../../config/plans");
const { getPlanForUser } = require("../../services/planCatalog");
const { generateSlug } = require("../../utils/slug");
const {
  getReachableCategoryIds, isItemAvailableNow, resolveOfferPrice,
} = require("../../utils/publicMenu");
const { OrdersError } = require("../errors");

const OWNER_SELECT = "slug active subscription subscriptionExpiresAt contactInfo.businessName";

const isProOwner = (user) =>
  getSubscriptionState(user.subscription, user.subscriptionExpiresAt).effectivePlan === "pro";

// Local público por slug, solo si está activo y con plan PRO vigente.
// null si no existe o no tiene la función.
const findProOwnerBySlug = async (slug) => {
  if (typeof slug !== "string" || slug.length > 120) return null;
  const user = await User.findOne({ slug: generateSlug(slug), active: true }).select(OWNER_SELECT);
  if (!user || !isProOwner(user)) return null;
  return user;
};

const findOwnerById = (ownerId) => User.findById(ownerId).select(OWNER_SELECT);

const businessNameOf = (user) => user?.contactInfo?.businessName || user?.slug || "";

const toPlainOptions = (options) => {
  if (options instanceof Map) return Object.fromEntries(options);
  return options && typeof options === "object" ? options : {};
};

const roundMoney = (value) => Math.round(value * 100) / 100;

/**
 * Valida las líneas contra el menú visible del local y les pone título y
 * precio del servidor. Rechaza productos de otro local, ocultos, pausados o
 * fuera de su horario, y variantes que no existen.
 *
 * @param {object} owner  documento User del local
 * @param {Array}  lines  salida de parseOrderLines
 * @returns {{ lines: Array, total: number }}
 */
const priceOrderLines = async (owner, lines) => {
  const [plan, menus] = await Promise.all([
    getPlanForUser(owner),
    Menu.find({ userID: owner._id, hidden: false }).select("_id section sectionID hidden").lean(),
  ]);
  const categoryIds = getReachableCategoryIds(menus);
  const itemIds = [...new Set(lines.map((line) => line.itemId))];
  const items = categoryIds.length === 0 ? [] : await Item.find({
    _id: { $in: itemIds },
    menuID: { $in: categoryIds },
    hidden: false,
  }).select("title price offerPrice offerRange offerSchedule options available availabilitySchedule hidden").lean();

  const byId = new Map(items.map((item) => [String(item._id), item]));
  const now = new Date();

  const priced = lines.map((line, position) => {
    const item = byId.get(line.itemId);
    if (!item) throw new OrdersError(400, "Uno de los productos ya no está en el menú. Actualizá la carta e intentá de nuevo.");
    if (!isItemAvailableNow(item, plan.features, now)) {
      throw new OrdersError(400, `"${item.title}" no está disponible en este momento.`);
    }

    const options = toPlainOptions(item.options);
    let unitPrice;
    if (line.option) {
      if (!Object.prototype.hasOwnProperty.call(options, line.option)) {
        throw new OrdersError(400, `La variante "${line.option}" de "${item.title}" ya no existe.`);
      }
      unitPrice = Number(options[line.option]) || 0;
    } else {
      if (Object.keys(options).length > 0 && item.price == null) {
        throw new OrdersError(400, `Elegí una variante de "${item.title}".`);
      }
      unitPrice = resolveOfferPrice(item, plan.features, now) ?? item.price ?? 0;
    }

    return {
      itemId: line.itemId,
      title: item.title,
      option: line.option,
      unitPrice: roundMoney(unitPrice),
      quantity: line.quantity,
      notes: line.notes,
      position,
    };
  });

  const total = roundMoney(priced.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0));
  return { lines: priced, total };
};

module.exports = {
  isProOwner,
  findProOwnerBySlug,
  findOwnerById,
  businessNameOf,
  priceOrderLines,
};
