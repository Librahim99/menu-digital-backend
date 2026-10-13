const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const WebSocket = require("ws");
const { createHub, attach, WS_PATH } = require("../src/games/realtime");
const reservationsRealtime = require("../src/reservations/realtime");
const ordersRealtime = require("../src/orders/delivery/realtime");

// Duelo de la carta por WebSocket: el hub (qué recibe cada celular) con
// sockets de mentira, y una partida entera entre dos clientes reales contra el
// servidor HTTP armado como en producción (los tres módulos de tiempo real).

const product = (id, title, price, categoryTitle, description = "") => ({ id, title, price, categoryTitle, description, available: true });
const CARTA = [
  product("p1", "Muzzarella", 9000, "Pizzas", "Salsa de tomate, queso y aceitunas verdes"),
  product("p2", "Napolitana", 10500, "Pizzas", "Con rodajas de tomate fresco y ajo"),
  product("p3", "Flan", 3000, "Postres", "Casero, con dulce de leche o crema"),
  product("p4", "Rubia", 2500, "Cervezas"),
];
const VENUES = {
  "mi-bar": { ownerId: "owner-1", config: { rounds: 3, seconds: 10, prizeText: "Un café" }, products: CARTA, hidePrices: false },
  "otro-bar": { ownerId: "owner-2", config: { rounds: 3, seconds: 10, prizeText: "" }, products: CARTA, hidePrices: false },
};
const resolveVenue = async (slug) => VENUES[slug] ?? null;

// Socket mínimo: lo que el hub le manda queda en `sent`.
const fakeSocket = () => {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.sent = [];
  socket.send = (raw) => socket.sent.push(JSON.parse(raw));
  socket.close = (code) => { socket.closedWith = code; socket.readyState = 3; socket.emit("close"); };
  socket.say = async (message) => {
    socket.emit("message", typeof message === "string" ? message : JSON.stringify(message));
    // El hub resuelve el local de forma asíncrona antes de responder.
    await new Promise((resolve) => setImmediate(resolve));
  };
  socket.last = (type) => socket.sent.filter((message) => message.type === type).at(-1);
  socket.state = () => socket.last("state")?.state ?? socket.last("joined")?.state;
  return socket;
};

const fakeClock = () => {
  let time = 5_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { at: time + ms, fn }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
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

const setup = () => {
  const clock = fakeClock();
  const hub = createHub({ resolveVenue, manager: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer } });
  const connect = () => { const socket = fakeSocket(); hub.connect(socket); return socket; };
  return { hub, clock, connect };
};

// Ana crea la sala y Beto se suma con el código.
const party = async (s) => {
  const ana = s.connect();
  await ana.say({ type: "create", slug: "mi-bar", name: "Ana" });
  const { code, playerToken } = ana.last("joined");
  const beto = s.connect();
  await beto.say({ type: "join", slug: "mi-bar", code, name: "Beto" });
  return { ana, beto, code, anaToken: playerToken, betoToken: beto.last("joined").playerToken, room: s.hub.rooms.get(code) };
};

const right = (room) => room.rounds[room.roundIndex].correct;

test("crear y sumarse: cada celular recibe su acceso y la sala vista desde su lugar", async () => {
  const s = setup();
  const { ana, beto, code } = await party(s);

  const joined = ana.last("joined");
  assert.match(code, /^[A-HJKMNP-Z2-9]{5}$/);
  assert.ok(joined.playerToken);
  assert.equal(joined.state.status, "lobby");
  assert.equal(joined.state.prizeText, "Un café");

  // A Ana le llega que entró Beto; cada uno se ve como "yo".
  assert.deepEqual(ana.state().players.map((p) => p.name), ["Ana", "Beto"]);
  assert.equal(ana.state().me, 1);
  assert.equal(beto.state().me, 2);
  assert.equal(beto.state().hostId, 1);
  assert.notEqual(beto.last("joined").playerToken, joined.playerToken);
  assert.deepEqual(s.hub.stats(), { rooms: 1, sockets: 2 });
});

