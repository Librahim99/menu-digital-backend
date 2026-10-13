// Pedidos grupales: varios comensales de una mesa arman un pedido entre todos,
// cada uno desde su celular.
//
// - Una sesión grupal por mesa (group_sessions). La abre un comensal que
//   escaneó el QR del local, o el personal desde la app del operador o el
//   panel. Los demás se suman con el QR / enlace del grupo o tipeando su código.
// - Cada integrante (group_members) carga productos, con su variante y sus
//   aclaraciones, en un carrito común (group_cart_items), y marca si son para
//   él o para compartir.
// - Enviar el carrito crea UN pedido por el camino de siempre
//   (orderService.createOrder): mismo turno, caja, sesión de mesa y comandas,
//   así cocina no nota la diferencia. Cada línea guarda quién la pidió.
//   El carrito se "reclama" dentro de la transacción del alta: si dos personas
//   tocan Enviar a la vez, sale un solo pedido.
// - El pedido se vuelca solo a la cuenta de la mesa (billService): cada
//   integrante pasa a ser un comensal con lo suyo asignado.
// - No hay pagos acá: se registran desde la cuenta, a mano.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { LIMITS } = require("../constants");
const {
  randomToken, hashToken, isTokenShape, randomCode, normalizeCode,
} = require("../utils/tokens");
const { cleanText, positiveInt } = require("../utils/validate");
const { priceOrderLines } = require("./menuCatalog");
const orderService = require("./orderService");
const { withItems } = require("./orderDTO");
const billService = require("./billService");
const realtime = require("../delivery/realtime");

const num = (value) => (value === null || value === undefined ? null : Number(value));

const notify = (ownerId) => realtime.emit({ ownerId, event: "group", staff: true });

const PENDING = "order_id IS NULL AND removed_at IS NULL";

const memberName = (value) => {
  const name = cleanText(value, LIMITS.groupMemberNameLength);
  if (!name) throw new OrdersError(400, "Decinos tu nombre para sumarte al pedido.");
  return name;
};

const toCartItemDTO = (row, memberId = null) => ({
  id: Number(row.id),
  memberId: Number(row.member_id),
  authorName: row.member_name,
  itemId: row.item_id,
  title: row.title,
  option: row.option_name,
  unitPrice: num(row.unit_price),
  quantity: row.quantity,
  notes: row.notes,
  shared: row.shared,
  ...(memberId === null ? {} : { mine: Number(row.member_id) === Number(memberId) }),
});

// Lo que ven de un grupo tanto el personal como sus integrantes.
const loadGroup = async (runner, group, { memberId = null } = {}) => {
  const { rows: members } = await runner.query(
    "SELECT id, name FROM group_members WHERE group_session_id = $1 AND left_at IS NULL ORDER BY id",
    [group.id]
  );
  const { rows: cart } = await runner.query(
    `SELECT c.*, m.name AS member_name FROM group_cart_items c JOIN group_members m ON m.id = c.member_id
     WHERE c.group_session_id = $1 AND c.order_id IS NULL AND c.removed_at IS NULL ORDER BY c.id`,
    [group.id]
  );
  const { rows: sent } = await runner.query(
    `SELECT o.id, o.number, o.status, o.total, o.created_at,
            coalesce((SELECT json_agg(json_build_object('title', i.title, 'option', i.option_name, 'quantity', i.quantity,
                        'authorName', i.author_name, 'shared', i.shared) ORDER BY i.position, i.id)
                      FROM order_items i WHERE i.order_id = o.id AND i.status <> 'cancelled'), '[]'::json) AS items
     FROM orders o WHERE o.group_session_id = $1 ORDER BY o.created_at DESC`,
    [group.id]
  );
  const items = cart.map((row) => toCartItemDTO(row, memberId));
  return {
    id: Number(group.id),
    tableNumber: group.table_number,
    code: group.code,
    joinToken: group.join_token,
    open: !group.closed_at,
    createdAt: group.created_at,
    closedAt: group.closed_at,
    members: members.map((member) => ({
      id: Number(member.id), name: member.name,
      ...(memberId === null ? {} : { me: Number(member.id) === Number(memberId) }),
    })),
    cart: items,
    cartTotal: Math.round(items.reduce((sum, item) => sum + item.unitPrice * item.quantity * 100, 0)) / 100,
    orders: sent.map((order) => ({
      id: Number(order.id), number: order.number, status: order.status, total: num(order.total), createdAt: order.created_at,
      items: order.items,
    })),
  };
};

