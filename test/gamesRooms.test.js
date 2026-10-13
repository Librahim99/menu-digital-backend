const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoomManager } = require("../src/games/duel/rooms");
const { DUEL_TIMING, LIMITS } = require("../src/games/constants");

// Duelo de la carta: reglas de las salas (crear, sumarse, rondas, puntaje,
// desconexiones). Reloj y temporizadores de mentira: nada espera de verdad.

const product = (id, title, price, categoryTitle, description = "") => ({ id, title, price, categoryTitle, description, available: true });
const CARTA = [
  product("p1", "Muzzarella", 9000, "Pizzas", "Salsa de tomate, queso y aceitunas verdes"),
  product("p2", "Napolitana", 10500, "Pizzas", "Con rodajas de tomate fresco y ajo"),
  product("p3", "Flan", 3000, "Postres", "Casero, con dulce de leche o crema"),
  product("p4", "Rubia", 2500, "Cervezas"),
  product("p5", "Negra", 2800, "Cervezas"),
];
const CONFIG = { rounds: 3, seconds: 10, prizeText: "Un café de regalo" };
const OWNER = "owner-1";

// Reloj manual: `advance(ms)` corre los temporizadores que vencen en ese lapso, en orden.
const fakeClock = () => {
  let time = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { at: time + ms, fn }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    advance: (ms) => {
      const end = time + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].fn();
      }
      time = end;
    },
  };
};

const setup = (over = {}) => {
  const clock = fakeClock();
  const changes = [];
  const closed = [];
  let codes = 0;
  let tokens = 0;
  let seed = 42;
  const manager = createRoomManager({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    rng: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
    newCode: () => `SALA${codes += 1}`,
    newToken: () => `token-${tokens += 1}`,
    onChange: (room) => changes.push(room.status),
    onClosed: (room) => closed.push(room.code),
    ...over,
  });
  return { manager, clock, changes, closed };
};

const open = (s, names = ["Ana", "Beto"]) => {
  const { room, player: host } = s.manager.createRoom({ ownerId: OWNER, config: CONFIG, products: CARTA, hostName: names[0] });
  const players = [host, ...names.slice(1).map((name) => s.manager.join(room.code, OWNER, name).player)];
  return { room, code: room.code, players };
};

const rejects = (fn, code) => assert.throws(fn, (error) => {
  assert.equal(error.code, code, error.message);
  return true;
});

// Opción correcta e incorrecta de la ronda en curso (el test puede mirar la sala por dentro).
const right = (room) => room.rounds[room.roundIndex].correct;
const wrong = (room) => (right(room) + 1) % room.rounds[room.roundIndex].options.length;

test("crear una sala: código, quien la crea queda como anfitrión, en espera", () => {
  const s = setup();
  const { room, player } = s.manager.createRoom({ ownerId: OWNER, config: CONFIG, products: CARTA, hostName: "  Ana  " });
  assert.equal(room.code, "SALA1");
  assert.equal(player.name, "Ana");
  assert.ok(player.token);
  const state = s.manager.snapshot(room, player.id);
  assert.equal(state.status, "lobby");
  assert.equal(state.hostId, player.id);
  assert.equal(state.me, player.id);
  assert.equal(state.round, null);
  assert.equal(state.totalRounds, 3);
  assert.equal(state.prizeText, "Un café de regalo");
  assert.deepEqual(state.players, [{ id: player.id, name: "Ana", score: 0, connected: true, answered: false }]);

  rejects(() => s.manager.createRoom({ ownerId: OWNER, config: CONFIG, products: CARTA, hostName: "" }), "NAME_REQUIRED");
  rejects(() => s.manager.createRoom({ ownerId: OWNER, config: CONFIG, products: CARTA, hostName: "x".repeat(21) }), "NAME_TOO_LONG");
});

test("sumarse: por código (sin importar mayúsculas), con tope de jugadores y nombres únicos", () => {
  const s = setup();
  const { code, room } = open(s, ["Ana"]);
  const beto = s.manager.join(code.toLowerCase(), OWNER, "Beto").player;
  assert.equal(room.players.size, 2);
  assert.notEqual(beto.token, room.players.get(1).token);

  rejects(() => s.manager.join(code, OWNER, "ana"), "NAME_TAKEN");
  rejects(() => s.manager.join("NOEXISTE", OWNER, "Caro"), "ROOM_NOT_FOUND");
  rejects(() => s.manager.join(code, OWNER, "   "), "NAME_REQUIRED");
  // El código de un local no sirve en la carta de otro.
  rejects(() => s.manager.join(code, "otro-local", "Caro"), "ROOM_NOT_FOUND");

  for (let i = 3; i <= LIMITS.duelPlayersMax; i += 1) s.manager.join(code, OWNER, `Jugador ${i}`);
  rejects(() => s.manager.join(code, OWNER, "Uno más"), "ROOM_FULL");
});