test("partida entre dos celulares: preguntas sin la respuesta, resultado para todos y ranking final", async () => {
  const s = setup();
  const { ana, beto, room } = await party(s);
  await ana.say({ type: "start" });

  for (let round = 0; round < 3; round += 1) {
    for (const socket of [ana, beto]) {
      const state = socket.state();
      assert.equal(state.status, "question");
      assert.equal(state.round.index, round);
      assert.equal("correct" in state.round, false, "la respuesta no viaja con la pregunta");
    }
    const correct = right(room);
    await ana.say({ type: "answer", round, option: correct });
    assert.equal(beto.state().players[0].answered, true, "Beto ve que Ana ya respondió (no qué)");
    assert.equal(beto.state().round.myAnswer, null);
    await beto.say({ type: "answer", round, option: (correct + 1) % room.rounds[round].options.length });

    for (const socket of [ana, beto]) {
      assert.equal(socket.state().status, "reveal");
      assert.equal(socket.state().round.correct, correct);
      assert.equal(socket.state().round.answers.length, 2);
    }
    s.clock.advance(5_000);
  }

  for (const socket of [ana, beto]) {
    assert.equal(socket.state().status, "finished");
    assert.deepEqual(socket.state().ranking.map((p) => p.name), ["Ana", "Beto"]);
  }
  assert.equal(ana.state().ranking[0].score, 3000);
  assert.equal(ana.state().ranking[1].score, 0);

  // Revancha: la pide quien maneja la sala.
  await beto.say({ type: "again" });
  assert.equal(beto.last("error").code, "NOT_HOST");
  await ana.say({ type: "again" });
  assert.equal(beto.state().status, "lobby");
});

test("errores: local sin el juego, código que no existe, acciones fuera de una sala y mensajes rotos", async () => {
  const s = setup();
  const socket = s.connect();
  await socket.say({ type: "create", slug: "no-existe", name: "Ana" });
  assert.equal(socket.last("error").code, "GAME_UNAVAILABLE");
  await socket.say({ type: "create", name: "Ana" });
  assert.equal(socket.last("error").code, "GAME_UNAVAILABLE");
  await socket.say({ type: "join", slug: "mi-bar", code: "ZZZZZ", name: "Ana" });
  assert.equal(socket.last("error").code, "ROOM_NOT_FOUND");
  await socket.say({ type: "create", slug: "mi-bar", name: "" });
  assert.equal(socket.last("error").code, "NAME_REQUIRED");
  for (const type of ["start", "answer", "again", "leave"]) {
    await socket.say({ type });
    assert.equal(socket.last("error").code, "NOT_IN_ROOM", type);
  }
  await socket.say("{esto no es json");
  assert.equal(socket.last("error").message, "Mensaje inválido.");
  await socket.say({ type: "hackear" });
  assert.equal(socket.last("error").message, "Mensaje no soportado.");
  await socket.say({ type: "constructor" });
  assert.equal(socket.last("error").message, "Mensaje no soportado.");
  assert.deepEqual(s.hub.stats(), { rooms: 0, sockets: 0 });

  // El código de la sala de un local no sirve desde la carta de otro.
  const { code } = await party(s);
  await socket.say({ type: "join", slug: "otro-bar", code, name: "Colado" });
  assert.equal(socket.last("error").code, "ROOM_NOT_FOUND");
  // Solo el anfitrión empieza; y una respuesta inválida no rompe nada.
  const { ana, beto } = await party(s);
  await beto.say({ type: "start" });
  assert.equal(beto.last("error").code, "NOT_HOST");
  await ana.say({ type: "start" });
  await beto.say({ type: "answer", round: 0, option: 99 });
  assert.equal(beto.last("error").code, "BAD_ANSWER");
  await beto.say({ type: "answer", round: 5, option: 0 });
  assert.equal(beto.last("error").code, "ROUND_CLOSED");
  assert.equal(ana.state().status, "question");
});

test("desconexión: se le corta a uno, los demás lo ven y la partida sigue sin esperarlo", async () => {
  const s = setup();
  const { ana, beto, room } = await party(s);
  await ana.say({ type: "start" });
  await ana.say({ type: "answer", round: 0, option: right(room) });
  assert.equal(ana.state().status, "question", "falta Beto");

  beto.close(1006); // se quedó sin señal
  assert.deepEqual(ana.state().players.map((p) => [p.name, p.connected]), [["Ana", true], ["Beto", false]]);
  assert.equal(ana.state().status, "reveal", "ya respondieron todos los conectados");
  assert.deepEqual(s.hub.stats(), { rooms: 1, sockets: 1 });
});

