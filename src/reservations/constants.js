const STATUSES = ["pending", "confirmed", "rejected", "cancelled", "completed", "no_show"];

const LIMITS = {
  nameLength: 60,
  phoneLength: 30,
  notesLength: 300,
  messageLength: 300,
  tableLabelLength: 30,
  // Tope de reservas "abiertas" (pendientes + rechazadas esperando respuesta)
  // por local: frena una inundación de pedidos falsos desde la landing.
  openPerOwner: 300,
  // Reservas que devuelve el listado del panel.
  listMax: 500,
};

const PHONE_MODES = ["off", "optional", "required"];

module.exports = { STATUSES, LIMITS, PHONE_MODES };
