// Carta pública: pedidos de take away / delivery pagados con Mercado Pago.
// Sin sesión ni QR del local: son pedidos a distancia. La seguridad está en
// que precios, modalidades e importes los resuelve siempre el servidor.

const { route, OrdersError } = require("../errors");
const { findProOwnerBySlug } = require("../services/menuCatalog");
const settingsService = require("../services/settingsService");
const checkout = require("./checkoutService");

const loadOwner = async (slug) => {
  const owner = await findProOwnerBySlug(slug);
  if (!owner) throw new OrdersError(404, "Este local no recibe pedidos desde la carta.");
  return owner;
};

// ¿Puede el local cobrar online ahora? Nunca da error: sin la función, la
// carta sigue como hoy (pedido por WhatsApp).
const getOnlineOrdering = route(async (req, res) => {
  const owner = await findProOwnerBySlug(req.params.slug);
  if (!owner) return res.json({ enabled: false, modes: [] });
  const settings = await settingsService.findSettings(String(owner._id));
  res.json(await checkout.getOnlineConfig(owner, settings));
});

const createCheckout = route(async (req, res) => {
  const owner = await loadOwner(req.params.slug);
  const settings = await settingsService.findSettings(String(owner._id));
  if (!settings) throw new OrdersError(403, "Este local no recibe pedidos con pago online.", "ONLINE_ORDERING_OFF");
  res.status(201).json(await checkout.createCheckout({ owner, settings, body: req.body ?? {} }));
});

const getCheckoutStatus = route(async (req, res) => {
  const owner = await loadOwner(req.params.slug);
  const settings = await settingsService.findSettings(String(owner._id));
  res.json(await checkout.getCheckoutStatus({ owner, settings, ref: req.params.ref }));
});

module.exports = { getOnlineOrdering, createCheckout, getCheckoutStatus };