const findGroup = async (runner, ownerId, groupId, { lock = false } = {}) => {
  const { rows } = await runner.query(
    `SELECT * FROM group_sessions WHERE owner_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [ownerId, groupId]
  );
  if (!rows[0]) throw new OrdersError(404, "Pedido grupal no encontrado.");
  return rows[0];
};

const assertOpen = (group) => {
  if (group.closed_at) throw new OrdersError(409, "Este pedido grupal ya se cerró.", "GROUP_CLOSED");
};

const insertMember = async (client, group, name) => {
  const { rows: [count] } = await client.query(
    "SELECT count(*)::int AS total FROM group_members WHERE group_session_id = $1 AND left_at IS NULL",
    [group.id]
  );
  if (count.total >= LIMITS.groupMembers) {
    throw new OrdersError(409, `El pedido grupal ya tiene ${LIMITS.groupMembers} integrantes.`, "GROUP_FULL");
  }
  const taken = await client.query(
    "SELECT 1 FROM group_members WHERE group_session_id = $1 AND lower(name) = lower($2) AND left_at IS NULL",
    [group.id, name]
  );
  if (taken.rows[0]) {
    throw new OrdersError(409, `Ya hay alguien que se llama ${name} en el pedido. Probá con otro nombre.`, "NAME_TAKEN");
  }
  const token = randomToken(32);
  const { rows } = await client.query(
    "INSERT INTO group_members (group_session_id, owner_id, name, token_hash) VALUES ($1, $2, $3, $4) RETURNING *",
    [group.id, group.owner_id, name, hashToken(token)]
  );
  return { token, member: rows[0] };
};

/**
 * Pedido grupal abierto de la mesa; lo crea si no hay (o si el que había
 * quedó abandonado: viejo y sin mesa abierta). Idempotente: dos personas que
 * lo abren a la vez terminan en el mismo.
 * @param {{ type: "customer"|"waiter"|"panel", name: string|null }} creator
 * @param {string|null} hostName  comensal que lo abre y queda como integrante
 * @returns {{ group: object, memberToken?: string, created: boolean }}
 */
const openGroup = async (ownerId, tableNumber, { creator, hostName = null }) => {
  const name = hostName === null ? null : memberName(hostName);
  const result = await withTransaction(async (client) => {
    // Serializa las aperturas de grupos del local (evita chocar con los UNIQUE).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`orders:group:${ownerId}`]);
    let { rows: [group] } = await client.query(
      "SELECT * FROM group_sessions WHERE owner_id = $1 AND table_number = $2 AND closed_at IS NULL FOR UPDATE",
      [ownerId, tableNumber]
    );
    if (group) {
      const stale = await client.query(
        `SELECT 1 FROM group_sessions g
         WHERE g.id = $1 AND g.created_at < now() - make_interval(secs => $2)
           AND NOT EXISTS (SELECT 1 FROM table_sessions ts
                           WHERE ts.owner_id = g.owner_id AND ts.table_number = g.table_number AND ts.closed_at IS NULL)`,
        [group.id, LIMITS.groupIdleMs / 1000]
      );
      if (stale.rows[0]) {
        await client.query(
          "UPDATE group_sessions SET closed_at = now(), updated_at = now(), closed_reason = 'expired' WHERE id = $1",
          [group.id]
        );
        group = null;
      }
    }

    let created = false;
    if (!group) {
      let code;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        code = randomCode(LIMITS.groupCodeLength);
        const used = await client.query(
          "SELECT 1 FROM group_sessions WHERE owner_id = $1 AND code = $2 AND closed_at IS NULL", [ownerId, code]
        );
        if (!used.rows[0]) break;
        code = null;
      }
      if (!code) throw new OrdersError(503, "No se pudo abrir el pedido grupal. Probá de nuevo.");
      const tableSession = await client.query(
        "SELECT id FROM table_sessions WHERE owner_id = $1 AND table_number = $2 AND closed_at IS NULL",
        [ownerId, tableNumber]
      );
      ({ rows: [group] } = await client.query(
        `INSERT INTO group_sessions (owner_id, table_number, table_session_id, code, join_token, created_by_type, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [ownerId, tableNumber, tableSession.rows[0]?.id ?? null, code, randomToken(24), creator.type, creator.name ?? name]
      ));
      created = true;
    }

    const joined = name ? await insertMember(client, group, name) : null;
    return {
      group: await loadGroup(client, group, { memberId: joined?.member.id ?? null }),
      ...(joined ? { memberToken: joined.token } : {}),
      created,
    };
  });
  notify(ownerId);
  return result;
};

