// Panel de Reservas del dueño del local (JWT + plan PRO).

const { route, ReservationsError } = require("../errors");
const service = require("../services/reservationService");
const { parseId, parseDate, addDays, buenosAiresNow } = require("../utils/validate");

const ownerIdOf = (req) => String(req.user._id);

const getSettings = route(async (req, res) => {
  const ownerId = ownerIdOf(req);
  const [settings, pending] = await Promise.all([service.getOrCreateSettings(ownerId), service.countPending(ownerId)]);
  res.json({ settings: service.toSettingsDTO(settings), slug: req.user.slug, pendingCount: pending });
});

const updateSettings = route(async (req, res) => {
  const settings = await service.updateSettings(ownerIdOf(req), req.body);
  res.json({ settings: service.toSettingsDTO(settings), slug: req.user.slug });
});

// Por defecto: desde hace 60 días. ?from=YYYY-MM-DD para ver más atrás.
const HISTORY_DAYS = 60;

const listReservations = route(async (req, res) => {
  const ownerId = ownerIdOf(req);
  const from = req.query.from !== undefined
    ? parseDate(req.query.from, "La fecha")
    : addDays(buenosAiresNow().date, -HISTORY_DAYS);
  const { rows, truncated } = await service.listForOwner(ownerId, { from });
  const pendingCount = await service.countPending(ownerId);
  res.json({ reservations: rows.map(service.toOwnerDTO), from, truncated, pendingCount });
});

const createReservation = route(async (req, res) => {
  const ownerId = ownerIdOf(req);
  const settings = await service.getOrCreateSettings(ownerId);
  const row = await service.createManual(ownerId, settings, req.body ?? {});
  res.status(201).json({ reservation: service.toOwnerDTO(row) });
});

const ACTIONS = {
  confirm: "confirm",
  reject: "reject",
  cancel: "cancel",
  complete: "complete",
  "no-show": "no_show",
  reopen: "reopen",
};

const doAction = route(async (req, res) => {
  const action = ACTIONS[req.params.action];
  if (!action) throw new ReservationsError(404, "Acción inexistente.");
  const row = await service.runOwnerAction(ownerIdOf(req), parseId(req.params.id), action, req.body);
  res.json({ reservation: service.toOwnerDTO(row) });
});

const updateReservation = route(async (req, res) => {
  const ownerId = ownerIdOf(req);
  const settings = await service.getOrCreateSettings(ownerId);
  const row = await service.updateDetails(ownerId, parseId(req.params.id), req.body ?? {}, settings);
  res.json({ reservation: service.toOwnerDTO(row) });
});

module.exports = { getSettings, updateSettings, listReservations, createReservation, doAction, updateReservation };
