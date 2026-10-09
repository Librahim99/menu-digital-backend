// Delivery / Envíos: asignación de pedidos a repartidores, retiro, entrega con
// código de 6 dígitos, reasignaciones y las consultas de cada panel.
//
// Reglas que este módulo hace cumplir (siempre en el backend, sea cual sea la
// pantalla que lo pida):
//  · Solo los pedidos de delivery entran al circuito, y solo confirmados o listos.
//  · Un pedido tiene a lo sumo UNA asignación activa (índice único parcial en SQL +
//    el pedido bloqueado FOR UPDATE: dos repartidores tomándolo a la vez no pueden
//    quedarse los dos).
//  · Retirar exige pedido listo y asignación propia; genera el código de entrega
//    (una sola vez, idempotente) y registra la salida (`orders.dispatched_at`).
//  · Entregar exige el código del cliente (o, si el local lo permite, el
//    administrador con motivo). El código es de un solo uso y tiene tope de intentos.
//  · Todo cambio relevante queda en `delivery_events` con quién, cuándo y por qué.
//  · Los avisos de tiempo real salen después del COMMIT (nunca antes).
//
// Lock order (evita deadlocks): primero la fila del pedido, después la asignación.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { LIMITS } = require("../constants");
const { optionsOf } = require("../services/settingsService");
const { toOrderDTO, withItems } = require("../services/orderDTO");
const { cleanText } = require("../utils/validate");
const secrets = require("./secrets");
const realtime = require("./realtime");

// Pedidos que pueden entrar al circuito de reparto.
const ASSIGNABLE_STATUSES = ["confirmed", "ready"];
const ACTIVE_ASSIGNMENT = ["assigned", "picked_up"];

// Intentos de código: cada 5 errores seguidos de un pedido se bloquea el código
// 15 minutos (1.000.000 de combinaciones: no se adivina con 5 intentos cada 15 min).
const MAX_CODE_ATTEMPTS = 5;
const CODE_LOCK_MS = 15 * 60_000;

// ── Configuración ────────────────────────────

const deliveryConfig = (settings) => {
  const options = optionsOf(settings);
  return {
    enabled: options.deliveryEnabled === true,
    assignMode: options.deliveryAssignMode,
    confirmBy: options.deliveryConfirmBy,
    adminOverride: options.deliveryAdminOverride === true,
  };
};

const requireEnabled = (settings) => {
  if (!deliveryConfig(settings).enabled) {
    throw new OrdersError(409, "El delivery con repartidores no está activado en este local.", "DELIVERY_DISABLED");
  }
};

// ── Auditoría ────────────────────────────────

const recordEvent = (client, {
  ownerId, orderId, assignmentId = null, type, actor, fromCourierId = null, toCourierId = null, reason = null,
}) =>
  client.query(
    `INSERT INTO delivery_events (owner_id, order_id, assignment_id, event_type, actor_type, actor_id, actor_name,
       from_courier_id, to_courier_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [ownerId, orderId, assignmentId, type, actor?.type ?? "system", actor?.id == null ? null : String(actor.id),
      actor?.name ?? null, fromCourierId, toCourierId, reason]
  );

const panelActor = (ownerId) => ({ type: "panel", id: ownerId, name: "Panel" });
const courierActor = (session) => ({ type: "courier", id: session.courierId, name: session.name });

const requireReason = (value, message) => {
  const reason = cleanText(value, LIMITS.statusReasonLength);
  if (!reason || reason.length < 3) throw new OrdersError(400, message, "REASON_REQUIRED");
  return reason;
};

// ── Lecturas base (con bloqueo opcional) ─────

const findActiveAssignment = async (runner, orderId, { lock = false } = {}) => {
  const { rows } = await runner.query(
    `SELECT * FROM delivery_assignments WHERE order_id = $1 AND status = ANY($2)${lock ? " FOR UPDATE" : ""}`,
    [orderId, ACTIVE_ASSIGNMENT]
  );
  return rows[0] ?? null;
};

const lockDeliveryOrder = async (client, ownerId, orderId) => {
  const { rows } = await client.query(
    "SELECT * FROM orders WHERE owner_id = $1 AND id = $2 FOR UPDATE",
    [ownerId, orderId]
  );
  const order = rows[0];
  // El filtro por owner_id evita tocar pedidos de otro local cambiando el id.
  if (!order) throw new OrdersError(404, "Pedido no encontrado.");
  if (order.service_type !== "delivery") {
    throw new OrdersError(409, "Solo los pedidos de delivery pasan por repartidores.", "NOT_DELIVERY");
  }
  return order;
};

const insertAssignment = async (client, { ownerId, order, courier, via, by, inherit = null }) => {
  const { rows } = await client.query(
    `INSERT INTO delivery_assignments (owner_id, order_id, courier_id, courier_name, status, assigned_via, assigned_by,
       picked_up_at, code_hash, code_encrypted, code_issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [ownerId, order.id, courier.id, courier.name, inherit ? "picked_up" : "assigned", via, by,
      inherit?.picked_up_at ?? null, inherit?.code_hash ?? null, inherit?.code_encrypted ?? null, inherit?.code_issued_at ?? null]
  );
  return rows[0];
};

