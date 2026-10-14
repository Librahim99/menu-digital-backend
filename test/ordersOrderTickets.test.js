// Comandas de un pedido para reimprimir desde el panel (menú contextual del
// tablero): GET /orders/:id/tickets → ticketService.listOrderTickets.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startOrdersDb } = require("../test-support/ordersDb");

const OWNER = "64f0000000000000000000aa";
const OTHER = "64f0000000000000000000bb";

const seed = async (db, ownerId, { orderNumber = 1 } = {}) => {
  await db.query(
    "INSERT INTO order_settings (owner_id, general_qr_token) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [ownerId, `qr-${ownerId}`]
  );
  const { rows: [shift] } = await db.query(
    `INSERT INTO shifts (owner_id, label) SELECT $1, 'Turno'
     WHERE NOT EXISTS (SELECT 1 FROM shifts WHERE owner_id = $1 AND closed_at IS NULL)
     RETURNING id`,
    [ownerId]
  );
  const shiftId = shift?.id ?? (await db.query("SELECT id FROM shifts WHERE owner_id = $1", [ownerId])).rows[0].id;
  const { rows: [order] } = await db.query(
    `INSERT INTO orders (owner_id, shift_id, number, source, status, table_number, notes)
     VALUES ($1, $2, $3, 'panel', 'confirmed', 4, 'Sin sal') RETURNING id`,
    [ownerId, shiftId, orderNumber]
  );
  const sector = async (name, printMode) => (await db.query(
    "INSERT INTO order_sectors (owner_id, name, print_mode) VALUES ($1, $2, $3) RETURNING id",
    [ownerId, name, printMode]
  )).rows[0].id;
  return { orderId: order.id, sector };
};

const addTicket = async (db, ownerId, orderId, sectorId, sectorName, status, items) => {
  const { rows: [ticket] } = await db.query(
    "INSERT INTO order_tickets (owner_id, order_id, sector_id, sector_name, status) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [ownerId, orderId, sectorId, sectorName, status]
  );
  for (const [index, item] of items.entries()) {
    await db.query(
      `INSERT INTO order_items (order_id, item_id, title, unit_price, quantity, position, ticket_id)
       VALUES ($1, $2, $3, 1000, $4, $5, $6)`,
      [orderId, `item-${index}`, item.title, item.quantity, index, ticket.id]
    );
  }
  return ticket.id;
};

test("las comandas vigentes del pedido, con sus productos y sin las anuladas", async (t) => {
  const db = await startOrdersDb(t);
  const { orderId, sector } = await seed(db, OWNER);
  const kitchen = await sector("Cocina", "browser");
  const bar = await sector("Barra", "none");
  const dessert = await sector("Postres", "browser");
  await addTicket(db, OWNER, orderId, kitchen, "Cocina", "preparing", [{ title: "Milanesa", quantity: 2 }]);
  await addTicket(db, OWNER, orderId, bar, "Barra", "done", [{ title: "Agua", quantity: 1 }]);
  await addTicket(db, OWNER, orderId, dessert, "Postres", "cancelled", [{ title: "Flan", quantity: 1 }]);

  const tickets = await db.load("services/ticketService").listOrderTickets(OWNER, orderId);

  assert.deepEqual(tickets.map((ticket) => ticket.sectorName), ["Cocina", "Barra"]);
  assert.deepEqual(tickets[0].items, [{ title: "Milanesa", option: null, quantity: 2, notes: null }]);
  assert.equal(tickets[0].order.tableNumber, 4);
  assert.equal(tickets[0].order.notes, "Sin sal");
});

test("no devuelve comandas de pedidos de otro local", async (t) => {
  const db = await startOrdersDb(t);
  const mine = await seed(db, OWNER);
  const kitchen = await mine.sector("Cocina", "browser");
  await addTicket(db, OWNER, mine.orderId, kitchen, "Cocina", "new", [{ title: "Milanesa", quantity: 1 }]);

  const service = db.load("services/ticketService");
  assert.deepEqual(await service.listOrderTickets(OTHER, mine.orderId), []);
});