test("empezar: solo el anfitrión, con al menos dos jugadores conectados, una sola vez", () => {
  const s = setup();
  const solo = s.manager.createRoom({ ownerId: OWNER, config: CONFIG, products: CARTA, hostName: "Ana" });
  rejects(() => s.manager.start(solo.room.code, solo.player.id), "NOT_ENOUGH_PLAYERS");

  const { code, room, players: [ana, beto] } = open(s);
  rejects(() => s.manager.start(code, beto.id), "NOT_HOST");
  rejects(() => s.manager.start(code, 999), "PLAYER_NOT_FOUND");
  s.manager.start(code, ana.id);
  assert.equal(room.status, "question");
  assert.equal(room.rounds.length, 3);
  rejects(() => s.manager.start(code, ana.id), "ALREADY_STARTED");

  // Con una carta que no alcanza para armar rondas, no arranca.
  const empty = s.manager.createRoom({ ownerId: OWNER, config: CONFIG, products: CARTA.slice(0, 1), hostName: "Ana" });
  s.manager.join(empty.room.code, OWNER, "Beto");
  rejects(() => s.manager.start(empty.room.code, empty.player.id), "CANNOT_PLAY");
});

test("mientras la ronda está abierta no viaja la respuesta correcta ni lo que eligieron los demás", () => {
  const s = setup();
  const { code, room, players: [ana, beto] } = open(s);
  s.manager.start(code, ana.id);
  s.manager.answer(code, ana.id, 0, right(room));

  const forBeto = s.manager.snapshot(room, beto.id);
  assert.equal(forBeto.status, "question");
  assert.equal("correct" in forBeto.round, false);
  assert.equal("answers" in forBeto.round, false);
  assert.equal("itemId" in forBeto.round, false, "el producto de la ronda puede delatar la respuesta");
  assert.equal(forBeto.round.myAnswer, null);
  assert.equal(forBeto.round.endsAt, s.clock.now() + 10_000);
  assert.deepEqual(forBeto.players.map((p) => [p.name, p.answered]), [["Ana", true], ["Beto", false]]);
  assert.ok(forBeto.players.every((p) => p.score === 0 || p.name === "Ana"));
  assert.equal(s.manager.snapshot(room, ana.id).round.myAnswer, right(room));
  assert.equal(JSON.stringify(forBeto).includes("token"), false, "los tokens de los jugadores nunca viajan");
});

test("ronda: cuando responden todos se muestra la correcta sin esperar el reloj; puntos por acertar y por velocidad", () => {
  const s = setup();
  const { code, room, players: [ana, beto, caro] } = open(s, ["Ana", "Beto", "Caro"]);
  s.manager.start(code, ana.id);
  const correct = right(room);

  s.manager.answer(code, ana.id, 0, correct);       // al instante
  s.clock.advance(5_000);
  s.manager.answer(code, beto.id, 0, correct);      // a mitad del tiempo
  assert.equal(room.status, "question", "falta Caro");
  s.manager.answer(code, caro.id, 0, wrong(room));  // mal

  assert.equal(room.status, "reveal");
  const state = s.manager.snapshot(room, caro.id);
  assert.equal(state.round.correct, correct);
  assert.ok(state.round.itemId);
  assert.deepEqual(state.round.answers, [
    { playerId: ana.id, option: correct, points: 1000 },
    { playerId: beto.id, option: correct, points: 750 },
    { playerId: caro.id, option: wrong({ ...room, roundIndex: 0 }), points: 0 },
  ]);
  assert.deepEqual(state.players.map((p) => p.score), [1000, 750, 0]);

  // Pasado el tiempo de la respuesta, arranca la ronda siguiente.
  s.clock.advance(DUEL_TIMING.revealMs);
  assert.equal(room.status, "question");
  assert.equal(room.roundIndex, 1);
});

