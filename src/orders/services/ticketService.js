// Comandas: la parte de un pedido confirmado que prepara cada sector.
//
// - Al confirmar un pedido (o al crearlo ya confirmado, desde el operador o
//   el panel) sus líneas se reparten por sector y se crea una comanda por
//   sector. Sin sectores no se crea nada.
// - Anularlo o volverlo a "sin confirmar" anula sus comandas (el sector ve
//   "ANULADA" y deja de prepararla). Al reconfirmarlo vuelven a "nueva" y se
//   vuelven a imprimir.
// - El sector marca su comanda "en preparación" y "lista". Que el pedido
//   entero esté listo lo sigue indicando el panel de pedidos, que ve el
//   avance de cada sector.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { ACTIVE_STATUSES, TICKET_TRANSITIONS, LIMITS } = require("../constants");
const { loadRouting } = require("./sectorService");
const { groupLinesBySector } = require("../utils/sectorRouting");
const realtime = require("../delivery/realtime");

// Línea que sigue en el pedido (no se quitó). Lee la columna vía to_jsonb para
// que estas consultas funcionen también sin la migración 008 aplicada.
const ACTIVE_LINE = (alias) => `coalesce(to_jsonb(${alias}) ->> 'status', 'active') <> 'cancelled'`;

/**
 * Crea las comandas que falten para un pedido y reactiva las anuladas.
 * Corre dentro de la transacción del cambio de estado.
 * Las líneas que ya están en una comanda no se vuelven a repartir.
 */
