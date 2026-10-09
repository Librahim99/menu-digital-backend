// Checkout público de pedidos de take away / delivery con Mercado Pago.
//
// El dinero va a la cuenta del local (token OAuth del local): la plataforma no
// cobra comisión. El pedido NO se crea en `orders` hasta que el pago esté
// aprobado (lo hace el webhook): hasta entonces el carrito ya cotizado vive en
// order_online_payments.draft, y no aparece en el tablero ni en la caja.

const crypto = require("crypto");
const { query } = require("../db/sql");
const { OrdersError } = require("../errors");
const { priceOrderLines } = require("../services/menuCatalog");
const settingsService = require("../services/settingsService");
const { parseOrderLines, parseService, cleanText, optionalUuid } = require("../utils/validate");
const { LIMITS } = require("../constants");
const { getConfig, missingForCheckout } = require("./config");
const connections = require("./connectionService");
const mpApi = require("./mpApi");

// Tiempo que el cliente tiene para pagar el checkout.
const CHECKOUT_TTL_MS = 30 * 60 * 1000;
const ONLINE_SERVICE_TYPES = ["takeaway", "delivery"];
const REF_RE = /^[0-9a-f]{48}$/;

// Qué modalidades acepta el local pagando online (null si no corresponde).
const onlineModesOf = (owner, settings) => {
  const options = settingsService.optionsOf(settings);
  if (!options.onlineOrdering) return [];
  const modes = [];
  if (owner.hasTakeAway) modes.push("takeaway");
  if (owner.hasDelivery) modes.push("delivery");
  return modes;
};

// Para la carta pública: ¿puede este local cobrar online ahora?
// hideWhatsapp solo es true si el pago online está funcionando: si no, el cliente
// se quedaría sin ninguna forma de pedir.
const OFF = Object.freeze({ enabled: false, modes: [], hideWhatsapp: false });

const getOnlineConfig = async (owner, settings) => {
  const modes = settings ? onlineModesOf(owner, settings) : [];
  if (modes.length === 0 || missingForCheckout().length > 0) return OFF;
  const status = await connections.getStatus(String(owner._id));
  if (!status.connected) return OFF;
  return { enabled: true, modes, hideWhatsapp: settingsService.optionsOf(settings).hideWhatsappOrder === true };
};

const requireCustomerData = (serviceType, customer) => {
  if (!customer.name) throw new OrdersError(400, "Indicá tu nombre.");
  if (!customer.phone) throw new OrdersError(400, "Indicá un teléfono de contacto.");
  if (serviceType === "delivery" && !customer.address) throw new OrdersError(400, "Indicá la dirección de entrega.");
};

const lineTitle = (line) => (line.option ? `${line.title} (${line.option})` : line.title).slice(0, 250);

const buildPreferenceBody = ({ ref, draft, owner, businessName, expiresAt }) => {
  const { frontendUrl, webhookUrl } = getConfig();
  // El carrito vive en la carta (/:slug/menu): ahí se muestra el resultado.
  const back = `${frontendUrl}/${encodeURIComponent(owner.slug)}/menu?pago=${ref}`;
  return {
    items: draft.lines.map((line) => ({
      id: line.itemId,
      title: lineTitle(line),
      quantity: line.quantity,
      unit_price: line.unitPrice,
      currency_id: "ARS",
    })),
    external_reference: ref,
    notification_url: webhookUrl,
    back_urls: { success: back, pending: back, failure: back },
    auto_return: "approved",
    expires: true,
    expiration_date_to: expiresAt.toISOString(),
    statement_descriptor: (businessName || "Menu Digital").replace(/[^\w ]/g, "").slice(0, 22) || "Menu Digital",
  };
};

const toCheckoutDTO = (row) => ({
  ref: row.external_reference,
  status: row.status,
  checkoutUrl: row.status === "PENDING" ? row.checkout_url : null,
  total: Number(row.amount),
  expiresAt: row.expires_at,
});

/**
 * Crea (o recupera, si es un reintento) el checkout de un pedido.
 * Precios e importes los calcula SIEMPRE el servidor.
 */
