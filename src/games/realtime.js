// ──────────────────────────────────────────────
// Tiempo real del Duelo de la carta por WebSocket (paquete `ws`), en
// /api/games/ws. Mismo patrón que Reservas y Pedidos: el servidor HTTP es
// compartido y cada módulo atiende su propio path.
//
// El celular de cada jugador abre un socket y manda:
//   {"type":"create","slug":"mi-local","name":"Ana"}                 crea una sala
//   {"type":"join","slug":"mi-local","code":"ABCDE","name":"Beto"}   se suma
//   {"type":"rejoin","slug":"mi-local","code":"ABCDE","token":"…"}   vuelve tras un corte
//   {"type":"start"} · {"type":"answer","round":0,"option":2} · {"type":"again"} · {"type":"leave"}
//
// El servidor responde con {"type":"joined", code, playerToken, state} al
// entrar y con {"type":"state", state} a toda la sala cada vez que algo
// cambia. `state` es la partida vista por ese jugador (ver rooms.snapshot):
// la respuesta correcta no viaja hasta que la ronda cierra.
//
// Las reglas viven en duel/rooms.js; acá solo se asocian sockets a jugadores.
// Si a un jugador se le cierran todos sus sockets, queda "desconectado" en la
// sala (la partida sigue) y puede volver con "rejoin".
// ──────────────────────────────────────────────

const {
  allowedOrigins, safeSend, HEARTBEAT_MS, AUTH_TIMEOUT_MS, MAX_MESSAGES_PER_MINUTE, MAX_PAYLOAD_BYTES,
} = require("../reservations/realtime");
const { GamesError } = require("./errors");
const { createRoomManager } = require("./duel/rooms");

const WS_PATH = "/api/games/ws";

/**
 * Hub en memoria. No conoce `ws` ni la base: recibe sockets con la interfaz
 * mínima (send / on / close) y un resolver del local, así se prueba sin red.
 *
 * @param {object} deps
 * @param {(slug: string) => Promise<{ownerId: string, config: object, products: Array, hidePrices: boolean}|null>} deps.resolveVenue
 *        local con el Duelo habilitado y jugable, o null
 * @param {object} [deps.manager]  opciones de createRoomManager (reloj, temporizadores, azar)
 */