const issueTickets = async (client, { ownerId, orderId }) => {
  const { sectors, routing } = await loadRouting(client, ownerId);
  if (!routing) return;

  const { rows: pending } = await client.query(
    `SELECT id, item_id, category_id, section_id FROM order_items
     WHERE order_id = $1 AND ticket_id IS NULL AND ${ACTIVE_LINE("order_items")} ORDER BY position, id`,
    [orderId]
  );
  const lines = pending.map((row) => ({
    id: row.id, itemId: row.item_id, categoryId: row.category_id, sectionId: row.section_id,
  }));
  const nameOf = new Map(sectors.map((sector) => [Number(sector.id), sector.name]));

  for (const [sectorId, group] of groupLinesBySector(lines, routing)) {
    const { rows: [ticket] } = await client.query(
      `INSERT INTO order_tickets (owner_id, order_id, sector_id, sector_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id, sector_id) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [ownerId, orderId, sectorId, nameOf.get(sectorId)]
    );
    await client.query(
      "UPDATE order_items SET ticket_id = $1 WHERE id = ANY($2)",
      [ticket.id, group.map((line) => line.id)]
    );
  }

  // Reconfirmado: lo anulado vuelve a entrar como nuevo (y a imprimirse), salvo
  // la comanda a la que no le quedó ningún producto (se quitaron todos).
  await client.query(
    `UPDATE order_tickets SET status = 'new', cancelled_at = NULL, started_at = NULL, done_at = NULL,
       printed_at = NULL, updated_at = now()
     WHERE order_id = $1 AND status = 'cancelled'
       AND EXISTS (SELECT 1 FROM order_items i WHERE i.ticket_id = order_tickets.id AND ${ACTIVE_LINE("i")})`,
    [orderId]
  );
};

const cancelTickets = (client, orderId) =>
  client.query(
    `UPDATE order_tickets SET status = 'cancelled', cancelled_at = now(), updated_at = now()
     WHERE order_id = $1 AND status <> 'cancelled'`,
    [orderId]
  );

// Se quitaron productos del pedido: la comanda que quedó sin nada que preparar
// se anula (el sector ve "ANULADA"); las demás siguen con lo que les queda.
const cancelEmptyTickets = (client, orderId) =>
  client.query(
    `UPDATE order_tickets SET status = 'cancelled', cancelled_at = now(), updated_at = now()
     WHERE order_id = $1 AND status <> 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.ticket_id = order_tickets.id AND ${ACTIVE_LINE("i")})`,
    [orderId]
  );

/**
 * Lo que le pasa a las comandas cuando el pedido cambia de estado.
 * @param {object} client  transacción en curso
 */
const syncTicketsWithOrder = async (client, { ownerId, orderId, from, to }) => {
  if (to === "confirmed" && (from === null || from === "pending" || from === "cancelled")) {
    await issueTickets(client, { ownerId, orderId });
  } else if (to === "cancelled" || to === "pending") {
    await cancelTickets(client, orderId);
  }
};

// ── Pantalla del sector ──────────────────────

const toTicketDTO = (row, items = [], removedItems = []) => ({
  id: Number(row.id),
  orderId: Number(row.order_id),
  sectorId: Number(row.sector_id),
  sectorName: row.sector_name,
  status: row.status,
  createdAt: row.created_at,
  startedAt: row.started_at,
  doneAt: row.done_at,
  cancelledAt: row.cancelled_at,
  printedAt: row.printed_at,
  printCount: row.print_count,
  // Del pedido: lo que el sector necesita para saber adónde va.
  order: {
    number: row.order_number,
    status: row.order_status,
    serviceType: row.service_type,
    tableNumber: row.table_number,
    customerName: row.customer_name ?? null,
    waiterName: row.waiter_name ?? null,
    notes: row.order_notes ?? null,
    createdAt: row.order_created_at,
  },
  // Sin precios: al sector no le hacen falta.
  items,
  // Productos que el local quitó del pedido: el sector ya no los prepara.
  removedItems,
});

const SELECT_TICKETS = `
  SELECT t.*, o.number AS order_number, o.status AS order_status, o.service_type, o.table_number,
         o.customer_name, o.waiter_name, o.notes AS order_notes, o.created_at AS order_created_at
  FROM order_tickets t JOIN orders o ON o.id = t.order_id`;

const withTicketItems = async (rows) => {
  if (rows.length === 0) return [];
  const { rows: items } = await query(
    `SELECT ticket_id, title, option_name, quantity, notes, to_jsonb(order_items) ->> 'status' AS line_status
     FROM order_items
     WHERE ticket_id = ANY($1) ORDER BY ticket_id, position, id`,
    [rows.map((row) => row.id)]
  );
  const byTicket = new Map();
  const removedByTicket = new Map();
  for (const item of items) {
    const key = String(item.ticket_id);
    const target = item.line_status === "cancelled" ? removedByTicket : byTicket;
    if (!target.has(key)) target.set(key, []);
    target.get(key).push({ title: item.title, option: item.option_name, quantity: item.quantity, notes: item.notes });
  }
  return rows.map((row) => toTicketDTO(row, byTicket.get(String(row.id)) ?? [], removedByTicket.get(String(row.id)) ?? []));
};

/**
 * Comandas del sector: las que tiene que preparar (de pedidos que siguen
 * activos) y las últimas preparadas o anuladas, para consultar.
 */
const listSectorTickets = async (ownerId, sectorId) => {
  const [active, recent] = await Promise.all([
    query(
      `${SELECT_TICKETS}
       WHERE t.owner_id = $1 AND t.sector_id = $2 AND t.status IN ('new', 'preparing') AND o.status = ANY($3)
       ORDER BY t.created_at`,
      [ownerId, sectorId, ACTIVE_STATUSES]
    ),
    query(
      `${SELECT_TICKETS}
       WHERE t.owner_id = $1 AND t.sector_id = $2 AND t.status IN ('done', 'cancelled')
         AND t.updated_at > now() - make_interval(secs => $3)
       ORDER BY t.updated_at DESC LIMIT ${Number(LIMITS.recentTicketsLimit)}`,
      [ownerId, sectorId, LIMITS.recentTicketsWindowMs / 1000]
    ),
  ]);
  const [tickets, recentTickets] = await Promise.all([withTicketItems(active.rows), withTicketItems(recent.rows)]);
  return { tickets, recent: recentTickets };
};

const TICKET_TIMESTAMPS = { preparing: "started_at", done: "done_at" };

const getSectorTicket = async (runner, ownerId, sectorId, ticketId, { lock = false } = {}) => {
  const { rows } = await runner.query(
    `SELECT * FROM order_tickets WHERE owner_id = $1 AND sector_id = $2 AND id = $3${lock ? " FOR UPDATE" : ""}`,
    [ownerId, sectorId, ticketId]
  );
  if (!rows[0]) throw new OrdersError(404, "Comanda no encontrada.");
  return rows[0];
};

const readTicket = async (ticketId) => {
  const { rows } = await query(`${SELECT_TICKETS} WHERE t.id = $1`, [ticketId]);
  return (await withTicketItems(rows))[0];
};

// El sector avanza (o deshace) su comanda.
const updateTicketStatus = async (ownerId, sectorId, ticketId, status) => {
  if (!["new", "preparing", "done"].includes(status)) throw new OrdersError(400, "Estado inválido.");
  await withTransaction(async (client) => {
    const ticket = await getSectorTicket(client, ownerId, sectorId, ticketId, { lock: true });
    if (ticket.status === status) return;
    if (!TICKET_TRANSITIONS[ticket.status].includes(status)) {
      throw new OrdersError(409, ticket.status === "cancelled"
        ? "Este pedido se anuló: la comanda ya no se prepara."
        : "Ese cambio no es posible para esta comanda.");
    }
    const sets = ["status = $2", "updated_at = now()"];
    const column = TICKET_TIMESTAMPS[status];
    if (column) sets.push(`${column} = now()`);
    // Deshacer "lista" o "en preparación" limpia la marca que se deshizo.
    if (status !== "done") sets.push("done_at = NULL");
    if (status === "new") sets.push("started_at = NULL");
    await client.query(`UPDATE order_tickets SET ${sets.join(", ")} WHERE id = $1`, [ticketId, status]);
  });
  // El panel ve el avance del sector y los otros equipos del sector, el cambio.
  realtime.emit({ ownerId, event: "ticket", staff: true });
  return readTicket(ticketId);
};

// El dispositivo del sector avisa que la imprimió.
const markPrinted = async (ownerId, sectorId, ticketId) => {
  await getSectorTicket({ query }, ownerId, sectorId, ticketId);
  await query(
    "UPDATE order_tickets SET printed_at = now(), print_count = print_count + 1 WHERE id = $1",
    [ticketId]
  );
  // Con dos equipos en el sector, el otro deja de intentar imprimirla.
  realtime.emit({ ownerId, event: "ticket", staff: true });
  return readTicket(ticketId);
};

module.exports = {
  issueTickets,
  cancelTickets,
  cancelEmptyTickets,
  syncTicketsWithOrder,
  listSectorTickets,
  updateTicketStatus,
  markPrinted,
};