const createCheckout = async ({ owner, settings, body = {} }) => {
  const modes = onlineModesOf(owner, settings);
  if (modes.length === 0) {
    throw new OrdersError(403, "Este local no recibe pedidos con pago online.", "ONLINE_ORDERING_OFF");
  }
  if (missingForCheckout().length > 0) {
    console.error(`[orders/payments] Falta configurar: ${missingForCheckout().join(", ")}`);
    throw new OrdersError(503, "El pago online no está disponible en este momento.", "MP_NOT_CONFIGURED");
  }

  const { serviceType, customer } = parseService(body, { tableCount: 0, allowed: ONLINE_SERVICE_TYPES });
  if (!modes.includes(serviceType)) {
    throw new OrdersError(400, "Este local no ofrece esa modalidad con pago online.", "SERVICE_NOT_OFFERED");
  }
  requireCustomerData(serviceType, customer);
  const notes = cleanText(body.notes, LIMITS.orderNotesLength);
  const clientRequestId = optionalUuid(body.clientRequestId) ?? crypto.randomUUID();
  const ownerId = String(owner._id);

  // Reintento del mismo envío (doble clic): se devuelve el mismo checkout.
  const existing = await query(
    "SELECT * FROM order_online_payments WHERE owner_id = $1 AND client_request_id = $2",
    [ownerId, clientRequestId],
  );
  if (existing.rows[0]) return toCheckoutDTO(existing.rows[0]);

  const priced = await priceOrderLines(owner, parseOrderLines(body.items));
  if (!(priced.total > 0)) throw new OrdersError(400, "El pedido no tiene un importe a pagar.");
  const draft = { serviceType, customer, notes, lines: priced.lines, total: priced.total };

  // Token del local (renueva si hace falta). Falla con 409 si no está conectado.
  const seller = await connections.getAccessToken(ownerId);

  const ref = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);

  // Se registra ANTES de crear la preferencia: si el webhook llegara primero,
  // ya encuentra a qué local y a qué carrito corresponde el pago.
  let row;
  try {
    ({ rows: [row] } = await query(
      `INSERT INTO order_online_payments
         (owner_id, connection_id, client_request_id, draft, external_reference, amount, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`,
      [ownerId, seller.connectionId, clientRequestId, JSON.stringify(draft), ref, priced.total, expiresAt],
    ));
  } catch (error) {
    // Dos envíos simultáneos del mismo clientRequestId.
    if (error?.code === "23505") {
      const again = await query(
        "SELECT * FROM order_online_payments WHERE owner_id = $1 AND client_request_id = $2",
        [ownerId, clientRequestId],
      );
      if (again.rows[0]) return toCheckoutDTO(again.rows[0]);
    }
    throw error;
  }

  try {
    const businessName = owner.contactInfo?.businessName || owner.slug;
    const preference = await mpApi.createPreference(
      seller.accessToken,
      buildPreferenceBody({ ref, draft, owner, businessName, expiresAt }),
      `order-checkout-${row.id}`,
    );
    const checkoutUrl = seller.liveMode ? preference.initPoint : (preference.sandboxInitPoint || preference.initPoint);
    const updated = await query(
      `UPDATE order_online_payments SET preference_id = $2, checkout_url = $3, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [row.id, preference.id, checkoutUrl],
    );
    return toCheckoutDTO(updated.rows[0]);
  } catch (error) {
    // No se pudo armar el checkout: este intento queda cerrado (sin pedido).
    await query(
      `UPDATE order_online_payments
          SET status = 'REJECTED', mp_status_detail = 'preference_error', updated_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [row.id],
    ).catch(() => {});
    if (error instanceof OrdersError) throw error;
    console.error("[orders/payments] No se pudo crear la preferencia:", error?.message);
    throw new OrdersError(502, "No pudimos iniciar el pago con Mercado Pago. Intentá de nuevo.", "MP_CHECKOUT_FAILED");
  }
};

/**
 * Estado de un checkout para la pantalla de retorno del cliente. La clave es
 * la referencia (48 hex aleatorios) y solo se resuelve dentro del local del
 * slug: no se puede consultar el checkout de otro negocio.
 */
const getCheckoutStatus = async ({ owner, ref }) => {
  if (typeof ref !== "string" || !REF_RE.test(ref)) throw new OrdersError(404, "Pago no encontrado.");
  const { rows } = await query(
    `SELECT p.*, o.number AS order_number, o.status AS order_status
       FROM order_online_payments p LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.owner_id = $1 AND p.external_reference = $2`,
    [String(owner._id), ref],
  );
  const row = rows[0];
  if (!row) throw new OrdersError(404, "Pago no encontrado.");
  return {
    status: row.status,
    expired: row.status === "PENDING" && new Date(row.expires_at).getTime() < Date.now(),
    total: Number(row.amount),
    serviceType: row.draft?.serviceType ?? null,
    orderNumber: row.order_number ?? null,
    orderStatus: row.order_status ?? null,
  };
};

module.exports = { onlineModesOf, getOnlineConfig, createCheckout, getCheckoutStatus };
