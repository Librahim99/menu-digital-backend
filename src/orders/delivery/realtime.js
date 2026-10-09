// ──────────────────────────────────────────────
// Tiempo real de pedidos y Delivery por WebSocket (paquete `ws`), en
// /api/orders/ws. Mismo patrón que Reservas (src/reservations/realtime.js): el
// servidor HTTP es compartido y cada módulo atiende su propio path.
//
// Tres tipos de pantalla se conectan y se identifican con su primer mensaje:
//   - el panel del local        {"type":"auth","token":"<JWT>"}
//   - el repartidor             {"type":"auth","role":"courier","token":"<token del dispositivo>"}
//   - el cliente (seguimiento)  {"type":"watch","slug":"mi-local","ref":"<referencia del pago>"}
//
// Los mensajes son AVISOS, no datos: {"type":"delivery","event":"picked_up",
// "orderId":12}. La pantalla que los recibe vuelve a pedir el estado por HTTP,
// que sigue siendo la fuente de verdad (y por eso no viaja ningún dato personal
// por el socket). Se emiten recién cuando la transacción de la base se confirmó.
//
// Quién recibe qué:
//   - panel del local: todos los avisos de sus pedidos y repartidores
//   - repartidor: solo avisos de las entregas que son suyas, más "open_changed"
//     (cambió la lista de pedidos disponibles) y "courier_updated" (su acceso)
//   - cliente: solo avisos del pedido cuya referencia presentó
// El estado vive en memoria del proceso (una sola instancia de la API); al
// reconectar, cada pantalla reconsulta por HTTP.
// ──────────────────────────────────────────────

const {
  allowedOrigins, safeSend, addTo, removeFrom, HEARTBEAT_MS, AUTH_TIMEOUT_MS, MAX_MESSAGES_PER_MINUTE, MAX_PAYLOAD_BYTES,
} = require("../../reservations/realtime");

const WS_PATH = "/api/orders/ws";

/**
 * Hub de salas en memoria. No conoce `ws` ni la base: recibe sockets con la
 * interfaz mínima (send / on / close) y resolvers, así se prueba sin red.
 *
 * @param {object} deps
 * @param {(token: string) => Promise<string|null>} deps.authorizeOwner      JWT → ownerId
 * @param {(token: string) => Promise<{ownerId: string, courierId: number}|null>} deps.authorizeCourier
 * @param {(slug: string, ref: string) => Promise<{ownerId: string}|null>} deps.authorizeCustomer
 */
const createHub = ({ authorizeOwner, authorizeCourier, authorizeCustomer }) => {
  const owners = new Map();           // ownerId → sockets del panel
  const couriersByOwner = new Map();  // ownerId → sockets de repartidores
  const couriersById = new Map();     // `${ownerId}:${courierId}` → sockets
  const customers = new Map();        // `${ownerId}:${ref}` → sockets
  const state = new WeakMap();

  const cleanup = (socket) => {
    const info = state.get(socket);
    if (!info) return;
    if (info.ownerId) removeFrom(owners, info.ownerId, socket);
    if (info.courier) {
      removeFrom(couriersByOwner, info.courier.ownerId, socket);
      removeFrom(couriersById, `${info.courier.ownerId}:${info.courier.courierId}`, socket);
    }
    for (const key of info.watching) removeFrom(customers, key, socket);
    state.delete(socket);
  };

  const rateLimited = (info) => {
    const now = Date.now();
    if (now - info.windowStart > 60_000) {
      info.windowStart = now;
      info.messages = 0;
    }
    info.messages += 1;
    return info.messages > MAX_MESSAGES_PER_MINUTE;
  };

  const handleMessage = async (socket, raw) => {
    const info = state.get(socket);
    if (!info) return;
    if (rateLimited(info)) return socket.close?.(1008, "rate limit");

    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return safeSend(socket, { type: "error", message: "Mensaje inválido." });
    }

    if (message?.type === "auth" && typeof message.token === "string") {
      if (message.role === "courier") {
        const found = await authorizeCourier(message.token).catch(() => null);
        if (!found) {
          safeSend(socket, { type: "error", code: "AUTH", message: "Sesión inválida." });
          return socket.close?.(1008, "auth");
        }
        if (!state.has(socket)) return;
        info.courier = found;
        addTo(couriersByOwner, found.ownerId, socket);
        addTo(couriersById, `${found.ownerId}:${found.courierId}`, socket);
        return safeSend(socket, { type: "ready", role: "courier" });
      }
      const ownerId = await authorizeOwner(message.token).catch(() => null);
      if (!ownerId) {
        safeSend(socket, { type: "error", code: "AUTH", message: "Sesión inválida." });
        return socket.close?.(1008, "auth");
      }
      if (!state.has(socket)) return;
      if (info.ownerId && info.ownerId !== ownerId) removeFrom(owners, info.ownerId, socket);
      info.ownerId = ownerId;
      addTo(owners, ownerId, socket);
      return safeSend(socket, { type: "ready", role: "owner" });
    }

    if (message?.type === "watch" && typeof message.slug === "string" && typeof message.ref === "string") {
      if (info.watching.size >= 3) return safeSend(socket, { type: "error", message: "Demasiados pedidos en seguimiento." });
      const found = await authorizeCustomer(message.slug, message.ref).catch(() => null);
      if (!found) return safeSend(socket, { type: "error", code: "NOT_FOUND", message: "Pedido no encontrado." });
      if (!state.has(socket)) return;
      const key = `${found.ownerId}:${message.ref}`;
      info.watching.add(key);
      addTo(customers, key, socket);
      return safeSend(socket, { type: "ready", role: "customer" });
    }

    safeSend(socket, { type: "error", message: "Mensaje no soportado." });
  };

  const connect = (socket) => {
    state.set(socket, { ownerId: null, courier: null, watching: new Set(), messages: 0, windowStart: Date.now() });

    // Si no se identifica a tiempo, se corta (evita sockets colgados anónimos).
    const timer = setTimeout(() => {
      const info = state.get(socket);
      if (info && !info.ownerId && !info.courier && info.watching.size === 0) socket.close?.(1008, "timeout");
    }, AUTH_TIMEOUT_MS);
    timer.unref?.();

    socket.on("message", (raw) => { handleMessage(socket, raw).catch(() => {}); });
    socket.on("close", () => { clearTimeout(timer); cleanup(socket); });
    socket.on("error", () => { clearTimeout(timer); cleanup(socket); });
  };

  const send = (sockets, payload) => { for (const socket of sockets ?? []) safeSend(socket, payload); };

  const toOwner = (ownerId, payload) => send(owners.get(String(ownerId)), payload);
  const toAllCouriers = (ownerId, payload) => send(couriersByOwner.get(String(ownerId)), payload);
  const toCourier = (ownerId, courierId, payload) => send(couriersById.get(`${ownerId}:${courierId}`), payload);
  const toCustomer = (ownerId, ref, payload) => send(customers.get(`${ownerId}:${ref}`), payload);
  // ¿Hay clientes mirando algún pedido de este local? (evita consultar la base de más)
  const hasCustomers = (ownerId) => {
    const prefix = `${ownerId}:`;
    for (const key of customers.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };
  const stats = () => ({
    owners: owners.size, couriers: couriersById.size, customers: customers.size,
  });

  return { connect, toOwner, toAllCouriers, toCourier, toCustomer, hasCustomers, stats };
};