/**
 * Un comensal se suma a un pedido grupal con el código que tipeó o con el
 * token del QR / enlace. El mensaje de error es el mismo si no existe o si
 * ya se cerró (no confirma qué códigos existen).
 */
const joinGroup = async (ownerId, { code = null, joinToken = null, name: rawName }) => {
  const name = memberName(rawName);
  const normalized = code === null ? null : normalizeCode(code, LIMITS.groupCodeLength);
  const token = isTokenShape(joinToken) ? joinToken : null;
  const notFound = () => new OrdersError(404, "No encontramos ese pedido grupal. Revisá el código o pedí el QR de nuevo.", "GROUP_NOT_FOUND");
  if (!normalized && !token) throw notFound();

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM group_sessions WHERE owner_id = $1 AND closed_at IS NULL
         AND ${token ? "join_token = $2" : "code = $2"} FOR UPDATE`,
      [ownerId, token ?? normalized]
    );
    const group = rows[0];
    if (!group) throw notFound();
    const joined = await insertMember(client, group, name);
    return { group: await loadGroup(client, group, { memberId: joined.member.id }), memberToken: joined.token };
  });
  notify(ownerId);
  return result;
};

// Integrante a partir del token de su celular. null si no es válido o se fue.
const authenticateMember = async (token) => {
  if (!isTokenShape(token)) return null;
  const { rows } = await query(
    `UPDATE group_members m SET last_seen_at = now()
     FROM group_sessions g
     WHERE m.token_hash = $1 AND m.left_at IS NULL AND g.id = m.group_session_id
     RETURNING m.id AS member_id, m.name, g.id AS group_id, g.owner_id, g.table_number, g.closed_at`,
    [hashToken(token)]
  );
  const row = rows[0];
  return row
    ? {
      memberId: Number(row.member_id),
      name: row.name,
      groupId: Number(row.group_id),
      ownerId: row.owner_id,
      tableNumber: row.table_number,
      closed: Boolean(row.closed_at),
    }
    : null;
};

const getGroup = async (ownerId, groupId, { memberId = null } = {}) =>
  loadGroup({ query }, await findGroup({ query }, ownerId, groupId), { memberId });

// Pedidos grupales abiertos del local (app del operador y Mesas del panel).
const listOpenGroups = async (ownerId) => {
  const { rows } = await query(
    "SELECT * FROM group_sessions WHERE owner_id = $1 AND closed_at IS NULL ORDER BY table_number",
    [ownerId]
  );
  const groups = [];
  for (const row of rows) groups.push(await loadGroup({ query }, row));
  return groups;
};

/**
 * Agrega productos al carrito del grupo, a nombre del integrante.
 * Se validan contra el menú (mismo control que un pedido) y se guarda su
 * título y precio del momento para mostrarlos.
 * @param {object} owner   User (Mongo) del local
 * @param {Array<{itemId, option, quantity, notes, shared, clientItemId}>} lines  ya validadas (ver parseGroupLines)
 */
const addCartItems = async (owner, member, lines) => {
  const ownerId = String(owner._id);
  const priced = await priceOrderLines(owner, lines);
  await withTransaction(async (client) => {
    const group = await findGroup(client, ownerId, member.groupId, { lock: true });
    assertOpen(group);
    const { rows: [count] } = await client.query(
      `SELECT count(*)::int AS total FROM group_cart_items WHERE group_session_id = $1 AND ${PENDING}`, [group.id]
    );
    if (count.total + lines.length > LIMITS.linesPerOrder) {
      throw new OrdersError(409, `El pedido grupal puede tener hasta ${LIMITS.linesPerOrder} productos distintos. Envialo y seguí en otro.`, "GROUP_CART_FULL");
    }
    for (const [index, line] of priced.lines.entries()) {
      await client.query(
        `INSERT INTO group_cart_items (group_session_id, owner_id, member_id, item_id, title, option_name, unit_price,
           quantity, notes, shared, client_item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (group_session_id, client_item_id) DO NOTHING`,
        [group.id, ownerId, member.memberId, line.itemId, line.title, line.option, line.unitPrice, line.quantity,
          line.notes, lines[index].shared === true, lines[index].clientItemId ?? null]
      );
    }
  });
  notify(ownerId);
  return getGroup(ownerId, member.groupId, { memberId: member.memberId });
};

const findPendingItem = async (client, groupId, itemId) => {
  const { rows } = await client.query(
    `SELECT * FROM group_cart_items WHERE id = $1 AND group_session_id = $2 AND ${PENDING} FOR UPDATE`,
    [itemId, groupId]
  );
  if (!rows[0]) throw new OrdersError(404, "Ese producto ya no está en el pedido del grupo.", "GROUP_ITEM_GONE");
  return rows[0];
};

// Un integrante solo cambia lo que cargó él.
const assertOwnItem = (item, member) => {
  if (Number(item.member_id) !== Number(member.memberId)) {
    throw new OrdersError(403, "Ese producto lo agregó otra persona.", "NOT_YOUR_ITEM");
  }
};

/** Cambia cantidad, aclaración o si es para compartir, de un producto propio. */
const updateCartItem = async (member, itemId, body = {}) => {
  await withTransaction(async (client) => {
    const group = await findGroup(client, member.ownerId, member.groupId, { lock: true });
    assertOpen(group);
    const item = await findPendingItem(client, group.id, itemId);
    assertOwnItem(item, member);
    const quantity = body.quantity === undefined
      ? item.quantity
      : positiveInt(body.quantity, { field: "Cantidad", max: LIMITS.quantityPerLine });
    const notes = body.notes === undefined ? item.notes : cleanText(body.notes, LIMITS.notesLength);
    let shared = item.shared;
    if (body.shared !== undefined) {
      if (typeof body.shared !== "boolean") throw new OrdersError(400, "Indicá si es para compartir.");
      shared = body.shared;
    }
    await client.query(
      "UPDATE group_cart_items SET quantity = $2, notes = $3, shared = $4, updated_at = now() WHERE id = $1",
      [item.id, quantity, notes, shared]
    );
  });
  notify(member.ownerId);
  return getGroup(member.ownerId, member.groupId, { memberId: member.memberId });
};

/** Saca un producto del carrito. `member`: solo lo propio; el personal (member null) saca cualquiera. */
const removeCartItem = async (ownerId, groupId, itemId, { member = null } = {}) => {
  await withTransaction(async (client) => {
    const group = await findGroup(client, ownerId, groupId, { lock: true });
    assertOpen(group);
    const item = await findPendingItem(client, group.id, itemId);
    if (member) assertOwnItem(item, member);
    await client.query("UPDATE group_cart_items SET removed_at = now(), updated_at = now() WHERE id = $1", [item.id]);
  });
  notify(ownerId);
  return getGroup(ownerId, groupId, { memberId: member?.memberId ?? null });
};

const sameCartItem = (a, b) =>
  String(a.id) === String(b.id) && a.quantity === b.quantity && a.option_name === b.option_name
  && a.notes === b.notes && a.shared === b.shared;

/**
 * Envía el carrito del grupo como un pedido de la mesa.
 * @param {object} input
 * @param {object} input.owner     User (Mongo) del local
 * @param {object} input.settings  fila de order_settings
 * @param {number} input.groupId
 * @param {"customer"|"waiter"|"panel"} input.source  quién lo envía
 * @param {{id,name}|null} input.waiter  operador que lo envía
 * @param {number|null} input.waiterSessionId
 * @param {{type,id,name}} input.actor
 * @param {string|null} input.clientRequestId  reintentos del mismo envío = mismo pedido
 * @param {string|null} input.notes
 * @param {number|null} input.memberId  integrante que lo envía (para marcar lo suyo en la respuesta)
 * @returns {{ order, duplicate, group }}
 */
const submitGroup = async ({
  owner, settings, groupId, source, waiter = null, waiterSessionId = null, actor, clientRequestId = null, notes = null,
  memberId = null,
}) => {
  const ownerId = String(owner._id);
  const group = await findGroup({ query }, ownerId, groupId);
  assertOpen(group);
  const { rows: pending } = await query(
    `SELECT * FROM group_cart_items WHERE group_session_id = $1 AND ${PENDING} ORDER BY id`, [group.id]
  );

  if (pending.length === 0) {
    // Reintento de un envío que ya salió: el carrito está vacío pero el pedido existe.
    const { rows } = clientRequestId
      ? await query(
        "SELECT * FROM orders WHERE owner_id = $1 AND client_request_id = $2 AND group_session_id = $3",
        [ownerId, clientRequestId, group.id]
      )
      : { rows: [] };
    if (!rows[0]) throw new OrdersError(409, "El pedido del grupo está vacío.", "GROUP_CART_EMPTY");
    return {
      order: (await withItems(rows))[0], duplicate: true, group: await getGroup(ownerId, group.id, { memberId }),
    };
  }

  const lines = pending.map((item) => ({
    itemId: item.item_id, option: item.option_name, quantity: item.quantity, notes: item.notes,
  }));

  // Corre dentro de la transacción del alta, con el pedido ya insertado.
  const onCreated = async (client, order, tableSession) => {
    // Con el grupo bloqueado nadie puede tocar el carrito (todo cambio lo bloquea).
    const locked = await findGroup(client, ownerId, group.id, { lock: true });
    assertOpen(locked);
    // El carrito tiene que seguir igual a como se leyó para armar el pedido. Si
    // otro envío ya se lo llevó, o alguien lo cambió recién, el alta se deshace.
    const { rows: current } = await client.query(
      `SELECT * FROM group_cart_items WHERE group_session_id = $1 AND ${PENDING} ORDER BY id`, [group.id]
    );
    if (current.length !== pending.length || current.some((row, index) => !sameCartItem(row, pending[index]))) {
      throw new OrdersError(409, "El pedido del grupo cambió recién. Revisalo y envialo de nuevo.", "GROUP_CART_CHANGED");
    }
    await client.query(
      "UPDATE group_cart_items SET order_id = $2, updated_at = now() WHERE id = ANY($1)",
      [pending.map((item) => item.id), order.id]
    );

    const { rows: members } = await client.query(
      "SELECT id, name FROM group_members WHERE group_session_id = $1 ORDER BY id", [group.id]
    );
    const nameOf = new Map(members.map((member) => [String(member.id), member.name]));
    const { rows: orderLines } = await client.query(
      "SELECT id, position FROM order_items WHERE order_id = $1 ORDER BY position, id", [order.id]
    );
    // Las líneas del pedido conservan el orden del carrito (position = índice).
    const billLines = [];
    for (const line of orderLines) {
      const item = pending[line.position];
      await client.query(
        "UPDATE order_items SET group_member_id = $2, author_name = $3, shared = $4 WHERE id = $1",
        [line.id, item.member_id, nameOf.get(String(item.member_id)) ?? null, item.shared]
      );
      billLines.push({ orderItemId: line.id, memberId: item.member_id, shared: item.shared });
    }
    await client.query("UPDATE orders SET group_session_id = $2 WHERE id = $1", [order.id, group.id]);
    await client.query(
      "UPDATE group_sessions SET table_session_id = $2, updated_at = now() WHERE id = $1",
      [group.id, tableSession.id]
    );

    const active = await client.query(
      "SELECT id, name FROM group_members WHERE group_session_id = $1 AND left_at IS NULL ORDER BY id", [group.id]
    );
    // Quien pidió algo y después salió del grupo igual figura en la cuenta.
    const authors = members.filter((member) => billLines.some((line) => String(line.memberId) === String(member.id)));
    const billMembers = [...new Map([...active.rows, ...authors].map((member) => [String(member.id), member])).values()];
    await billService.attachGroupOrder(client, {
      session: tableSession, order, lines: billLines, members: billMembers, actor,
    });
  };

  const { order, duplicate } = await orderService.createOrder({
    owner,
    settings,
    source,
    lines,
    serviceType: "table",
    tableNumber: group.table_number,
    waiter,
    waiterSessionId,
    notes,
    clientRequestId,
    actor,
    onCreated,
  });
  notify(ownerId);
  return { order, duplicate, group: await getGroup(ownerId, group.id, { memberId }) };
};

// Un integrante se va: lo que tenía en el carrito sin enviar se saca.
const leaveGroup = async (member) => {
  await withTransaction(async (client) => {
    await findGroup(client, member.ownerId, member.groupId, { lock: true });
    await client.query(
      `UPDATE group_cart_items SET removed_at = now(), updated_at = now()
       WHERE group_session_id = $1 AND member_id = $2 AND ${PENDING}`,
      [member.groupId, member.memberId]
    );
    await client.query("UPDATE group_members SET left_at = now() WHERE id = $1 AND left_at IS NULL", [member.memberId]);
  });
  notify(member.ownerId);
};

// El personal cierra el pedido grupal (la mesa sigue abierta). Lo que quedó sin enviar se descarta.
const closeGroup = async (ownerId, groupId) => {
  await withTransaction(async (client) => {
    const group = await findGroup(client, ownerId, groupId, { lock: true });
    if (group.closed_at) return;
    await client.query(
      "UPDATE group_sessions SET closed_at = now(), updated_at = now(), closed_reason = 'staff' WHERE id = $1",
      [group.id]
    );
  });
  notify(ownerId);
  return getGroup(ownerId, groupId);
};

module.exports = {
  openGroup,
  joinGroup,
  authenticateMember,
  getGroup,
  listOpenGroups,
  addCartItems,
  updateCartItem,
  removeCartItem,
  submitGroup,
  leaveGroup,
  closeGroup,
};