const releaseAssignment = (client, assignment, reason) =>
  client.query(
    `UPDATE delivery_assignments SET status = 'released', released_at = now(), release_reason = $2, updated_at = now()
     WHERE id = $1`,
    [assignment.id, reason]
  );

// ── Asignación ───────────────────────────────

/**
 * El administrador asigna (o reasigna) un pedido a un repartidor.
 * Reasignar un pedido ya retirado exige motivo; el nuevo responsable hereda la
 * salida y el código (que pertenece al pedido, no al repartidor).
 */
const assignOrder = async (ownerId, orderId, { courierId, force = false, reason = null, settings }) => {
  requireEnabled(settings);
  const events = [];
  const { assignment, order } = await withTransaction(async (client) => {
    const order = await lockDeliveryOrder(client, ownerId, orderId);
    if (!ASSIGNABLE_STATUSES.includes(order.status)) {
      throw new OrdersError(409, "Solo se asignan pedidos confirmados o listos.", "NOT_ASSIGNABLE");
    }
    const { rows } = await client.query(
      "SELECT * FROM couriers WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL",
      [ownerId, courierId]
    );
    const courier = rows[0];
    if (!courier) throw new OrdersError(404, "Repartidor no encontrado.");
    if (!courier.active) throw new OrdersError(409, "El repartidor está pausado.", "COURIER_INACTIVE");

    const current = await findActiveAssignment(client, order.id, { lock: true });
    if (current && String(current.courier_id) === String(courier.id)) return { assignment: current, order };
    if (!courier.available && !force) {
      throw new OrdersError(409, `${courier.name} no está disponible ahora. Elegí a otro o asignalo igual.`, "COURIER_UNAVAILABLE");
    }

    let cleanReason = cleanText(reason, LIMITS.statusReasonLength);
    let inherit = null;
    if (current) {
      if (current.status === "picked_up") {
        cleanReason = requireReason(reason, "Indicá el motivo de reasignar un pedido que ya salió.");
        inherit = current;
      }
      await releaseAssignment(client, current, "reassigned");
    }
    const assignment = await insertAssignment(client, { ownerId, order, courier, via: "manual", by: "Panel", inherit });
    await recordEvent(client, {
      ownerId, orderId: order.id, assignmentId: assignment.id, type: current ? "reassigned" : "assigned",
      actor: panelActor(ownerId), fromCourierId: current?.courier_id ?? null, toCourierId: courier.id, reason: cleanReason,
    });
    events.push({
      event: current ? "reassigned" : "assigned", orderId: Number(order.id), orderNumber: order.number,
      courierIds: [current?.courier_id, courier.id].map((id) => (id == null ? null : Number(id))), openList: true, customer: !!inherit,
    });
    return { assignment, order };
  });
  for (const event of events) realtime.emit({ ownerId, ...event });
  return toAssignmentDTO(assignment, order);
};

/**
 * El repartidor toma un pedido de la lista compartida (modo abierto).
 * Atómico: el pedido se bloquea, se verifica que nadie lo tenga y el índice único
 * parcial de SQL cierra cualquier carrera restante.
 */
const claimOrder = async (session, orderId, { settings }) => {
  requireEnabled(settings);
  if (deliveryConfig(settings).assignMode !== "open") {
    throw new OrdersError(409, "Este local asigna los pedidos a mano.", "OPEN_MODE_OFF");
  }
  const ownerId = session.ownerId;
  const events = [];
  const assignment = await withTransaction(async (client) => {
    const order = await lockDeliveryOrder(client, ownerId, orderId);
    const { rows } = await client.query(
      "SELECT * FROM couriers WHERE owner_id = $1 AND id = $2 AND active AND deleted_at IS NULL",
      [ownerId, session.courierId]
    );
    const courier = rows[0];
    if (!courier) throw new OrdersError(403, "Tu acceso ya no es válido.", "COURIER_INACTIVE");
    if (!courier.available) {
      throw new OrdersError(409, "Marcate como disponible para tomar pedidos.", "COURIER_UNAVAILABLE");
    }
    const current = await findActiveAssignment(client, order.id, { lock: true });
    if (current) {
      // Reintento del mismo repartidor: mismo resultado, sin duplicar nada.
      if (String(current.courier_id) === String(session.courierId)) return current;
      throw new OrdersError(409, "Otro repartidor ya tomó este pedido.", "ALREADY_TAKEN");
    }
    if (!ASSIGNABLE_STATUSES.includes(order.status)) {
      throw new OrdersError(409, "Este pedido ya no está disponible.", "NOT_ASSIGNABLE");
    }
    let assignment;
    try {
      assignment = await insertAssignment(client, { ownerId, order, courier, via: "open", by: courier.name });
    } catch (error) {
      if (error.code === "23505") throw new OrdersError(409, "Otro repartidor ya tomó este pedido.", "ALREADY_TAKEN");
      throw error;
    }
    await recordEvent(client, {
      ownerId, orderId: order.id, assignmentId: assignment.id, type: "assigned", actor: courierActor(session),
      toCourierId: courier.id,
    });
    events.push({ event: "assigned", orderId: Number(order.id), orderNumber: order.number, courierIds: [session.courierId], openList: true });
    return assignment;
  });
  for (const event of events) realtime.emit({ ownerId, ...event });
  return assignment;
};

