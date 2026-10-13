// Duelo de la carta: las salas. Acá vive el estado de cada partida y sus
// reglas; el servidor es la única autoridad (los celulares solo mandan "me
// sumo", "empezar", "respondo B").
//
// - Estado en memoria del proceso, igual que el resto del tiempo real de la
//   API (una sola instancia). Una partida dura un par de minutos: si el
//   servidor se reinicia, se pierde y se arma otra.
// - No conoce sockets: avisa los cambios por `onChange(room)` y el hub
//   (realtime.js) los reparte. El reloj, los temporizadores y el azar se
//   inyectan, así las reglas se prueban sin esperar ni depender de la suerte.
// - Desconexiones: quien se cae sigue en la sala con su puntaje y vuelve con
//   su token (o con su mismo nombre). La partida no lo espera: las rondas
//   avanzan por tiempo, o antes si ya respondieron todos los conectados. Si
//   se cae el que la creó, pasa a manejarla otro. Una sala sin nadie
//   conectado se descarta a los pocos minutos.

const { GamesError } = require("../errors");
const { LIMITS, DUEL_TIMING } = require("../constants");
const { buildRounds, scoreAnswer } = require("./engine");
const { randomCode, randomToken } = require("../../orders/utils/tokens");

const fail = (code, message) => new GamesError(409, message, code);

const cleanName = (value) => {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new GamesError(400, "Decinos tu nombre para jugar.", "NAME_REQUIRED");
  if (name.length > LIMITS.duelPlayerNameLength) {
    throw new GamesError(400, `El nombre puede tener hasta ${LIMITS.duelPlayerNameLength} caracteres.`, "NAME_TOO_LONG");
  }
  return name;
};

