// Sectores y comandas: la configuración del dueño (JWT + plan PRO) y la
// pantalla de cada sector (equipo vinculado con código).
//
// La pantalla del sector es la misma para los dos: el dueño puede abrir la de
// cualquier sector desde su sesión (ej. su propia PC en la barra) y un equipo
// vinculado solo ve la de su sector.

const { route } = require("../errors");
const { query } = require("../db/sql");
const sectorService = require("../services/sectorService");
const ticketService = require("../services/ticketService");
const { businessNameOf, findOwnerById } = require("../services/menuCatalog");
const { positiveInt } = require("../utils/validate");
const realtime = require("../delivery/realtime");

const ownerIdOf = (req) => String(req.user._id);
// Cambió un sector o sus equipos: el panel y las pantallas de sector vuelven a consultar.
const notifyDevices = (ownerId) => realtime.emit({ ownerId, event: "devices", staff: true });
const idParam = (req, name = "id") => positiveInt(req.params[name], { field: "Identificador" });

// ── Dueño: configuración ─────────────────────

// Sectores y a qué sector va cada parte del menú (lo usa también el editor
// de menú para mostrar el selector).
const listSectors = route(async (req, res) => {
  const [sectors, assignments] = await Promise.all([
    sectorService.listSectors(ownerIdOf(req)),
    sectorService.listAssignments(ownerIdOf(req)),
  ]);
  res.json({ sectors, assignments });
});

const createSector = route(async (req, res) => {
  res.status(201).json({ sector: await sectorService.createSector(ownerIdOf(req), req.body) });
});

const updateSector = route(async (req, res) => {
  const sector = await sectorService.updateSector(ownerIdOf(req), idParam(req), req.body);
  notifyDevices(ownerIdOf(req));
  res.json({ sector });
});

const deleteSector = route(async (req, res) => {
  await sectorService.deleteSector(ownerIdOf(req), idParam(req));
  notifyDevices(ownerIdOf(req));
  res.status(204).end();
});

const setAssignment = route(async (req, res) => {
  res.json({ assignment: await sectorService.setAssignment(ownerIdOf(req), req.body) });
});

const issuePairingCode = route(async (req, res) => {
  res.json(await sectorService.issuePairingCode(ownerIdOf(req), idParam(req)));
});

const revokeSessions = route(async (req, res) => {
  await sectorService.revokeSessions(ownerIdOf(req), idParam(req));
  notifyDevices(ownerIdOf(req));
  res.status(204).end();
});

const revokeSession = route(async (req, res) => {
  await sectorService.revokeSession(ownerIdOf(req), idParam(req), idParam(req, "sessionId"));
  notifyDevices(ownerIdOf(req));
  res.status(204).end();
});

// ── Dueño: pantalla de un sector ─────────────

const ownerTickets = route(async (req, res) => {
  const sector = await sectorService.getSector({ query }, ownerIdOf(req), idParam(req));
  res.json({
    sector: sectorService.toSectorDTO(sector),
    ...(await ticketService.listSectorTickets(ownerIdOf(req), Number(sector.id))),
    serverTime: new Date().toISOString(),
  });
});

const ownerTicketStatus = route(async (req, res) => {
  res.json({
    ticket: await ticketService.updateTicketStatus(ownerIdOf(req), idParam(req), idParam(req, "ticketId"), req.body?.status),
  });
});

const ownerTicketPrinted = route(async (req, res) => {
  res.json({ ticket: await ticketService.markPrinted(ownerIdOf(req), idParam(req), idParam(req, "ticketId")) });
});

// ── Equipo vinculado del sector ──────────────

const stationPayload = (owner, sector) => ({
  sector,
  business: { slug: owner?.slug ?? "", name: businessNameOf(owner) },
});

const stationOwnerId = (req) => String(req.owner._id);
const stationSectorId = (req) => req.stationSession.sector.id;

// Canje del código tipeado por el token del equipo.
const pair = route(async (req, res) => {
  const { token, sector, ownerId } = await sectorService.pairDevice(req.body?.code, {
    userAgent: req.headers["user-agent"],
  });
  const owner = await findOwnerById(ownerId);
  notifyDevices(ownerId);
  res.status(201).json({ token, ...stationPayload(owner, sector) });
});

const me = route(async (req, res) => {
  res.json(stationPayload(req.owner, req.stationSession.sector));
});

const logout = route(async (req, res) => {
  await sectorService.endSession(req.stationSession.sessionId);
  notifyDevices(stationOwnerId(req));
  res.status(204).end();
});

const stationTickets = route(async (req, res) => {
  res.json({
    // La configuración del sector viaja en cada consulta: si el dueño cambia
    // el modo de impresión, el equipo se entera sin volver a vincularse.
    sector: req.stationSession.sector,
    ...(await ticketService.listSectorTickets(stationOwnerId(req), stationSectorId(req))),
    serverTime: new Date().toISOString(),
  });
});

const stationTicketStatus = route(async (req, res) => {
  res.json({
    ticket: await ticketService.updateTicketStatus(
      stationOwnerId(req), stationSectorId(req), idParam(req), req.body?.status
    ),
  });
});

const stationTicketPrinted = route(async (req, res) => {
  res.json({ ticket: await ticketService.markPrinted(stationOwnerId(req), stationSectorId(req), idParam(req)) });
});

module.exports = {
  listSectors,
  createSector,
  updateSector,
  deleteSector,
  setAssignment,
  issuePairingCode,
  revokeSessions,
  revokeSession,
  ownerTickets,
  ownerTicketStatus,
  ownerTicketPrinted,
  pair,
  me,
  logout,
  stationTickets,
  stationTicketStatus,
  stationTicketPrinted,
};