const createHub = ({ resolveVenue, manager = {} }) => {
  const members = new Map(); // código → Map(playerId → Set(sockets))
  const state = new WeakMap(); // socket → { code, playerId, messages, windowStart }

  const socketsOf = (code) => members.get(code) ?? new Map();

  const broadcast = (room) => {
    for (const [playerId, sockets] of socketsOf(room.code)) {
      const payload = { type: "state", state: rooms.snapshot(room, playerId) };
      for (const socket of sockets) safeSend(socket, payload);
    }
  };

  const rooms = createRoomManager({
    ...manager,
    onChange: broadcast,
    onClosed: (room) => {
      for (const sockets of socketsOf(room.code).values()) {
        for (const socket of sockets) {
          safeSend(socket, { type: "closed" });
          const info = state.get(socket);
          if (info) { info.code = null; info.playerId = null; }
        }
      }
      members.delete(room.code);
    },
  });

  // Saca el socket de su sala. Si era el último de ese jugador, queda desconectado.
  const unbind = (socket, { left = false } = {}) => {
    const info = state.get(socket);
    if (!info?.code) return;
    const { code, playerId } = info;
    info.code = null;
    info.playerId = null;
    const players = members.get(code);
    const sockets = players?.get(playerId);
    sockets?.delete(socket);
    if (sockets && sockets.size === 0) players.delete(playerId);
    if (players && players.size === 0) members.delete(code);
    if (left) rooms.leave(code, playerId);
    else if (!sockets || sockets.size === 0) rooms.disconnect(code, playerId);
  };

  const bind = (socket, { room, player }) => {
    const info = state.get(socket);
    if (!info) return;
    unbind(socket);
    info.code = room.code;
    info.playerId = player.id;
    if (!members.has(room.code)) members.set(room.code, new Map());
    const players = members.get(room.code);
    if (!players.has(player.id)) players.set(player.id, new Set());
    players.get(player.id).add(socket);
    safeSend(socket, { type: "joined", code: room.code, playerToken: player.token, state: rooms.snapshot(room, player.id) });
  };

  const venueOf = async (slug) => {
    const venue = typeof slug === "string" ? await resolveVenue(slug) : null;
    if (!venue) throw new GamesError(404, "Este local no tiene el juego disponible.", "GAME_UNAVAILABLE");
    return venue;
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

  const ACTIONS = {
    create: async (socket, message) => {
      const venue = await venueOf(message.slug);
      if (!state.has(socket)) return;
      bind(socket, rooms.createRoom({
        ownerId: venue.ownerId, config: venue.config, products: venue.products, hidePrices: venue.hidePrices,
        hostName: message.name,
      }));
    },
    join: async (socket, message) => {
      const venue = await venueOf(message.slug);
      if (!state.has(socket)) return;
      bind(socket, rooms.join(message.code, venue.ownerId, message.name));
    },
    rejoin: async (socket, message) => {
      const venue = await venueOf(message.slug);
      if (!state.has(socket)) return;
      bind(socket, rooms.rejoin(message.code, venue.ownerId, message.token));
    },
    start: (socket, message, info) => { rooms.start(info.code, info.playerId); },
    answer: (socket, message, info) => { rooms.answer(info.code, info.playerId, message.round, message.option); },
    again: (socket, message, info) => { rooms.playAgain(info.code, info.playerId); },
    leave: (socket) => {
      unbind(socket, { left: true });
      safeSend(socket, { type: "left" });
    },
  };
  const NEEDS_ROOM = new Set(["start", "answer", "again", "leave"]);

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
    const action = Object.prototype.hasOwnProperty.call(ACTIONS, message?.type) ? ACTIONS[message.type] : null;
    if (!action) return safeSend(socket, { type: "error", message: "Mensaje no soportado." });

    try {
      if (NEEDS_ROOM.has(message.type) && !info.code) {
        throw new GamesError(409, "No estás en ninguna partida.", "NOT_IN_ROOM");
      }
      await action(socket, message, info);
    } catch (error) {
      // Un GamesError trae un mensaje para el jugador; el resto nunca se muestra.
      const known = error instanceof GamesError;
      if (!known) console.error(error);
      safeSend(socket, {
        type: "error",
        code: known ? error.code : "INTERNAL",
        message: known ? error.message : "No se pudo completar la acción. Probá de nuevo.",
      });
    }
  };

  const connect = (socket) => {
    state.set(socket, { code: null, playerId: null, messages: 0, windowStart: Date.now() });

    // Si no entra a ninguna sala a tiempo, se corta (evita sockets colgados).
    const timer = setTimeout(() => {
      const info = state.get(socket);
      if (info && !info.code) socket.close?.(1008, "timeout");
    }, AUTH_TIMEOUT_MS);
    timer.unref?.();

    const drop = () => {
      clearTimeout(timer);
      unbind(socket);
      state.delete(socket);
    };
    socket.on("message", (raw) => { handleMessage(socket, raw).catch(() => {}); });
    socket.on("close", drop);
    socket.on("error", drop);
  };

  const stats = () => ({ ...rooms.stats(), sockets: [...members.values()].reduce((sum, players) => sum + players.size, 0) });

  return { connect, rooms, stats };
};

// ── Cableado real (ws + base) ────────────────

let hub = null;

const buildHub = () => createHub({
  resolveVenue: async (slug) => {
    const { findVenueBySlug, loadCatalog, filterPool, hidesPrices } = require("./catalog");
    const settingsService = require("./settingsService");
    const { canPlay } = require("./duel/engine");
    const venue = await findVenueBySlug(slug);
    if (!venue) return null;
    const { games } = await settingsService.getSettings(venue._id);
    if (!games.duel.enabled) return null;
    const products = filterPool((await loadCatalog(venue)).products, games.duel.pool);
    const hidePrices = hidesPrices(venue);
    if (!canPlay(products, { hidePrices })) return null;
    const { rounds, seconds, prizeText } = games.duel;
    return { ownerId: String(venue._id), config: { rounds, seconds, prizeText }, products, hidePrices };
  },
});

const getHub = () => {
  if (!hub) hub = buildHub();
  return hub;
};

const allowed = (origin) => !origin || allowedOrigins().includes(origin.replace(/\/$/, ""));

/** Engancha el WebSocket al servidor HTTP de la API (solo atiende WS_PATH). */
const attach = (server, currentHub = getHub()) => {
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

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

module.exports = { createHub, attach, WS_PATH };
