const { ReservationsError } = require("../errors");
const { LIMITS } = require("../constants");
const { cleanText, parseDate, parseTime } = require("./validate");

// Máquina de estados de una reserva. Función pura: recibe la reserva actual
// (fila con fecha/hora como texto, ver reservationService.COLUMNS) y devuelve
// las columnas a actualizar. No toca la base ni notifica; eso lo hace el
// service.
//
//   pending ──confirm──▶ confirmed ──complete / no_show──▶ (cierre)
//      │                    │
//      ├──reject──▶ rejected ──(el cliente acepta la alternativa)──▶ pending
//      └──cancel──▶ cancelled ◀──cancel── (pending / confirmed / rejected)

const OWNER_ACTIONS = {
  confirm: { from: ["pending"], to: "confirmed" },
  reject: { from: ["pending", "confirmed"], to: "rejected" },
  cancel: { from: ["pending", "confirmed", "rejected"], to: "cancelled" },
  complete: { from: ["confirmed"], to: "completed" },
  no_show: { from: ["confirmed"], to: "no_show" },
  // El local vuelve a dejar pendiente una reserva rechazada (ej. se liberó una mesa).
  reopen: { from: ["rejected"], to: "pending" },
};

const assertFrom = (reservation, allowed) => {
  if (!allowed.includes(reservation.status)) {
    throw new ReservationsError(409, "La reserva cambió de estado. Actualizá la pantalla.", "INVALID_TRANSITION");
  }
};

/**
 * Acción del local sobre una reserva.
 * @returns {object} columnas a actualizar (snake_case)
 */
const ownerAction = (reservation, action, body = {}) => {
  const rule = OWNER_ACTIONS[action];
  if (!rule) throw new ReservationsError(400, "Acción inválida.");
  assertFrom(reservation, rule.from);

  const message = cleanText(body.message, LIMITS.messageLength, "El mensaje");
  const update = { status: rule.to };

  if (action === "confirm") {
    update.table_label = cleanText(body.tableLabel, LIMITS.tableLabelLength, "La mesa") ?? reservation.table_label ?? null;
    update.message = message;
    update.alt_date = null;
    update.alt_time = null;
  } else if (action === "reject") {
    // Horario alternativo opcional (misma fecha si no se indica otra).
    const altTime = body.altTime ? parseTime(body.altTime, "El horario alternativo") : null;
    const altDate = body.altDate ? parseDate(body.altDate, "La fecha alternativa") : null;
    if (altDate && !altTime) throw new ReservationsError(400, "Indicá también el horario alternativo.");
    const effectiveDate = altDate ?? reservation.reserve_date;
    if (altTime && effectiveDate === reservation.reserve_date && altTime === reservation.reserve_time) {
      throw new ReservationsError(400, "El horario alternativo es el mismo que pidió el cliente.");
    }
    update.alt_time = altTime;
    update.alt_date = altTime ? effectiveDate : null;
    update.message = message;
    update.table_label = null;
  } else if (action === "cancel") {
    // Si el local cancela, el cliente tiene que saber por qué.
    if (!message) throw new ReservationsError(400, "Escribí un mensaje para el cliente explicando la cancelación.", "MESSAGE_REQUIRED");
    update.message = message;
    update.alt_date = null;
    update.alt_time = null;
  } else if (action === "reopen") {
    update.alt_date = null;
    update.alt_time = null;
  }
  return update;
};

/**
 * Acciones del cliente (autenticado con su código de reserva).
 */
const customerAction = (reservation, action) => {
  if (action === "accept_alternative") {
    assertFrom(reservation, ["rejected"]);
    if (!reservation.alt_time) {
      throw new ReservationsError(409, "El local no propuso un horario alternativo.", "NO_ALTERNATIVE");
    }
    return {
      status: "pending",
      reserve_date: reservation.alt_date ?? reservation.reserve_date,
      reserve_time: reservation.alt_time,
      alt_date: null,
      alt_time: null,
      message: null,
      table_label: null,
    };
  }
  if (action === "cancel") {
    assertFrom(reservation, ["pending", "confirmed", "rejected"]);
    // El mensaje anterior del local (ej. el motivo del rechazo) ya no aplica.
    return { status: "cancelled", alt_date: null, alt_time: null, message: null };
  }
  throw new ReservationsError(400, "Acción inválida.");
};

module.exports = { ownerAction, customerAction, OWNER_ACTIONS };