test("ronda: una sola respuesta por jugador, de la ronda en curso y válida", () => {
  const s = setup();
  const { code, room, players: [ana, beto] } = open(s);
  s.manager.start(code, ana.id);
  s.manager.answer(code, ana.id, 0, wrong(room));
  s.manager.answer(code, ana.id, 0, right(room)); // cambiar de idea no vale
  assert.equal(room.answers.get(ana.id).option, wrong(room));
  assert.equal(room.players.get(ana.id).score, 0);

  rejects(() => s.manager.answer(code, beto.id, 1, 0), "ROUND_CLOSED");
  rejects(() => s.manager.answer(code, beto.id, 0, 9), "BAD_ANSWER");
  rejects(() => s.manager.answer(code, beto.id, 0, -1), "BAD_ANSWER");
  rejects(() => s.manager.answer(code, beto.id, 0, "1"), "BAD_ANSWER");
  rejects(() => s.manager.answer(code, 999, 0, 0), "PLAYER_NOT_FOUND");
  rejects(() => s.manager.answer("NOEXISTE", beto.id, 0, 0), "ROOM_NOT_FOUND");

  // Con la respuesta a la vista ya no se puede responder esa ronda.
  s.manager.answer(code, beto.id, 0, right(room));
  assert.equal(room.status, "reveal");
  const score = room.players.get(beto.id).score;
  rejects(() => s.manager.answer(code, beto.id, 0, right({ ...room, roundIndex: 0 })), "ROUND_CLOSED");
  assert.equal(room.players.get(beto.id).score, score);
});

test("ronda: si alguien no responde, el reloj la cierra igual", () => {
  const s = setup();
  const { code, room, players: [ana] } = open(s);
  s.manager.start(code, ana.id);
  s.manager.answer(code, ana.id, 0, right(room));
  s.clock.advance(9_999);
  assert.equal(room.status, "question");
  s.clock.advance(1);
  assert.equal(room.status, "reveal");
  assert.equal(s.manager.snapshot(room, ana.id).round.answers.length, 1);
});

test("partida completa: rondas, ranking final ordenado, premio y revancha", () => {
  const s = setup();
  const { code, room, players: [ana, beto, caro] } = open(s, ["Ana", "Beto", "Caro"]);
  s.manager.start(code, ana.id);
  for (let round = 0; round < 3; round += 1) {
    assert.equal(room.roundIndex, round);
    s.clock.advance(2_000);
    s.manager.answer(code, beto.id, round, right(room));              // Beto siempre bien
    s.manager.answer(code, ana.id, round, round === 0 ? right(room) : wrong(room)); // Ana solo la primera
    s.manager.answer(code, caro.id, round, wrong(room));              // Caro nunca
    assert.equal(room.status, "reveal");
    s.clock.advance(DUEL_TIMING.revealMs);
  }
  assert.equal(room.status, "finished");
  const final = s.manager.snapshot(room, caro.id);
  assert.deepEqual(final.ranking.map((p) => p.name), ["Beto", "Ana", "Caro"]);
  assert.ok(final.ranking[0].score > final.ranking[1].score && final.ranking[1].score > 0);
  assert.equal(final.ranking[2].score, 0);
  assert.equal(final.round, null);
  assert.equal(final.prizeText, "Un café de regalo");

  // Revancha: solo el anfitrión; vuelve a la espera con los puntos en cero.
  rejects(() => s.manager.playAgain(code, beto.id), "NOT_HOST");
  s.manager.playAgain(code, ana.id);
  assert.equal(room.status, "lobby");
  assert.ok([...room.players.values()].every((p) => p.score === 0));
  rejects(() => s.manager.playAgain(code, ana.id), "NOT_FINISHED");
  s.manager.start(code, ana.id);
  assert.equal(room.status, "question");
  assert.equal(room.roundIndex, 0);
});

test("empate: el ranking queda ordenado por nombre", () => {
  const s = setup();
  const { code, room, players: [zoe, ana] } = open(s, ["Zoe", "Ana"]);
  s.manager.start(code, zoe.id);
  for (let round = 0; round < 3; round += 1) {
    s.manager.answer(code, zoe.id, round, wrong(room));
    s.manager.answer(code, ana.id, round, wrong(room));
    s.clock.advance(DUEL_TIMING.revealMs);
  }
  assert.deepEqual(s.manager.snapshot(room, zoe.id).ranking.map((p) => [p.name, p.score]), [["Ana", 0], ["Zoe", 0]]);
});