/** El administrador le saca el pedido a su repartidor (vuelve a estar sin asignar). */
const unassignOrder = async (ownerId, orderId, { reason = null }) => {
  const events = [];
  await withTransaction(async (client) => {
    const order = await lockDeliveryOrder(client, ownerId, orderId);
    const current = await findActiveAssignment(client, order.id, { lock: true });
    if (!current) throw new OrdersError(409, "Este pedido no tiene repartidor asignado.", "NOT_ASSIGNED");
    const cleanReason = current.status === "picked_up"
      ? requireReason(reason, "Indicá el motivo de quitar un pedido que ya salió.")
      : cleanText(reason, LIMITS.statusReasonLength);
    await releaseAssignment(client, current, "unassigned");
    // Sale de "en camino": el código deja de valer (la asignación ya no está activa).
    if (current.status === "picked_up") {
      await client.query("UPDATE orders SET dispatched_at = NULL, updated_at = now() WHERE id = $1", [order.id]);
    }
    await recordEvent(client, {
      ownerId, orderId: order.id, assignmentId: current.id, type: "unassigned", actor: panelActor(ownerId),
      fromCourierId: current.courier_id, reason: cleanReason,
    });
    events.push({
      event: "unassigned", orderId: Number(order.id), orderNumber: order.number, courierIds: [Number(current.courier_id)],
      openList: true, customer: current.status === "picked_up",
    });
  });
  for (const event of events) realtime.emit({ ownerId, ...event });
};

/**
 * Pasa todas las entregas activas de un repartidor a otro (desactivarlo con
 * `reassignTo`). Corre dentro de la transacción del caller y devuelve los avisos
 * para emitir después del COMMIT.
 */
const reassignAll = async (client, ownerId, { fromCourier, toCourierId }) => {
  if (String(toCourierId) === String(fromCourier.id)) {
    throw new OrdersError(400, "Elegí otro repartidor para reasignar.");
  }
  const { rows: [target] } = await client.query(
    "SELECT * FROM couriers WHERE owner_id = $1 AND id = $2 AND active AND deleted_at IS NULL",
    [ownerId, toCourierId]
  );
  if (!target) throw new OrdersError(409, "El repartidor elegido para reasignar no está activo.", "COURIER_INACTIVE");
  const { rows: pending } = await client.query(
    `SELECT a.*, o.number AS order_number FROM delivery_assignments a JOIN orders o ON o.id = a.order_id
     WHERE a.courier_id = $1 AND a.status = ANY($2) ORDER BY a.id FOR UPDATE OF a`,
    [fromCourier.id, ACTIVE_ASSIGNMENT]
  );
  const events = [];
  for (const current of pending) {
    await releaseAssignment(client, current, "reassigned");
    const inherit = current.status === "picked_up" ? current : null;
    const next = await insertAssignment(client, { ownerId, order: { id: current.order_id }, courier: target, via: "manual", by: "Panel", inherit });
    await recordEvent(client, {
      ownerId, orderId: current.order_id, assignmentId: next.id, type: "reassigned", actor: panelActor(ownerId),
      fromCourierId: fromCourier.id, toCourierId: target.id, reason: "Repartidor desactivado",
    });
    events.push({
      event: "reassigned", orderId: Number(current.order_id), orderNumber: current.order_number,
      courierIds: [Number(fromCourier.id), Number(target.id)], openList: true,
    });
  }
  return events;
};

/**
 * Al apagar Delivery: lo que todavía no se retiró vuelve a "sin asignar" (el
 * local pasa a gestionarlo por fuera) y lo que ya salió se puede terminar de
 * entregar (con el código, o el administrador con motivo). Nada queda en un
 * estado intermedio y no se pierde historial.
 */
