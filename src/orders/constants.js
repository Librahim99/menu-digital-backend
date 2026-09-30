// Reglas de negocio de Gestión de pedidos.

const ORDER_STATUSES = ["pending", "confirmed", "ready", "delivered", "cancelled", "returned"];

// Estados que siguen en el panel. Al entregar (o cancelar) el pedido deja
// de verse ahí y queda solo en el historial.
const ACTIVE_STATUSES = ["pending", "confirmed", "ready"];

// Transiciones permitidas. Un pedido sin confirmar no pasa a "listo": primero
// se confirma (así nadie empieza a preparar algo que no se aceptó).
const STATUS_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["ready", "delivered", "cancelled", "pending"],
  ready: ["delivered", "confirmed", "cancelled"],
  delivered: ["returned", "ready"],
  cancelled: ["pending"],
  returned: [],
};

// Columna de fecha que se completa al pasar a cada estado.
const STATUS_TIMESTAMPS = {
  confirmed: "confirmed_at",
  ready: "ready_at",
  delivered: "delivered_at",
  cancelled: "cancelled_at",
  returned: "returned_at",
};

// Estados que no suman a la venta del turno.
const NOT_BILLED_STATUSES = ["cancelled", "returned"];

// Dónde se sirve el pedido. Solo "table" lleva número de mesa (y sesión de
// mesa); take away y delivery pueden llevar datos de quien retira / recibe.
const SERVICE_TYPES = ["table", "counter", "takeaway", "delivery"];

// Comandas: estados de la parte de un pedido que prepara un sector y los
// cambios que puede hacer el sector (anular es cosa del pedido).
const TICKET_STATUSES = ["new", "preparing", "done", "cancelled"];
const TICKET_TRANSITIONS = {
  new: ["preparing", "done"],
  preparing: ["done", "new"],
  done: ["preparing"],
  cancelled: [],
};

// Cómo imprime un sector sus comandas (ver migración 003).
const PRINT_MODES = ["none", "browser", "escpos"];
const PAPER_WIDTHS = [58, 80];

const LIMITS = {
  linesPerOrder: 40,
  quantityPerLine: 20,
  notesLength: 140,
  orderNotesLength: 200,
  waiterNameLength: 60,
  shiftsInSchedule: 6,
  maxTables: 300,
  // Anti bots: un dispositivo no puede mandar otro pedido antes de esto…
  customerCooldownMs: 30_000,
  // …ni repetir el mismo contenido dentro de esta ventana.
  duplicateWindowMs: 3 * 60_000,
  // Vigencia del código del QR de acceso de un operador.
  pairingCodeTtlMs: 2 * 60_000,
  customerNameLength: 60,
  customerPhoneLength: 30,
  deliveryAddressLength: 200,
  deliveryNotesLength: 200,
  statusReasonLength: 200,
  cashierNameLength: 60,
  registerNameLength: 40,
  maxGuests: 200,
  sectorNameLength: 40,
  maxSectors: 12,
  // El código de un sector se tipea (puede ser una PC): más vida que el QR.
  sectorPairingTtlMs: 10 * 60_000,
  // Comandas preparadas o anuladas que el sector sigue viendo (para consultar).
  recentTicketsWindowMs: 2 * 60 * 60_000,
  recentTicketsLimit: 20,
};

module.exports = {
  ORDER_STATUSES,
  ACTIVE_STATUSES,
  STATUS_TRANSITIONS,
  STATUS_TIMESTAMPS,
  NOT_BILLED_STATUSES,
  SERVICE_TYPES,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  PRINT_MODES,
  PAPER_WIDTHS,
  LIMITS,
};