const createRoomManager = ({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  rng = Math.random,
  newCode = () => randomCode(LIMITS.duelCodeLength),
  newToken = () => randomToken(24),
  timing = DUEL_TIMING,
  onChange = () => {},
  onClosed = () => {},
} = {}) => {
  const rooms = new Map(); // código → sala

  const connected = (room) => [...room.players.values()].filter((player) => player.connected);

  const schedule = (room, key, ms, fn) => {
    if (room[key]) clearTimer(room[key]);
    room[key] = setTimer(() => {
      room[key] = null;
      fn();
    }, ms);
    room[key]?.unref?.();
  };

  const cancel = (room, key) => {
    if (room[key]) clearTimer(room[key]);
    room[key] = null;
  };

  const close = (room) => {
    cancel(room, "timer");
    cancel(room, "emptyTimer");
    if (rooms.delete(room.code)) onClosed(room);
  };

  // Sin nadie conectado la sala queda un rato (por si vuelven) y se descarta.
  const watchEmpty = (room) => {
    if (connected(room).length === 0) schedule(room, "emptyTimer", timing.emptyRoomMs, () => close(room));
    else cancel(room, "emptyTimer");
  };

  const changed = (room) => {
    watchEmpty(room);
    onChange(room);
  };

  const getRoom = (code, ownerId) => {
    const room = rooms.get(String(code ?? "").toUpperCase());
    // Una sala de otro local "no existe": el código no sirve fuera de su carta.
    if (!room || (ownerId !== undefined && room.ownerId !== String(ownerId))) {
      throw new GamesError(404, "No encontramos esa partida. Revisá el código.", "ROOM_NOT_FOUND");
    }
    return room;
  };

  const getPlayer = (room, playerId) => {
    const player = room.players.get(Number(playerId));
    if (!player) throw new GamesError(404, "Ya no sos parte de esta partida.", "PLAYER_NOT_FOUND");
    return player;
  };

  const addPlayer = (room, name) => {
    room.playerSeq += 1;
    const player = { id: room.playerSeq, name, token: newToken(), connected: true, score: 0 };
    room.players.set(player.id, player);
    return player;
  };

  // ── Rondas ───────────────────────────────────

  const finish = (room) => {
    room.status = "finished";
    schedule(room, "timer", timing.finishedRoomMs, () => close(room));
    changed(room);
  };

  const beginRound = (room, index) => {
    room.status = "question";
    room.roundIndex = index;
    room.roundStartedAt = now();
    room.answers = new Map();
    schedule(room, "timer", room.config.seconds * 1000, () => reveal(room));
    changed(room);
  };

  function reveal(room) {
    room.status = "reveal";
    const next = room.roundIndex + 1;
    schedule(room, "timer", timing.revealMs, () => (next < room.rounds.length ? beginRound(room, next) : finish(room)));
    changed(room);
  }

  // Ya respondieron todos los que están conectados: no hace falta esperar el reloj.
  const revealIfEveryoneAnswered = (room) => {
    const online = connected(room);
    if (room.status === "question" && online.length > 0 && online.every((player) => room.answers.has(player.id))) {
      cancel(room, "timer");
      reveal(room);
      return true;
    }
    return false;
  };

  // ── Acciones ─────────────────────────────────

  /**
   * @param {object} input
   * @param {string} input.ownerId
   * @param {{ rounds: number, seconds: number, prizeText: string }} input.config  del local
   * @param {Array} input.products   productos que participan (para armar las rondas)
   * @param {boolean} input.hidePrices
   * @param {string} input.hostName
   */
  const createRoom = ({ ownerId, config, products, hidePrices = false, hostName }) => {
    const name = cleanName(hostName);
    const owner = String(ownerId);
    if ([...rooms.values()].filter((room) => room.ownerId === owner).length >= LIMITS.duelRoomsPerVenue) {
      throw fail("VENUE_BUSY", "Hay muchas partidas abiertas en este local. Probá en un ratito.");
    }
    let code = newCode();
    for (let attempt = 0; rooms.has(code) && attempt < 20; attempt += 1) code = newCode();
    if (rooms.has(code)) throw fail("VENUE_BUSY", "No se pudo crear la partida. Probá de nuevo.");

    const room = {
      code, ownerId: owner, config, products, hidePrices, status: "lobby", players: new Map(), playerSeq: 0,
      hostId: null, rounds: [], roundIndex: -1, roundStartedAt: 0, answers: new Map(), timer: null, emptyTimer: null,
    };
    const player = addPlayer(room, name);
    room.hostId = player.id;
    rooms.set(code, room);
    // Una sala que nunca arranca tampoco queda para siempre.
    schedule(room, "timer", timing.lobbyRoomMs, () => close(room));
    changed(room);
    return { room, player };
  };

  // Se suma a la sala. Si ya había alguien con ese nombre y está desconectado,
  // es él volviendo desde otro navegador: retoma su lugar y su puntaje.
  const join = (code, ownerId, rawName) => {
    const room = getRoom(code, ownerId);
    const name = cleanName(rawName);
    const same = [...room.players.values()].find((player) => player.name.toLowerCase() === name.toLowerCase());
    let player;
    if (same) {
      if (same.connected) throw fail("NAME_TAKEN", `Ya hay alguien que se llama ${name} en la partida. Probá con otro nombre.`);
      same.connected = true;
      same.token = newToken();
      player = same;
    } else {
      if (room.players.size >= LIMITS.duelPlayersMax) throw fail("ROOM_FULL", "La partida ya está completa.");
      player = addPlayer(room, name);
    }
    if (!room.players.get(room.hostId)?.connected) room.hostId = player.id;
    changed(room);
    return { room, player };
  };

  // Vuelve con el token que le quedó en el celular (recarga, corte de red).
  const rejoin = (code, ownerId, token) => {
    const room = getRoom(code, ownerId);
    const player = [...room.players.values()].find((entry) => entry.token === token);
    if (!player || typeof token !== "string") throw new GamesError(404, "Ya no sos parte de esta partida.", "PLAYER_NOT_FOUND");
    player.connected = true;
    if (!room.players.get(room.hostId)?.connected) room.hostId = player.id;
    changed(room);
    return { room, player };
  };

  const passHost = (room) => {
    if (room.players.get(room.hostId)?.connected) return;
    const next = connected(room)[0];
    if (next) room.hostId = next.id;
  };

  // Se le cortó la conexión: sigue en la sala, pero la partida no lo espera.
  const disconnect = (code, playerId) => {
    const room = rooms.get(code);
    const player = room?.players.get(Number(playerId));
    if (!player || !player.connected) return;
    player.connected = false;
    passHost(room);
    if (!revealIfEveryoneAnswered(room)) changed(room);
  };

  // Se va a propósito: deja la sala (en el lobby desaparece; con la partida
  // empezada queda en el ranking como desconectado).
  const leave = (code, playerId) => {
    const room = rooms.get(code);
    const player = room?.players.get(Number(playerId));
    if (!player) return;
    if (room.status === "lobby") room.players.delete(player.id);
    else player.connected = false;
    // Quien se fue no vuelve con su token.
    player.token = null;
    if (room.players.size === 0) return close(room);
    passHost(room);
    if (!revealIfEveryoneAnswered(room)) changed(room);
  };

  const assertHost = (room, playerId) => {
    getPlayer(room, playerId);
    if (room.hostId !== Number(playerId)) throw new GamesError(403, "La partida la maneja quien la creó.", "NOT_HOST");
  };

  const start = (code, playerId) => {
    const room = getRoom(code);
    assertHost(room, playerId);
    if (room.status !== "lobby") throw fail("ALREADY_STARTED", "La partida ya empezó.");
    if (connected(room).length < LIMITS.duelPlayersMin) {
      throw fail("NOT_ENOUGH_PLAYERS", `Hacen falta al menos ${LIMITS.duelPlayersMin} jugadores.`);
    }
    const rounds = buildRounds(room.products, { rounds: room.config.rounds, hidePrices: room.hidePrices, rng });
    if (rounds.length === 0) throw fail("CANNOT_PLAY", "Con la carta de este local no se pueden armar rondas.");
    room.rounds = rounds;
    for (const player of room.players.values()) player.score = 0;
    beginRound(room, 0);
    return room;
  };

  // Una respuesta por jugador y por ronda; vale la primera.
  const answer = (code, playerId, roundIndex, option) => {
    const room = getRoom(code);
    const player = getPlayer(room, playerId);
    if (room.status !== "question" || Number(roundIndex) !== room.roundIndex) {
      throw fail("ROUND_CLOSED", "Esa ronda ya terminó.");
    }
    const round = room.rounds[room.roundIndex];
    if (!Number.isInteger(option) || option < 0 || option >= round.options.length) {
      throw new GamesError(400, "Respuesta inválida.", "BAD_ANSWER");
    }
    if (room.answers.has(player.id)) return room;
    const elapsedMs = Math.max(0, now() - room.roundStartedAt);
    const points = scoreAnswer({ correct: option === round.correct, elapsedMs, totalMs: room.config.seconds * 1000 });
    room.answers.set(player.id, { option, points });
    player.score += points;
    if (!revealIfEveryoneAnswered(room)) changed(room);
    return room;
  };

  // Revancha: vuelve al lobby con los mismos jugadores.
  const playAgain = (code, playerId) => {
    const room = getRoom(code);
    assertHost(room, playerId);
    if (room.status !== "finished") throw fail("NOT_FINISHED", "La partida todavía no terminó.");
    room.status = "lobby";
    room.rounds = [];
    room.roundIndex = -1;
    room.answers = new Map();
    for (const player of room.players.values()) player.score = 0;
    schedule(room, "timer", timing.lobbyRoomMs, () => close(room));
    changed(room);
    return room;
  };

  // ── Lo que ve cada jugador ───────────────────
  // Nunca incluye la respuesta correcta mientras la ronda está abierta.
  const snapshot = (room, playerId) => {
    const round = room.status === "question" || room.status === "reveal" ? room.rounds[room.roundIndex] : null;
    const revealing = room.status === "reveal";
    const players = [...room.players.values()];
    return {
      code: room.code,
      status: room.status,
      me: Number(playerId),
      hostId: room.hostId,
      serverNow: now(),
      totalRounds: room.rounds.length || room.config.rounds,
      seconds: room.config.seconds,
      prizeText: room.config.prizeText,
      minPlayers: LIMITS.duelPlayersMin,
      players: players.map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        connected: player.connected,
        answered: room.status === "question" && room.answers.has(player.id),
      })),
      round: round && {
        index: room.roundIndex,
        prompt: round.prompt,
        detail: round.detail ?? null,
        options: round.options,
        endsAt: room.roundStartedAt + room.config.seconds * 1000,
        myAnswer: room.answers.get(Number(playerId))?.option ?? null,
        ...(revealing ? {
          correct: round.correct,
          // Producto de la ronda, para verlo y sumarlo al pedido.
          itemId: round.itemId,
          answers: [...room.answers].map(([id, entry]) => ({ playerId: id, option: entry.option, points: entry.points })),
        } : {}),
      },
      ranking: room.status === "finished"
        ? players.map(({ id, name, score }) => ({ id, name, score }))
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        : null,
    };
  };

  const closeAll = () => { for (const room of [...rooms.values()]) close(room); };

  return {
    createRoom, join, rejoin, disconnect, leave, start, answer, playAgain, snapshot, closeAll,
    get: (code) => rooms.get(code) ?? null,
    stats: () => ({ rooms: rooms.size }),
  };
};

module.exports = { createRoomManager };