// ── Cableado real (ws + base + JWT) ──────────

let hub = null;

const buildHub = () => createHub({
  authorizeOwner: async (token) => {
    const jwt = require("jsonwebtoken");
    const { findOwnerById, isProOwner } = require("../services/menuCatalog");
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const owner = await findOwnerById(decoded.id);
    return owner && owner.active && isProOwner(owner) ? String(owner._id) : null;
  },
  authorizeCourier: async (token) => {
    const { authenticateSession } = require("./courierService");
    const { findOwnerById, isProOwner } = require("../services/menuCatalog");
    const session = await authenticateSession(token);
    if (!session) return null;
    const owner = await findOwnerById(session.ownerId);
    return owner && owner.active && isProOwner(owner) ? { ownerId: session.ownerId, courierId: session.courierId } : null;
  },
  authorizeCustomer: async (slug, ref) => {
    if (!/^[a-f0-9]{48}$/.test(ref)) return null;
    const { findProOwnerBySlug } = require("../services/menuCatalog");
    const { query } = require("../db/sql");
    const owner = await findProOwnerBySlug(slug);
    if (!owner) return null;
    const { rows } = await query(
      "SELECT 1 FROM order_online_payments WHERE owner_id = $1 AND external_reference = $2",
      [String(owner._id), ref]
    );
    return rows[0] ? { ownerId: String(owner._id) } : null;
  },
});

const getHub = () => {
  if (!hub) hub = buildHub();
  return hub;
};

/**
 * Avisa de un cambio en un pedido de delivery. Llamar SIEMPRE después del COMMIT.
 * Nunca tira ni demora al caller: un fallo de tiempo real no deshace la operación.
 *
 * @param {object} event
 * @param {string} event.ownerId
 * @param {string} event.event     assigned · reassigned · unassigned · picked_up · delivered ·
 *                                 order_status · open_changed · courier_updated · settings
 * @param {number} [event.orderId]
 * @param {number} [event.orderNumber]
 * @param {number[]} [event.courierIds]  repartidores a los que les interesa (ej. el anterior y el nuevo)
 * @param {boolean} [event.openList]     cambió la lista de pedidos disponibles
 * @param {boolean} [event.customer]     el cliente del pedido también tiene que enterarse
 */
const emit = ({ ownerId, event, orderId = null, orderNumber = null, courierIds = [], openList = false, customer = false }) => {
  if (!hub || !ownerId) return;
  try {
    const owner = String(ownerId);
    const payload = { type: "delivery", event, orderId, orderNumber };
    hub.toOwner(owner, payload);
    for (const courierId of new Set(courierIds.filter((id) => id != null))) hub.toCourier(owner, courierId, payload);
    if (openList) hub.toAllCouriers(owner, { type: "delivery", event: "open_changed", orderId: null, orderNumber: null });
    if (customer && orderId && hub.hasCustomers(owner)) notifyCustomer(owner, orderId, event);
  } catch {
    // El aviso es un complemento: el estado ya quedó guardado.
  }
};

const notifyCustomer = (ownerId, orderId, event) => {
  const { query } = require("../db/sql");
  query("SELECT external_reference FROM order_online_payments WHERE owner_id = $1 AND order_id = $2", [ownerId, orderId])
    .then(({ rows }) => {
      for (const row of rows) hub?.toCustomer(ownerId, row.external_reference, { type: "order", event });
    })
    .catch(() => {});
};

const allowed = (origin) => !origin || allowedOrigins().includes(origin.replace(/\/$/, ""));

/** Engancha el WebSocket al servidor HTTP de la API (solo atiende WS_PATH). */
const attach = (server) => {
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const currentHub = getHub();

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname !== WS_PATH) return;
    if (!allowed(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on("pong", () => { ws.isAlive = true; });
      currentHub.connect(ws);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* se limpia en el próximo ciclo */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
};

// Solo para tests: instala un hub ya armado.
const setHubForTests = (value) => { hub = value; };

module.exports = { createHub, attach, emit, WS_PATH, setHubForTests };
