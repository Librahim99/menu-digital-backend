// Reservas desde la landing del local. Sin cuenta: el cliente se identifica
// con el código de su reserva.

const { route, ReservationsError } = require("../errors");
const { findProOwnerBySlug, businessNameOf } = require("../../orders/services/menuCatalog");
const service = require("../services/reservationService");

const notFound = () => new ReservationsError(404, "No encontramos una reserva con ese código.");

// La reserva tiene que existir Y ser del local de la URL: un código de otro
// local se trata igual que uno inexistente.
const loadReservation = async (req) => {
  const owner = await findProOwnerBySlug(req.params.slug);
  if (!owner) throw notFound();
  const row = await service.findByCode(req.params.code);
  if (!row || row.owner_id !== String(owner._id)) throw notFound();
  return { owner, row };
};

const getConfig = route(async (req, res) => {
  const owner = await findProOwnerBySlug(req.params.slug);
  const settings = owner ? await service.findSettings(String(owner._id)) : null;
  if (!owner || !settings?.enabled) return res.json({ enabled: false });

  res.json({
    enabled: true,
    businessName: businessNameOf(owner),
    ...service.toSettingsDTO(settings),
  });
});

const createReservation = route(async (req, res) => {
  const owner = await findProOwnerBySlug(req.params.slug);
  if (!owner) throw new ReservationsError(404, "Este local no recibe reservas online.");
  const settings = await service.getOrCreateSettings(String(owner._id));

  const row = await service.createFromWeb(String(owner._id), settings, req.body ?? {});
  res.status(201).json({ reservation: service.toCustomerDTO(row), businessName: businessNameOf(owner) });
});

const getReservation = route(async (req, res) => {
  const { owner, row } = await loadReservation(req);
  res.json({ reservation: service.toCustomerDTO(row), businessName: businessNameOf(owner) });
});

const acceptAlternative = route(async (req, res) => {
  const { owner, row } = await loadReservation(req);
  const updated = await service.runCustomerAction(row.code, "accept_alternative");
  res.json({ reservation: service.toCustomerDTO(updated), businessName: businessNameOf(owner) });
});

const cancelReservation = route(async (req, res) => {
  const { owner, row } = await loadReservation(req);
  const updated = await service.runCustomerAction(row.code, "cancel");
  res.json({ reservation: service.toCustomerDTO(updated), businessName: businessNameOf(owner) });
});

module.exports = { getConfig, createReservation, getReservation, acceptAlternative, cancelReservation };