test("desconexión en medio de una ronda: la partida no lo espera y conserva su puntaje", () => {
  const s = setup();
  const { code, room, players: [ana, beto, caro] } = open(s, ["Ana", "Beto", "Caro"]);
  s.manager.start(code, ana.id);
  s.manager.answer(code, caro.id, 0, right(room));
  const points = room.players.get(caro.id).score;
  s.manager.answer(code, ana.id, 0, right(room));
  assert.equal(room.status, "question", "falta Beto");

  // A Beto se le corta: con los que quedan ya respondieron todos.
  s.manager.disconnect(code, beto.id);
  assert.equal(room.status, "reveal");
  assert.equal(room.players.get(beto.id).connected, false);
  s.manager.disconnect(code, beto.id); // repetido: no pasa nada

  // A Caro también se le corta, después de responder: sus puntos quedan.
  s.manager.disconnect(code, caro.id);
  s.clock.advance(DUEL_TIMING.revealMs);
  assert.equal(room.roundIndex, 1);
  s.manager.answer(code, ana.id, 1, wrong(room));
  assert.equal(room.status, "reveal", "solo queda Ana conectada: no se espera a nadie");
  assert.equal(room.players.get(caro.id).score, points);
  assert.deepEqual(s.manager.snapshot(room, ana.id).players.map((p) => p.connected), [true, false, false]);
});

test("reconexión: vuelve con su token y sigue donde estaba; con un token ajeno no entra", () => {
  const s = setup();
  const { code, room, players: [ana, beto] } = open(s);
  s.manager.start(code, ana.id);
  s.manager.answer(code, beto.id, 0, right(room));
  const points = room.players.get(beto.id).score;
  s.manager.disconnect(code, beto.id);
  s.manager.answer(code, ana.id, 0, wrong(room));
  s.clock.advance(DUEL_TIMING.revealMs); // la partida siguió sin él
  assert.equal(room.roundIndex, 1);

  const back = s.manager.rejoin(code, OWNER, beto.token);
  assert.equal(back.player.id, beto.id);
  assert.equal(back.player.connected, true);
  assert.equal(back.player.score, points);
  const state = s.manager.snapshot(room, beto.id);
  assert.equal(state.status, "question");
  assert.equal(state.round.index, 1);
  s.manager.answer(code, beto.id, 1, right(room)); // y puede seguir jugando

  rejects(() => s.manager.rejoin(code, OWNER, "token-inventado"), "PLAYER_NOT_FOUND");
  rejects(() => s.manager.rejoin(code, OWNER, undefined), "PLAYER_NOT_FOUND");
  rejects(() => s.manager.rejoin(code, OWNER, null), "PLAYER_NOT_FOUND");
  rejects(() => s.manager.rejoin(code, "otro-local", beto.token), "ROOM_NOT_FOUND");
  rejects(() => s.manager.rejoin("NOEXISTE", OWNER, beto.token), "ROOM_NOT_FOUND");
});

test("reconexión sin token (otro navegador): con su mismo nombre retoma su lugar si estaba desconectado", () => {
  const s = setup();
  const { code, room, players: [ana, beto] } = open(s);
  s.manager.start(code, ana.id);
  s.manager.answer(code, beto.id, 0, right(room));
  const points = room.players.get(beto.id).score;
  const oldToken = beto.token;
  s.manager.disconnect(code, beto.id);

  const back = s.manager.join(code, OWNER, "beto").player;
  assert.equal(back.id, beto.id);
  assert.equal(back.score, points);
  assert.equal(room.players.size, 2, "no se duplica el jugador");
  assert.notEqual(back.token, oldToken);
  rejects(() => s.manager.rejoin(code, OWNER, oldToken), "PLAYER_NOT_FOUND");
  // Conectado, nadie más puede usar su nombre.
  rejects(() => s.manager.join(code, OWNER, "Beto"), "NAME_TAKEN");
});

test("si se cae el anfitrión, la sala pasa a manejarla otro; al volver no la recupera", () => {
  const s = setup();
  const { code, room, players: [ana, beto, caro] } = open(s, ["Ana", "Beto", "Caro"]);
  s.manager.disconnect(code, ana.id);
  assert.equal(room.hostId, beto.id);
  rejects(() => s.manager.start(code, ana.id), "NOT_HOST");
  s.manager.rejoin(code, OWNER, ana.token);
  assert.equal(room.hostId, beto.id);
  s.manager.start(code, beto.id);
  assert.equal(room.status, "question");

  // Con la partida terminada pasa lo mismo: alguien tiene que poder pedir la revancha.
  for (let round = 0; round < 3; round += 1) { s.clock.advance(10_000); s.clock.advance(DUEL_TIMING.revealMs); }
  assert.equal(room.status, "finished");
  s.manager.disconnect(code, beto.id);
  assert.equal(room.hostId, ana.id);
  s.manager.playAgain(code, ana.id);
  assert.equal(caro.connected, true);
});

