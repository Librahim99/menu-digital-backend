const OwnerPushToken = require("../models/OwnerPushToken");
const { getMessaging, isDeadToken } = require("./adminPushService");

// ──────────────────────────────────────────────
// Avisos push (Firebase Cloud Messaging) al dueño de un local: pedido nuevo,
// mesa abierta, reserva nueva. Usan la misma app de Firebase que las push del
// admin; sin FIREBASE_SERVICE_ACCOUNT no se manda nada y todo sigue andando
// (el panel abierto avisa igual por WebSocket, con sonido).
//
// Nunca lanza: un aviso que falla no puede deshacer el pedido o la reserva.
// ──────────────────────────────────────────────

const MULTICAST_LIMIT = 500;

/**
 * Manda la push a todos los dispositivos del dueño.
 * @param {string} ownerId
 * @param {{ title: string, body?: string, url?: string, tag?: string }} alert
 *   `tag` agrupa avisos en el dispositivo (el de la misma mesa reemplaza al anterior).
 * @returns {Promise<{ enabled: boolean, devices: number, delivered: number, failed: number, removed: number, error: string|null }>}
 */
const notifyOwner = async (ownerId, { title, body = "", url = "/pedidos", tag = "" }) => {
  const summary = { enabled: false, devices: 0, delivered: 0, failed: 0, removed: 0, error: null };
  try {
    const fcm = getMessaging();
    summary.enabled = Boolean(fcm);
    if (!fcm || !ownerId) return summary;

    const tokens = await OwnerPushToken.find({ userID: ownerId }).distinct("token");
    summary.devices = tokens.length;
    if (tokens.length === 0) return summary;

    const deadTokens = [];
    for (let i = 0; i < tokens.length; i += MULTICAST_LIMIT) {
      const batch = tokens.slice(i, i + MULTICAST_LIMIT);
      // Data-only, igual que las del admin: el service worker arma la
      // notificación. `scope: "owner"` le dice qué panel abrir al tocarla.
      const response = await fcm.sendEachForMulticast({
        tokens: batch,
        data: { title, body, url, tag, scope: "owner" },
        webpush: { headers: { Urgency: "high", TTL: "600" } },
      });
      response.responses.forEach((sent, index) => {
        if (sent.success) {
          summary.delivered += 1;
          return;
        }
        summary.failed += 1;
        if (isDeadToken(sent.error)) deadTokens.push(batch[index]);
        else console.error(`Push a un local falló (${sent.error?.code || "sin código"}): ${sent.error?.message || ""}`);
      });
    }

    if (deadTokens.length > 0) {
      await OwnerPushToken.deleteMany({ token: { $in: deadTokens } });
      summary.removed = deadTokens.length;
    }
  } catch (error) {
    console.error("No se pudo enviar el aviso push al local:", error);
    summary.error = error.message || "error desconocido";
  }
  return summary;
};

/** Igual que notifyOwner, sin esperar: para llamar después de un COMMIT. */
const notifyOwnerLater = (ownerId, alert) => {
  if (!alert) return;
  notifyOwner(ownerId, alert).catch(() => {});
};

// Mismos nombres que el panel (SERVICE_LABEL en el frontend).
const SERVICE_LABEL = { counter: "Barra", takeaway: "Take away", delivery: "Delivery" };

const money = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return `$${amount.toLocaleString("es-AR", { maximumFractionDigits: 2 })}`;
};

const itemsLabel = (items) => {
  const count = (items ?? []).reduce((total, item) => total + (Number(item.quantity) || 0), 0);
  if (!count) return null;
  return count === 1 ? "1 producto" : `${count} productos`;
};

/**
 * Aviso de un pedido recién creado, o null si no amerita avisar. Lo usan la
 * push y el WebSocket del panel (mismo texto en los dos). No lleva datos del
 * cliente: solo mesa / tipo, número, cantidad y total.
 *
 * - Pedido del comensal (queda sin confirmar): avisa siempre.
 * - Pedido que abre una mesa (de un operador o del comensal): avisa la mesa.
 * - Pedido cargado desde el panel: no avisa (lo cargó el propio local).
 *
 * @param {object} order       DTO del pedido
 * @param {{ tableOpened?: boolean }} options
 */
const orderAlert = (order, { tableOpened = false } = {}) => {
  if (!order || order.source === "panel") return null;
  const fromCustomer = order.source === "customer";
  const opensTable = tableOpened && order.tableNumber;
  if (!fromCustomer && !opensTable) return null;

  const where = order.tableNumber ? `Mesa ${order.tableNumber}` : SERVICE_LABEL[order.serviceType] ?? "Pedido";
  const details = [itemsLabel(order.items), money(order.total)].filter(Boolean).join(" · ");

  if (opensTable) {
    const who = fromCustomer ? `Pedido #${order.number} por confirmar` : `Pedido #${order.number}${order.waiterName ? ` de ${order.waiterName}` : ""}`;
    return {
      kind: "table",
      key: `table:${order.tableSessionId ?? order.tableNumber}`,
      title: `🍽️ ${where} abierta`,
      body: [who, details].filter(Boolean).join(" · "),
      url: fromCustomer ? "/pedidos" : "/pedidos/mesas",
      tag: `table-${order.tableNumber}`,
      orderId: order.id,
    };
  }
  return {
    kind: "order",
    key: `order:${order.id}`,
    title: `🛎️ Nuevo pedido #${order.number}`,
    body: [where, details].filter(Boolean).join(" · "),
    url: "/pedidos",
    tag: `order-${order.id}`,
    orderId: order.id,
  };
};

const formatDate = (date) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return match ? `${match[3]}/${match[2]}` : "";
};

/** Aviso de una reserva pedida desde la web (DTO del dueño). */
const reservationAlert = (reservation) => {
  if (!reservation || reservation.source !== "web" || reservation.status !== "pending") return null;
  const people = Number(reservation.partySize) === 1 ? "1 persona" : `${reservation.partySize} personas`;
  const when = [formatDate(reservation.date), String(reservation.time ?? "").slice(0, 5)].filter(Boolean).join(" ");
  return {
    kind: "reservation",
    key: `reservation:${reservation.id}`,
    title: "📅 Nueva reserva",
    body: [reservation.name, people, when].filter(Boolean).join(" · "),
    url: "/reservas",
    tag: `reservation-${reservation.id}`,
  };
};

module.exports = { notifyOwner, notifyOwnerLater, orderAlert, reservationAlert };