test("reconexión: vuelve con su token en otro socket y recibe la partida donde está", async () => {
  const s = setup();
  const { ana, beto, code, betoToken, room } = await party(s);
  await ana.say({ type: "start" });
  await beto.say({ type: "answer", round: 0, option: right(room) });
  const points = room.players.get(2).score;
  beto.close(1006);
  await ana.say({ type: "answer", round: 0, option: right(room) });
  s.clock.advance(5_000); // siguió la ronda 2 sin él

  const again = s.connect();
  await again.say({ type: "rejoin", slug: "mi-bar", code, token: betoToken });
  const state = again.last("joined").state;
  assert.equal(state.me, 2);
  assert.equal(state.status, "question");
  assert.equal(state.round.index, 1);
  assert.equal(state.players[1].score, points);
  assert.equal(ana.state().players[1].connected, true, "Ana ve que volvió");
  await again.say({ type: "answer", round: 1, option: right(room) });
  assert.equal(ana.state().players[1].answered, true);

  // Con un token inventado, o el de otro local, no entra.
  const intruder = s.connect();
  await intruder.say({ type: "rejoin", slug: "mi-bar", code, token: "inventado" });
  assert.equal(intruder.last("error").code, "PLAYER_NOT_FOUND");
  await intruder.say({ type: "rejoin", slug: "otro-bar", code, token: betoToken });
  assert.equal(intruder.last("error").code, "ROOM_NOT_FOUND");
});

test("dos pestañas del mismo jugador: cerrar una no lo desconecta", async () => {
  const s = setup();
  const { ana, beto, code, betoToken } = await party(s);
  const tab = s.connect();
  await tab.say({ type: "rejoin", slug: "mi-bar", code, token: betoToken });
  beto.close(1001);
  assert.equal(ana.state().players[1].connected, true);
  tab.close(1001);
  assert.equal(ana.state().players[1].connected, false);
});

test("salir y cierre de la sala", async () => {
  const s = setup();
  const { ana, beto, code } = await party(s);
  await beto.say({ type: "leave" });
  assert.equal(beto.last("left").type, "left");
  assert.deepEqual(ana.state().players.map((p) => p.name), ["Ana"]);
  await beto.say({ type: "start" });
  assert.equal(beto.last("error").code, "NOT_IN_ROOM", "ya no está en la sala");

  // Se fue el último: la sala se cierra y el código deja de servir.
  await ana.say({ type: "leave" });
  assert.deepEqual(s.hub.stats(), { rooms: 0, sockets: 0 });
  await beto.say({ type: "join", slug: "mi-bar", code, name: "Beto" });
  assert.equal(beto.last("error").code, "ROOM_NOT_FOUND");

  // Sala que nadie arranca: al vencer avisa a los que seguían ahí.
  const other = await party(s);
  s.clock.advance(31 * 60_000);
  assert.equal(other.ana.sent.at(-1).type, "closed");
  assert.equal(other.beto.sent.at(-1).type, "closed");
  await other.ana.say({ type: "start" });
  assert.equal(other.ana.last("error").code, "NOT_IN_ROOM");
});

test("un socket que manda de más se corta (límite por minuto)", async () => {
  const s = setup();
  const socket = s.connect();
  for (let i = 0; i < 40; i += 1) await socket.say({ type: "nada" });
  assert.equal(socket.closedWith, undefined);
  await socket.say({ type: "nada" });
  assert.equal(socket.closedWith, 1008);
});

// ── Servidor real ────────────────────────────────────────────────────────────

const listen = () => new Promise((resolve) => {
  const server = http.createServer();
  // Mismo armado que app.js: los tres módulos comparten el servidor.
  reservationsRealtime.attach(server);
  ordersRealtime.attach(server);
  const hub = createHub({ resolveVenue, manager: { timing: { revealMs: 40, emptyRoomMs: 60_000, finishedRoomMs: 60_000, lobbyRoomMs: 60_000 } } });
  attach(server, hub);
  reservationsRealtime.closeUnknownUpgrades(server, [reservationsRealtime.WS_PATH, ordersRealtime.WS_PATH, WS_PATH]);
  server.listen(0, "127.0.0.1", () => resolve({ server, hub, url: (path) => `ws://127.0.0.1:${server.address().port}${path}` }));
});