test("irse a propósito: en la espera desaparece; con la partida empezada queda en el ranking y no vuelve con su token", () => {
  const s = setup();
  const { code, room, players: [ana, beto, caro] } = open(s, ["Ana", "Beto", "Caro"]);
  s.manager.leave(code, caro.id);
  assert.equal(room.players.size, 2);
  rejects(() => s.manager.rejoin(code, OWNER, caro.token), "PLAYER_NOT_FOUND");

  s.manager.start(code, ana.id);
  s.manager.answer(code, ana.id, 0, right(room));
  s.manager.leave(code, beto.id);
  assert.equal(room.status, "reveal", "ya respondieron los que quedan");
  assert.equal(room.players.size, 2);
  assert.equal(room.players.get(beto.id).connected, false);
  rejects(() => s.manager.rejoin(code, OWNER, "token-2"), "PLAYER_NOT_FOUND");

  // El último se va de la sala de espera: la sala se cierra.
  const other = s.manager.createRoom({ ownerId: OWNER, config: CONFIG, products: CARTA, hostName: "Dani" });
  s.manager.leave(other.room.code, other.player.id);
  assert.equal(s.manager.get(other.room.code), null);
  assert.ok(s.closed.includes(other.room.code));
});

test("limpieza: sala sin nadie conectado, partida terminada y espera eterna se descartan solas", () => {
  const s = setup();
  // Sin nadie conectado: se descarta a los minutos... salvo que alguien vuelva antes.
  const a = open(s);
  s.manager.disconnect(a.code, a.players[0].id);
  s.manager.disconnect(a.code, a.players[1].id);
  s.clock.advance(DUEL_TIMING.emptyRoomMs - 1);
  assert.ok(s.manager.get(a.code));
  s.manager.rejoin(a.code, OWNER, a.players[1].token);
  s.clock.advance(DUEL_TIMING.emptyRoomMs);
  assert.ok(s.manager.get(a.code), "volvió a tiempo");
  s.manager.disconnect(a.code, a.players[1].id);
  s.clock.advance(DUEL_TIMING.emptyRoomMs);
  assert.equal(s.manager.get(a.code), null);
  rejects(() => s.manager.join(a.code, OWNER, "Caro"), "ROOM_NOT_FOUND");

  // Partida terminada: queda un rato para ver el ranking.
  const b = open(s);
  s.manager.start(b.code, b.players[0].id);
  for (let round = 0; round < 3; round += 1) { s.clock.advance(10_000); s.clock.advance(DUEL_TIMING.revealMs); }
  assert.equal(b.room.status, "finished");
  s.clock.advance(DUEL_TIMING.finishedRoomMs);
  assert.equal(s.manager.get(b.code), null);

  // Sala que nunca arranca.
  const c = open(s);
  s.clock.advance(DUEL_TIMING.lobbyRoomMs);
  assert.equal(s.manager.get(c.code), null);

  assert.deepEqual(s.closed, [a.code, b.code, c.code]);
  assert.equal(s.clock.pending(), 0, "no queda ningún temporizador colgado");
  assert.deepEqual(s.manager.stats(), { rooms: 0 });
});

test("tope de salas por local, sin afectar a los demás", () => {
  const s = setup();
  for (let i = 0; i < LIMITS.duelRoomsPerVenue; i += 1) {
    s.manager.createRoom({ ownerId: OWNER, config: CONFIG, products: CARTA, hostName: "Ana" });
  }
  rejects(() => s.manager.createRoom({ ownerId: OWNER, config: CONFIG, products: CARTA, hostName: "Ana" }), "VENUE_BUSY");
  assert.ok(s.manager.createRoom({ ownerId: "otro-local", config: CONFIG, products: CARTA, hostName: "Ana" }).room);
});

test("avisa cada cambio de estado para que todos lo vean", () => {
  const s = setup();
  const { code, room, players: [ana, beto] } = open(s);
  s.changes.length = 0;
  s.manager.start(code, ana.id);
  s.manager.answer(code, ana.id, 0, right(room));
  s.manager.answer(code, beto.id, 0, right(room));
  s.clock.advance(DUEL_TIMING.revealMs);
  assert.deepEqual(s.changes, ["question", "question", "reveal", "question"]);
});