const releasePendingOnDisable = async (ownerId) => {
  const events = [];
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT a.*, o.number AS order_number FROM delivery_assignments a JOIN orders o ON o.id = a.order_id
       WHERE a.owner_id = $1 AND a.status = 'assigned' ORDER BY a.id FOR UPDATE OF a`,
      [ownerId]
    );
    for (const current of rows) {
      await releaseAssignment(client, current, "delivery_disabled");
      await recordEvent(client, {
        ownerId, orderId: current.order_id, assignmentId: current.id, type: "released", actor: { type: "system", name: "Sistema" },
        fromCourierId: current.courier_id, reason: "Delivery desactivado",
      });
      events.push({ event: "released", orderId: Number(current.order_id), orderNumber: current.order_number, courierIds: [Number(current.courier_id)], openList: true });
    }
  });
  for (const event of events) realtime.emit({ ownerId, ...event });
  realtime.emit({ ownerId, event: "settings", openList: true });
  return events.length;
};

// ── Retiro y entrega ─────────────────────────

/** Nunca el repartidor equivocado: la asignación se busca por pedido + repartidor autenticado. */
const ownAssignment = async (client, session, orderId) => {
  const { rows } = await client.query(
    "SELECT * FROM delivery_assignments WHERE order_id = $1 AND courier_id = $2 AND owner_id = $3 AND status = ANY($4) FOR UPDATE",
    [orderId, session.courierId, session.ownerId, ACTIVE_ASSIGNMENT]
  );
  return rows[0] ?? null;
};

/**
 * El repartidor retira el pedido: queda "en camino" y se genera el código de
 * entrega del cliente. Idempotente: reintentar no crea otro código.
 */
const pickupOrder = async (session, orderId, { settings }) => {
  const ownerId = session.ownerId;
  const events = [];
  const result = await withTransaction(async (client) => {
    const order = await lockDeliveryOrder(client, ownerId, orderId);
    const assignment = await ownAssignment(client, session, order.id);
    if (!assignment) throw new OrdersError(404, "Este pedido no está asignado a vos.", "NOT_YOUR_ORDER");
    if (assignment.status === "picked_up") return { assignment, order, repeated: true };

    requireEnabled(settings);
    if (order.status !== "ready") {
      throw new OrdersError(409, order.status === "confirmed"
        ? "El pedido todavía se está preparando."
        : "Este pedido ya no se puede retirar.", "NOT_READY");
    }
    const code = secrets.generateCode();
    const { rows } = await client.query(
      `UPDATE delivery_assignments SET status = 'picked_up', picked_up_at = now(), code_hash = $2, code_encrypted = $3,
         code_issued_at = now(), code_failed_attempts = 0, code_locked_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'assigned' RETURNING *`,
      [assignment.id, secrets.hashCode(order.id, code), secrets.encryptCode(order.id, code)]
    );
    // El UPDATE condicional protege el caso (casi imposible con el lock) de dos retiros simultáneos.
    if (!rows[0]) return { assignment: (await findActiveAssignment(client, order.id)) ?? assignment, order, repeated: true };
    await client.query("UPDATE orders SET dispatched_at = now(), updated_at = now() WHERE id = $1", [order.id]);
    await recordEvent(client, {
      ownerId, orderId: order.id, assignmentId: assignment.id, type: "picked_up", actor: courierActor(session),
      fromCourierId: session.courierId,
    });
    events.push({ event: "picked_up", orderId: Number(order.id), orderNumber: order.number, courierIds: [session.courierId], customer: true });
    return { assignment: rows[0], order, repeated: false };
  });
  for (const event of events) realtime.emit({ ownerId, ...event });
  return result;
};

const minutesLeft = (until) => Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60_000));

/**
 * El repartidor confirma la entrega con el código de 6 dígitos del cliente.
 * Los intentos fallidos se persisten (el error se lanza recién después del COMMIT)
 * y bloquean el código de ese pedido al llegar al tope.
 */
const confirmDelivery = async (session, orderId, rawCode) => {
  const code = secrets.normalizeCode(rawCode);
  if (!code) throw new OrdersError(400, "El código tiene 6 dígitos.", "CODE_FORMAT");
  const ownerId = session.ownerId;
  const events = [];
  const outcome = await withTransaction(async (client) => {
    const order = await lockDeliveryOrder(client, ownerId, orderId);
    const assignment = await ownAssignment(client, session, order.id);
    if (!assignment) {
      // Reintento de una entrega que ya se confirmó: mismo resultado, sin duplicar.
      const { rows } = await client.query(
        "SELECT * FROM delivery_assignments WHERE order_id = $1 AND courier_id = $2 AND status = 'delivered' ORDER BY id DESC LIMIT 1",
        [order.id, session.courierId]
      );
      if (rows[0]) return { ok: true, repeated: true, assignment: rows[0], order };
      throw new OrdersError(404, "Este pedido no está asignado a vos.", "NOT_YOUR_ORDER");
    }
    if (assignment.status !== "picked_up" || order.status !== "ready") {
      throw new OrdersError(409, "Primero tenés que retirar el pedido.", "NOT_PICKED_UP");
    }
    if (assignment.code_locked_until && new Date(assignment.code_locked_until).getTime() > Date.now()) {
      throw new OrdersError(
        429, `Demasiados intentos. Probá de nuevo en ${minutesLeft(assignment.code_locked_until)} min.`, "CODE_LOCKED",
      );
    }

    if (!secrets.codeMatches(order.id, code, assignment.code_hash)) {
      const attempts = assignment.code_failed_attempts + 1;
      const lock = attempts % MAX_CODE_ATTEMPTS === 0;
      await client.query(
        `UPDATE delivery_assignments SET code_failed_attempts = $2,
           code_locked_until = CASE WHEN $3 THEN now() + make_interval(secs => $4) ELSE code_locked_until END, updated_at = now()
         WHERE id = $1`,
        [assignment.id, attempts, lock, CODE_LOCK_MS / 1000]
      );
      await recordEvent(client, {
        ownerId, orderId: order.id, assignmentId: assignment.id, type: lock ? "code_locked" : "code_failed",
        actor: courierActor(session), fromCourierId: session.courierId,
      });
      return { ok: false, locked: lock };
    }

    const delivered = await finishDelivery(client, { ownerId, order, assignment, by: "courier", actor: courierActor(session) });
    events.push({ event: "delivered", orderId: Number(order.id), orderNumber: order.number, courierIds: [session.courierId], customer: true });
    return { ok: true, repeated: false, assignment: delivered.assignment, order: delivered.order };
  });
  if (!outcome.ok) {
    throw new OrdersError(
      outcome.locked ? 429 : 400,
      outcome.locked ? "Demasiados intentos. Probá de nuevo en 15 min." : "El código no es correcto.",
      outcome.locked ? "CODE_LOCKED" : "CODE_INVALID",
    );
  }
  for (const event of events) realtime.emit({ ownerId, ...event });
  return { delivered: true, repeated: outcome.repeated, deliveredAt: outcome.assignment.delivered_at };
};

/** Cierra la entrega: asignación entregada + pedido "delivered" + código inutilizado. */
const finishDelivery = async (client, { ownerId, order, assignment, by, actor, reason = null }) => {
  const orderService = require("../services/orderService");
  const { rows } = await client.query(
    `UPDATE delivery_assignments SET status = 'delivered', delivered_at = now(), code_used_at = now(), delivered_by = $2,
       code_encrypted = NULL, updated_at = now()
     WHERE id = $1 AND status = 'picked_up' RETURNING *`,
    [assignment.id, by]
  );
  if (!rows[0]) throw new OrdersError(409, "Este pedido ya fue entregado.", "ALREADY_DELIVERED");
  const updated = await orderService.applyStatusChange(client, ownerId, order, "delivered", { reason, actor });
  await recordEvent(client, {
    ownerId, orderId: order.id, assignmentId: assignment.id, type: by === "admin" ? "admin_delivered" : "delivered",
    actor, fromCourierId: assignment.courier_id, reason,
  });
  return { assignment: rows[0], order: updated };
};

/**
 * El administrador marca la entrega sin el código del cliente. Solo si el local
 * lo habilitó (quién confirma = repartidor y administrador, o la excepción para
 * incidencias) o si Delivery se apagó con el pedido en la calle. Siempre con
 * registro; el motivo es obligatorio salvo con "repartidor y administrador".
 */
const adminDeliver = async (ownerId, orderId, { reason = null, settings }) => {
  const config = deliveryConfig(settings);
  const events = [];
  const order = await withTransaction(async (client) => {
    const order = await lockDeliveryOrder(client, ownerId, orderId);
    const assignment = await findActiveAssignment(client, order.id, { lock: true });
    if (!assignment) throw new OrdersError(409, "Este pedido no tiene repartidor asignado.", "NOT_ASSIGNED");
    if (assignment.status !== "picked_up" || order.status !== "ready") {
      throw new OrdersError(409, "El repartidor todavía no retiró el pedido.", "NOT_PICKED_UP");
    }
    const allowed = config.confirmBy === "courier_admin" || config.adminOverride || !config.enabled;
    if (!allowed) {
      throw new OrdersError(
        403, "En este local solo el repartidor confirma la entrega. Podés habilitar la excepción para incidencias en la configuración.",
        "ADMIN_DELIVERY_NOT_ALLOWED",
      );
    }
    const needsReason = config.confirmBy !== "courier_admin" || !config.enabled;
    const cleanReason = needsReason
      ? requireReason(reason, "Indicá el motivo de marcar la entrega sin el código del cliente.")
      : cleanText(reason, LIMITS.statusReasonLength);
    const done = await finishDelivery(client, {
      ownerId, order, assignment, by: "admin", actor: panelActor(ownerId), reason: cleanReason,
    });
    events.push({ event: "delivered", orderId: Number(order.id), orderNumber: order.number, courierIds: [Number(assignment.courier_id)], customer: true });
    return done.order;
  });
  for (const event of events) realtime.emit({ ownerId, ...event });
  return order;
};

/**
 * Guarda de `orderService.updateStatus` para pedidos de delivery con repartidor:
 *  · entregado: no se hace desde el panel general (ver confirmDelivery / adminDeliver);
 *  · anulado: se libera al repartidor;
 *  · volver atrás un pedido que ya salió: no.
 * Devuelve los avisos para emitir después del COMMIT.
 */
const guardStatusChange = async (client, ownerId, order, status) => {
  const assignment = await findActiveAssignment(client, order.id, { lock: true });
  if (!assignment) return [];
  if (status === "delivered") {
    throw new OrdersError(
      409, "Este pedido lo entrega un repartidor. Se confirma con el código del cliente (o desde Delivery, si el local lo permite).",
      "DELIVERY_REQUIRES_COURIER",
    );
  }
  if (status === "cancelled") {
    await releaseAssignment(client, assignment, "order_cancelled");
    if (assignment.status === "picked_up") {
      await client.query("UPDATE orders SET dispatched_at = NULL WHERE id = $1", [order.id]);
    }
    await recordEvent(client, {
      ownerId, orderId: order.id, assignmentId: assignment.id, type: "released", actor: panelActor(ownerId),
      fromCourierId: assignment.courier_id, reason: "Pedido anulado",
    });
    return [{ event: "released", orderId: Number(order.id), orderNumber: order.number, courierIds: [Number(assignment.courier_id)], openList: true }];
  }
  if (assignment.status === "picked_up" && status !== "ready") {
    throw new OrdersError(409, "El repartidor ya retiró este pedido: quitalo desde Delivery antes de cambiar su estado.", "DELIVERY_IN_TRANSIT");
  }
  return [];
};

/** markDispatched: con repartidor asignado la salida la registra él al retirar. */
const assertNoCourierAssigned = async (client, orderId) => {
  const current = await findActiveAssignment(client, orderId);
  if (current) {
    throw new OrdersError(409, "Este pedido tiene un repartidor asignado: la salida se registra cuando él lo retira.", "DELIVERY_ASSIGNED");
  }
};

// ── DTOs ─────────────────────────────────────

const minutesBetween = (from, to) => {
  if (!from || !to) return null;
  const diff = new Date(to).getTime() - new Date(from).getTime();
  return diff >= 0 ? Math.round(diff / 60_000) : null;
};

const toAssignmentDTO = (row, order = null) => ({
  id: Number(row.id),
  orderId: Number(row.order_id),
  courierId: Number(row.courier_id),
  courierName: row.courier_name,
  status: row.status,
  assignedVia: row.assigned_via,
  assignedAt: row.assigned_at,
  pickedUpAt: row.picked_up_at,
  deliveredAt: row.delivered_at,
  releasedAt: row.released_at,
  releaseReason: row.release_reason,
  deliveredBy: row.delivered_by,
  durationMinutes: minutesBetween(row.picked_up_at, row.delivered_at),
  codeLocked: !!row.code_locked_until && new Date(row.code_locked_until).getTime() > Date.now(),
  ...(order ? { orderNumber: order.number } : {}),
});

// ── Panel del local ──────────────────────────

/** Entregas en curso + pedidos de delivery listos para asignar. */
const listActive = async (ownerId, { settings }) => {
  const config = deliveryConfig(settings);
  const { rows } = await query(
    `SELECT o.* FROM orders o
     WHERE o.owner_id = $1 AND o.service_type = 'delivery' AND o.status = ANY($2)
     ORDER BY o.created_at`,
    [ownerId, ASSIGNABLE_STATUSES]
  );
  const orders = await withItems(rows);
  const { rows: assignmentRows } = rows.length === 0
    ? { rows: [] }
    : await query(
      "SELECT * FROM delivery_assignments WHERE order_id = ANY($1) AND status = ANY($2)",
      [rows.map((row) => row.id), ACTIVE_ASSIGNMENT]
    );
  const byOrder = new Map(assignmentRows.map((row) => [String(row.order_id), row]));
  const inProgress = [];
  const unassigned = [];
  for (const order of orders) {
    const assignment = byOrder.get(String(order.id));
    if (assignment) inProgress.push({ order, assignment: toAssignmentDTO(assignment, order) });
    else unassigned.push(order);
  }
  return { config, inProgress, unassigned, serverTime: new Date().toISOString() };
};

/** Historial de responsables y eventos de un pedido (auditoría). */
const getTrail = async (ownerId, orderId) => {
  const { rows: orders } = await query("SELECT id, number FROM orders WHERE owner_id = $1 AND id = $2", [ownerId, orderId]);
  if (!orders[0]) throw new OrdersError(404, "Pedido no encontrado.");
  const [assignments, events] = await Promise.all([
    query("SELECT * FROM delivery_assignments WHERE owner_id = $1 AND order_id = $2 ORDER BY id", [ownerId, orderId]),
    query("SELECT * FROM delivery_events WHERE owner_id = $1 AND order_id = $2 ORDER BY id", [ownerId, orderId]),
  ]);
  return {
    assignments: assignments.rows.map((row) => toAssignmentDTO(row)),
    events: events.rows.map((row) => ({
      id: Number(row.id),
      type: row.event_type,
      actorType: row.actor_type,
      actorName: row.actor_name,
      fromCourierId: row.from_courier_id == null ? null : Number(row.from_courier_id),
      toCourierId: row.to_courier_id == null ? null : Number(row.to_courier_id),
      reason: row.reason,
      createdAt: row.created_at,
    })),
  };
};

/**
 * Suma `delivery` (repartidor, horarios, duración y responsables anteriores) a
 * pedidos ya armados, para el tablero y el historial general. Una sola consulta.
 */
const attachDelivery = async (ownerId, orders) => {
  const ids = orders.filter((order) => order.serviceType === "delivery").map((order) => order.id);
  if (ids.length === 0) return orders;
  const { rows } = await query(
    "SELECT * FROM delivery_assignments WHERE owner_id = $1 AND order_id = ANY($2) ORDER BY id",
    [ownerId, ids]
  );
  const byOrder = new Map();
  for (const row of rows) {
    const key = String(row.order_id);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(row);
  }
  return orders.map((order) => {
    const list = byOrder.get(String(order.id));
    if (!list) return order;
    // La entrega vigente (o la que cerró el pedido); las demás son responsables anteriores.
    const current = [...list].reverse().find((row) => row.status !== "released") ?? list[list.length - 1];
    return {
      ...order,
      delivery: {
        ...toAssignmentDTO(current),
        previousCouriers: list.filter((row) => row.id !== current.id).map((row) => ({
          courierName: row.courier_name, assignedAt: row.assigned_at, releasedAt: row.released_at, reason: row.release_reason,
        })),
      },
    };
  });
};

/**
 * Pedidos de delivery con código que el cliente no puede ver online (cargados
 * a mano desde el panel): el administrador se lo comunica. Queda registrado.
 */
const revealCode = async (ownerId, orderId) => {
  const code = await withTransaction(async (client) => {
    const order = await lockDeliveryOrder(client, ownerId, orderId);
    const assignment = await findActiveAssignment(client, order.id, { lock: true });
    if (!assignment || assignment.status !== "picked_up") {
      throw new OrdersError(409, "El código se genera cuando el repartidor retira el pedido.", "CODE_NOT_ISSUED");
    }
    const { rows } = await client.query("SELECT 1 FROM order_online_payments WHERE order_id = $1", [order.id]);
    if (rows[0]) {
      throw new OrdersError(409, "Este cliente ve el código en el seguimiento de su pedido.", "CODE_VISIBLE_TO_CUSTOMER");
    }
    const plain = secrets.decryptCode(order.id, assignment.code_encrypted);
    if (!plain) throw new OrdersError(500, "No se pudo recuperar el código.");
    await recordEvent(client, {
      ownerId, orderId: order.id, assignmentId: assignment.id, type: "code_viewed", actor: panelActor(ownerId),
    });
    return plain;
  });
  return code;
};

// ── Panel del repartidor ─────────────────────

// Lo que ve el repartidor de un pedido. Sin pagos ni datos administrativos; los
// datos del destinatario solo cuando el pedido es suyo.
const toCourierOrder = (order, items, assignment, { mine, config }) => ({
  id: Number(order.id),
  number: order.number,
  orderStatus: order.status,
  address: order.delivery_address ?? null,
  ...(mine
    ? {
      deliveryNotes: order.delivery_notes ?? null,
      customerName: order.customer_name ?? null,
      customerPhone: order.customer_phone ?? null,
      notes: order.notes ?? null,
      items: items.map((item) => ({ title: item.title, option: item.option_name ?? null, quantity: item.quantity, notes: item.notes ?? null })),
    }
    : { itemsCount: items.reduce((sum, item) => sum + item.quantity, 0) }),
  createdAt: order.created_at,
  readyAt: order.ready_at,
  assignment: assignment
    ? {
      status: assignment.status,
      assignedAt: assignment.assigned_at,
      pickedUpAt: assignment.picked_up_at,
      deliveredAt: assignment.delivered_at,
      codeLocked: !!assignment.code_locked_until && new Date(assignment.code_locked_until).getTime() > Date.now(),
    }
    : null,
  // El botón «Retirar» solo aparece con el pedido listo.
  canPickup: !!assignment && assignment.status === "assigned" && order.status === "ready" && config.enabled,
});

const itemsByOrder = async (orderIds) => {
  if (orderIds.length === 0) return new Map();
  const { rows } = await query(
    "SELECT order_id, title, option_name, quantity, notes FROM order_items WHERE order_id = ANY($1) ORDER BY order_id, position, id",
    [orderIds]
  );
  const byOrder = new Map();
  for (const row of rows) {
    const key = String(row.order_id);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(row);
  }
  return byOrder;
};

/** Pantalla principal del repartidor: pendientes de retirar, en camino y (si puede) disponibles. */
const courierPanel = async (session, { settings }) => {
  const config = deliveryConfig(settings);
  const ownerId = session.ownerId;
  const { rows: mineRows } = await query(
    `SELECT a.*, row_to_json(o.*) AS order_row FROM delivery_assignments a JOIN orders o ON o.id = a.order_id
     WHERE a.courier_id = $1 AND a.owner_id = $2 AND a.status = ANY($3) ORDER BY a.assigned_at`,
    [session.courierId, ownerId, ACTIVE_ASSIGNMENT]
  );
  let openRows = [];
  let openCount = 0;
  if (config.enabled && config.assignMode === "open") {
    const { rows } = await query(
      `SELECT o.* FROM orders o
       WHERE o.owner_id = $1 AND o.service_type = 'delivery' AND o.status = ANY($2)
         AND NOT EXISTS (SELECT 1 FROM delivery_assignments a WHERE a.order_id = o.id AND a.status = ANY($3))
       ORDER BY o.created_at LIMIT 50`,
      [ownerId, ASSIGNABLE_STATUSES, ACTIVE_ASSIGNMENT]
    );
    openCount = rows.length;
    // Solo quien se marcó disponible ve (y puede tomar) los pedidos compartidos.
    if (session.available) openRows = rows;
  }
  const items = await itemsByOrder([...mineRows.map((row) => row.order_id), ...openRows.map((row) => row.id)]);
  const mine = mineRows.map((row) => toCourierOrder(row.order_row, items.get(String(row.order_id)) ?? [], row, { mine: true, config }));
  return {
    enabled: config.enabled,
    assignMode: config.assignMode,
    available: session.available,
    assigned: mine.filter((order) => order.assignment.status === "assigned"),
    inTransit: mine.filter((order) => order.assignment.status === "picked_up"),
    open: openRows.map((row) => toCourierOrder(row, items.get(String(row.id)) ?? [], null, { mine: false, config })),
    openCount,
    serverTime: new Date().toISOString(),
  };
};

const courierHistory = async (session, { page = 1, pageSize = 20 } = {}) => {
  const offset = (Number(page) - 1) * Number(pageSize);
  const [{ rows }, count] = await Promise.all([
    query(
      `SELECT a.*, row_to_json(o.*) AS order_row FROM delivery_assignments a JOIN orders o ON o.id = a.order_id
       WHERE a.courier_id = $1 AND a.owner_id = $2 AND a.status = 'delivered'
       ORDER BY a.delivered_at DESC LIMIT ${Number(pageSize)} OFFSET ${offset}`,
      [session.courierId, session.ownerId]
    ),
    query("SELECT count(*)::int AS total FROM delivery_assignments WHERE courier_id = $1 AND owner_id = $2 AND status = 'delivered'", [session.courierId, session.ownerId]),
  ]);
  const items = await itemsByOrder(rows.map((row) => row.order_id));
  return {
    deliveries: rows.map((row) => ({
      ...toCourierOrder(row.order_row, items.get(String(row.order_id)) ?? [], row, { mine: true, config: { enabled: false } }),
      durationMinutes: minutesBetween(row.picked_up_at, row.delivered_at),
    })),
    total: count.rows[0].total,
    page,
    pageSize,
  };
};

/** Detalle de un pedido para el repartidor: solo si es suyo (o está disponible para tomarlo). */
const courierOrder = async (session, orderId, { settings }) => {
  const config = deliveryConfig(settings);
  const { rows } = await query(
    `SELECT a.*, row_to_json(o.*) AS order_row FROM delivery_assignments a JOIN orders o ON o.id = a.order_id
     WHERE a.order_id = $1 AND a.courier_id = $2 AND a.owner_id = $3 ORDER BY a.id DESC LIMIT 1`,
    [orderId, session.courierId, session.ownerId]
  );
  const row = rows[0];
  if (!row) throw new OrdersError(404, "Pedido no encontrado.");
  const items = await itemsByOrder([row.order_id]);
  return toCourierOrder(row.order_row, items.get(String(row.order_id)) ?? [], row, { mine: true, config });
};

// ── Seguimiento del cliente ──────────────────

/**
 * Lo que ve el cliente de su envío: si ya salió y el código de entrega.
 * La referencia del pago es el secreto que lo identifica y se resuelve solo
 * dentro del local del slug. Con Delivery apagado solo se muestra para pedidos
 * que ya estaban en la calle (hay que poder entregarlos).
 */
const customerDelivery = async (ownerId, ref, { settings }) => {
  if (typeof ref !== "string" || !/^[a-f0-9]{48}$/.test(ref)) throw new OrdersError(404, "Pago no encontrado.");
  const { rows } = await query(
    `SELECT a.status, a.picked_up_at, a.delivered_at, a.courier_name, a.code_encrypted, a.order_id
       FROM order_online_payments p JOIN delivery_assignments a ON a.order_id = p.order_id
      WHERE p.owner_id = $1 AND p.external_reference = $2 AND a.status IN ('picked_up', 'delivered')
      ORDER BY a.id DESC LIMIT 1`,
    [ownerId, ref]
  );
  const row = rows[0];
  const config = deliveryConfig(settings);
  if (!row || (!config.enabled && row.status !== "picked_up")) return { tracked: false };
  return {
    tracked: true,
    status: row.status,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    courierName: row.courier_name,
    // Solo mientras está en camino: entregado, el código ya no existe ni vale.
    code: row.status === "picked_up" ? secrets.decryptCode(row.order_id, row.code_encrypted) : null,
  };
};

module.exports = {
  ASSIGNABLE_STATUSES,
  MAX_CODE_ATTEMPTS,
  deliveryConfig,
  assignOrder,
  claimOrder,
  unassignOrder,
  reassignAll,
  releasePendingOnDisable,
  pickupOrder,
  confirmDelivery,
  adminDeliver,
  guardStatusChange,
  assertNoCourierAssigned,
  listActive,
  getTrail,
  attachDelivery,
  revealCode,
  courierPanel,
  courierHistory,
  courierOrder,
  customerDelivery,
  toAssignmentDTO,
  toOrderDTO,
};
