// Carta pública: detectar si el comensal está en el local (QR) y recibir
// su pedido. Sin sesión: el token del QR es la prueba de estar en el local.

const { route, OrdersError } = require("../errors");
const { findProOwnerBySlug } = require("../services/menuCatalog");
const settingsService = require("../services/settingsService");
const orderService = require("../services/orderService");
const { hashToken, isTokenShape } = require("../utils/tokens");
const { parseOrderLines, optionalPositiveInt, optionalUuid } = require("../utils/validate");

// Respuesta de "no está en el local": la carta sigue como siempre (WhatsApp).
const OUTSIDE = { inVenue: false };

// Contexto del QR escaneado. Nunca da error por un token inválido o un local
// sin la función: devuelve inVenue false y la carta funciona como hoy.
const getContext = route(async (req, res) => {
  const token = req.query.t;
  if (!isTokenShape(token)) return res.json(OUTSIDE);
  const owner = await findProOwnerBySlug(req.params.slug);
  if (!owner) return res.json(OUTSIDE);
  const settings = await settingsService.findSettings(String(owner._id));
  const qr = await settingsService.resolveQrToken(settings, token);
  if (!qr) return res.json(OUTSIDE);

  res.json({
    inVenue: true,
    ordering: settings.customer_ordering,
    history: settings.customer_history,
    tableNumber: qr.kind === "table" ? qr.tableNumber : null,
    tableCount: settings.table_count,
  });
});

const createCustomerOrder = route(async (req, res) => {
  const body = req.body ?? {};
  if (!isTokenShape(body.token)) throw new OrdersError(403, "Para pedir desde la mesa, escaneá el QR del local.");

  const owner = await findProOwnerBySlug(req.params.slug);
  if (!owner) throw new OrdersError(404, "Este local no recibe pedidos desde la carta.");
  const settings = await settingsService.findSettings(String(owner._id));
  const qr = await settingsService.resolveQrToken(settings, body.token);
  if (!qr) throw new OrdersError(403, "El QR ya no es válido. Volvé a escanear el de tu mesa.", "QR_INVALID");
  if (!settings.customer_ordering) {
    throw new OrdersError(403, "En este local los pedidos se hacen con el mozo.", "CUSTOMER_ORDERING_OFF");
  }

  const tableNumber = qr.kind === "table"
    ? qr.tableNumber
    : optionalPositiveInt(body.tableNumber, { field: "Número de mesa", max: settings.table_count });
  if (!tableNumber) throw new OrdersError(400, "Indicá tu número de mesa.");

  // Id aleatorio que el navegador guarda en su localStorage: identifica al
  // dispositivo para limitar la frecuencia sin datos personales.
  const deviceId = typeof body.deviceId === "string" && body.deviceId.length <= 64 ? body.deviceId : req.ip;

  const { order, duplicate } = await orderService.createOrder({
    owner,
    settings,
    source: "customer",
    lines: parseOrderLines(body.items),
    tableNumber,
    clientRequestId: optionalUuid(body.clientRequestId),
    fingerprint: hashToken(`${owner._id}:${deviceId}`),
  });

  // Al comensal solo le devolvemos lo necesario para su historial local.
  res.status(duplicate ? 200 : 201).json({
    order: {
      number: order.number,
      tableNumber: order.tableNumber,
      total: order.total,
      createdAt: order.createdAt,
      items: order.items.map(({ title, option, quantity, notes, unitPrice }) => ({ title, option, quantity, notes, unitPrice })),
    },
    duplicate,
  });
});

module.exports = { getContext, createCustomerOrder };
