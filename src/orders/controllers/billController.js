// Cuenta de una mesa (dividirla y registrar pagos). Mismas operaciones para
// la app del operador (solo sus mesas) y para Mesas en el panel del dueño:
// cambia de dónde sale el local y quién firma cada cambio.

const { route } = require("../errors");
const billService = require("../services/billService");
const { positiveInt } = require("../utils/validate");

const idParam = (req, name = "id") => positiveInt(req.params[name], { field: "Identificador" });

/**
 * @param {(req) => { ownerId: string, ctx: { actor: {type,id,name}, waiterId: number|null } }} who
 */
const billRoutes = (who) => {
  const handler = (fn, status = 200) => route(async (req, res) => {
    const { ownerId, ctx } = who(req);
    res.status(status).json(await fn(req, ownerId, ctx));
  });

  return {
    getBill: handler(async (req, ownerId, ctx) => ({ bill: await billService.getBill(ownerId, idParam(req), ctx) })),
    addGuests: handler((req, ownerId, ctx) => billService.addGuests(ownerId, idParam(req), req.body ?? {}, ctx), 201),
    renameGuest: handler((req, ownerId, ctx) =>
      billService.renameGuest(ownerId, idParam(req), idParam(req, "guestId"), req.body ?? {}, ctx)),
    removeGuest: handler((req, ownerId, ctx) => billService.removeGuest(ownerId, idParam(req), idParam(req, "guestId"), ctx)),
    setSplit: handler((req, ownerId, ctx) => billService.setSplit(ownerId, idParam(req), req.body ?? {}, ctx)),
    setItemShares: handler((req, ownerId, ctx) =>
      billService.setItemShares(ownerId, idParam(req), idParam(req, "itemId"), req.body ?? {}, ctx)),
    recordPayment: route(async (req, res) => {
      const { ownerId, ctx } = who(req);
      const result = await billService.recordPayment(ownerId, idParam(req), req.body ?? {}, ctx);
      res.status(result.duplicate ? 200 : 201).json(result);
    }),
    voidPayment: handler((req, ownerId, ctx) =>
      billService.voidPayment(ownerId, idParam(req), idParam(req, "paymentId"), req.body ?? {}, ctx)),
  };
};

const waiter = billRoutes((req) => ({
  ownerId: String(req.owner._id),
  ctx: {
    actor: { type: "waiter", id: req.waiterSession.waiterId, name: req.waiterSession.name },
    waiterId: req.waiterSession.waiterId,
  },
}));

const owner = billRoutes((req) => ({
  ownerId: String(req.user._id),
  ctx: { actor: { type: "panel", id: String(req.user._id), name: "Panel" }, waiterId: null },
}));

module.exports = { waiter, owner };