const opens = (url, options) => new Promise((resolve) => {
  const ws = new WebSocket(url, options);
  ws.on("open", () => { ws.close(); resolve(true); });
  ws.on("error", () => resolve(false));
});

// Cliente de verdad: junta lo que llega y deja esperar un mensaje que cumpla una condición.
const client = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiting = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    inbox.push(message);
    for (const entry of [...waiting]) {
      if (entry.match(message)) { waiting.splice(waiting.indexOf(entry), 1); entry.resolve(message); }
    }
  });
  ws.on("error", reject);
  ws.on("open", () => resolve({
    ws,
    say: (message) => ws.send(JSON.stringify(message)),
    // Espera un mensaje (ya recibido o por llegar) que cumpla la condición.
    until: (match) => new Promise((done, fail) => {
      const found = inbox.find(match);
      if (found) return done(found);
      const timer = setTimeout(() => fail(new Error("No llegó el mensaje esperado")), 4000);
      waiting.push({ match, resolve: (message) => { clearTimeout(timer); done(message); } });
    }),
  }));
});

const stateIs = (status, round) => (message) =>
  (message.type === "state" || message.type === "joined") && message.state.status === status
  && (round === undefined || message.state.round?.index === round);

test("servidor real: los tres WebSocket (reservas, pedidos y juegos) conectan; un path desconocido no", async (t) => {
  const { server, url } = await listen();
  t.after(() => server.close());
  assert.equal(await opens(url(reservationsRealtime.WS_PATH)), true, "reservas");
  assert.equal(await opens(url(ordersRealtime.WS_PATH)), true, "pedidos (antes lo cortaba el de reservas)");
  assert.equal(await opens(url(WS_PATH)), true, "juegos");
  assert.equal(await opens(url("/api/otra-cosa/ws")), false);
  assert.equal(await opens(url(WS_PATH), { headers: { origin: "https://sitio-ajeno.example" } }), false, "origen no permitido");
  assert.equal(await opens(url(WS_PATH), { headers: { origin: "http://localhost:5173" } }), true);
});

test("servidor real: una partida completa entre dos clientes, con un corte y reconexión en el medio", async (t) => {
  const { server, hub, url } = await listen();
  t.after(() => { hub.rooms.closeAll(); server.close(); });

  const ana = await client(url(WS_PATH));
  ana.say({ type: "create", slug: "mi-bar", name: "Ana" });
  const created = await ana.until((m) => m.type === "joined");
  const code = created.code;

  let beto = await client(url(WS_PATH));
  beto.say({ type: "join", slug: "mi-bar", code, name: "Beto" });
  const betoJoined = await beto.until((m) => m.type === "joined");
  await ana.until((m) => m.type === "state" && m.state.players.length === 2);

  ana.say({ type: "start" });
  const room = hub.rooms.get(code);

  for (let round = 0; round < 3; round += 1) {
    await ana.until(stateIs("question", round));
    await beto.until(stateIs("question", round));
    const correct = right(room);

    if (round === 1) {
      // A Beto se le corta la conexión en plena ronda y vuelve con su token.
      beto.ws.terminate();
      await ana.until((m) => m.type === "state" && m.state.players[1].connected === false);
      beto = await client(url(WS_PATH));
      beto.say({ type: "rejoin", slug: "mi-bar", code, token: betoJoined.playerToken });
      const back = await beto.until((m) => m.type === "joined");
      assert.equal(back.state.round.index, 1);
      assert.equal(back.state.me, 2);
      await ana.until((m) => m.type === "state" && m.state.players[1].connected === true);
    }

    ana.say({ type: "answer", round, option: correct });
    beto.say({ type: "answer", round, option: correct });
    const reveal = await beto.until(stateIs("reveal", round));
    assert.equal(reveal.state.round.correct, correct);
    assert.equal(reveal.state.round.answers.length, 2);
  }

  const end = await beto.until(stateIs("finished"));
  assert.equal(end.state.ranking.length, 2);
  assert.ok(end.state.ranking.every((player) => player.score >= 1500), "los dos acertaron las tres");
  assert.equal((await ana.until(stateIs("finished"))).state.prizeText, "Un café");
  ana.ws.close();
  beto.ws.close();
});
