// ──────────────────────────────────────────────
// Tiempo real de Reservas por WebSocket (paquete `ws`), en /api/reservations/ws.
//
// Dos tipos de pantalla se conectan:
//   - el panel del local, que se identifica con su JWT  → {"type":"auth","token":"…"}
//   - el cliente, que se identifica con su código       → {"type":"watch","code":"ABCD-EFGH"}
//
// El servidor responde con {"type":"reservation","reservation":{…}} cada vez
// que cambia una reserva (y con una foto del estado actual al suscribirse).
// El estado vive en memoria del proceso: sirve para una sola instancia de la
// API; si se escalara a varias habría que sumar un bus (ej. Postgres
// LISTEN/NOTIFY). Los clientes igual reconsultan por HTTP al reconectar.
// ──────────────────────────────────────────────

const OPEN = 1;
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_WATCHED_CODES = 5;
const MAX_MESSAGES_PER_MINUTE = 40;
const MAX_PAYLOAD_BYTES = 4 * 1024;

const addTo = (map, key, socket) => {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(socket);
};

const removeFrom = (map, key, socket) => {
  const set = map.get(key);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) map.delete(key);
};

const safeSend = (socket, payload) => {
  if (socket.readyState !== undefined && socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Un socket roto no debe frenar el aviso a los demás.
  }
};

/**
 * Hub de salas en memoria. No conoce `ws` ni la base: recibe sockets con la
 * interfaz mínima (send / on / close) y dos resolvers, así se prueba sin red.
 *
 * @param {object} deps
 * @param {(token: string) => Promise<string|null>} deps.authorizeOwner  JWT → ownerId (o null)
 * @param {(code: string) => Promise<{ code: string, reservation: object }|null>} deps.authorizeCode
 */
const createHub = ({ authorizeOwner, authorizeCode }) => {
  const owners = new Map(); // ownerId → sockets
  const codes = new Map();  // código canónico → sockets
  const state = new WeakMap(); // socket → { ownerId, codes:Set, messages, windowStart }

  const cleanup = (socket) => {
    const info = state.get(socket);
    if (!info) return;
    if (info.ownerId) removeFrom(owners, info.ownerId, socket);
    for (const code of info.codes) removeFrom(codes, code, socket);
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
      const ownerId = await authorizeOwner(message.token).catch(() => null);
      if (!ownerId) {
        safeSend(socket, { type: "error", code: "AUTH", message: "Sesión inválida." });
        return socket.close?.(1008, "auth");
      }
      if (!state.has(socket)) return; // se cerró mientras validábamos
      if (info.ownerId && info.ownerId !== ownerId) removeFrom(owners, info.ownerId, socket);
      info.ownerId = ownerId;
      addTo(owners, ownerId, socket);
      return safeSend(socket, { type: "ready", role: "owner" });
    }

    if (message?.type === "watch" && typeof message.code === "string") {
      if (info.codes.size >= MAX_WATCHED_CODES && !info.codes.has(message.code)) {
        return safeSend(socket, { type: "error", message: "Demasiadas reservas en seguimiento." });
      }
      const found = await authorizeCode(message.code).catch(() => null);
      if (!found) return safeSend(socket, { type: "error", code: "NOT_FOUND", message: "Código inválido." });
      if (!state.has(socket)) return;
      info.codes.add(found.code);
      addTo(codes, found.code, socket);
      safeSend(socket, { type: "ready", role: "customer" });
      return safeSend(socket, { type: "reservation", reservation: found.reservation });
    }

    safeSend(socket, { type: "error", message: "Mensaje no soportado." });
  };

  const connect = (socket) => {
    state.set(socket, { ownerId: null, codes: new Set(), messages: 0, windowStart: Date.now() });

    // Si no se identifica a tiempo, se corta (evita sockets colgados anónimos).
    const timer = setTimeout(() => {
      const info = state.get(socket);
      if (info && !info.ownerId && info.codes.size === 0) socket.close?.(1008, "timeout");
    }, AUTH_TIMEOUT_MS);
    timer.unref?.();

    socket.on("message", (raw) => { handleMessage(socket, raw).catch(() => {}); });
    socket.on("close", () => { clearTimeout(timer); cleanup(socket); });
    socket.on("error", () => { clearTimeout(timer); cleanup(socket); });
  };

  const publish = (ownerId, code, ownerReservation, customerReservation) => {
    for (const socket of owners.get(String(ownerId)) ?? []) {
      safeSend(socket, { type: "reservation", reservation: ownerReservation });
    }
    for (const socket of codes.get(code) ?? []) {
      safeSend(socket, { type: "reservation", reservation: customerReservation });
    }
  };

  const stats = () => ({ owners: owners.size, codes: codes.size });

  return { connect, publish, stats };
};

// ── Cableado real (ws + base + JWT) ──────────

let hub = null;

const WS_PATH = "/api/reservations/ws";

const allowedOrigins = () => [
  "https://www.menudigitalapp.com.ar",
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean).map((origin) => origin.replace(/\/$/, ""));

const buildHub = () => createHub({
  authorizeOwner: async (token) => {
    const jwt = require("jsonwebtoken");
    const { findOwnerById, isProOwner } = require("../orders/services/menuCatalog");
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const owner = await findOwnerById(decoded.id);
    return owner && owner.active && isProOwner(owner) ? String(owner._id) : null;
  },
  authorizeCode: async (rawCode) => {
    const service = require("./services/reservationService");
    const row = await service.findByCode(rawCode);
    return row ? { code: row.code, reservation: service.toCustomerDTO(row) } : null;
  },
});

const getHub = () => {
  if (!hub) hub = buildHub();
  return hub;
};

// Llamado por el service en cada cambio de una reserva.
const publish = (ownerId, code, ownerReservation, customerReservation) => {
  if (!hub) return; // nadie se conectó todavía
  hub.publish(ownerId, code, ownerReservation, customerReservation);
};

/**
 * Engancha el WebSocket al servidor HTTP de la API. Solo atiende
 * WS_PATH; cualquier otro upgrade se rechaza.
 */
const attach = (server) => {
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const currentHub = getHub();

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname !== WS_PATH) return socket.destroy();

    const origin = request.headers.origin;
    if (origin && !allowedOrigins().includes(origin.replace(/\/$/, ""))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on("pong", () => { ws.isAlive = true; });
      currentHub.connect(ws);
    });
  });

  // Detrás de proxies/balanceadores las conexiones ociosas se cortan: el
  // ping periódico las mantiene vivas y descarta las muertas.
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

// Corta los upgrade a paths que ningún módulo atiende.
const closeUnknownUpgrades = (server, knownPaths) => {
  server.on("upgrade", (request, socket) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (!knownPaths.includes(pathname)) socket.destroy();
  });
};

module.exports = {
  createHub, attach, publish, WS_PATH, closeUnknownUpgrades, allowedOrigins, safeSend, addTo, removeFrom,
  HEARTBEAT_MS, AUTH_TIMEOUT_MS, MAX_MESSAGES_PER_MINUTE, MAX_PAYLOAD_BYTES,
};
