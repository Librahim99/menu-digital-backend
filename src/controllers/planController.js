const Plan = require("../models/Plan");
const User = require("../models/User");
const PaymentTransaction = require("../models/PaymentTransaction");
const catalog = require("../services/planCatalog");
const {
  PLAN_ORDER,
  isValidFeatures,
  isValidPeriodMultipliers,
  getEffectivePlan,
} = require("../config/plans");
const { handleError } = require("../utils/handleError");

const listPlans = async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    return res.json({ plans: await catalog.listPlans() });
  } catch (error) {
    return handleError(res, error, 503);
  }
};

// ──────────────────────────────────────────────
// @desc    Cuentas y facturación por plan, para no editar precios a ciegas:
//          el panel mostraba el catálogo sin decir cuánta gente ni cuánta
//          plata toca cada cambio.
// @route   GET /api/admin/plans/usage
// @access  Admin
// ──────────────────────────────────────────────
const getPlanUsage = async (_req, res) => {
  try {
    const now = new Date();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const revenueWindowStart = new Date(now.getTime() - THIRTY_DAYS_MS);

    const [users, revenueRows] = await Promise.all([
      User.find({ admin: false }).select("subscription subscriptionExpiresAt active"),
      PaymentTransaction.aggregate([
        // Solo plata que efectivamente entró y se acreditó: un pago aprobado
        // cuyo plan nunca se aplicó no es facturación de ese plan.
        { $match: { status: "approved", entitlementStatus: "applied" } },
        {
          $group: {
            _id: { $ifNull: ["$appliedPlanId", "$planId"] },
            // Neto de reembolsos, que es lo que realmente quedó.
            revenueTotal: {
              $sum: {
                $subtract: [
                  { $ifNull: ["$amount", 0] },
                  { $ifNull: ["$refundedAmount", 0] },
                ],
              },
            },
            revenue30d: {
              $sum: {
                $cond: [
                  {
                    $gte: [
                      { $ifNull: ["$paymentApprovedAt", "$createdAt"] },
                      revenueWindowStart,
                    ],
                  },
                  {
                    $subtract: [
                      { $ifNull: ["$amount", 0] },
                      { $ifNull: ["$refundedAmount", 0] },
                    ],
                  },
                  0,
                ],
              },
            },
            payments: { $sum: 1 },
          },
        },
      ]),
    ]);

    const revenueByPlan = new Map(revenueRows.map((row) => [row._id, row]));

    // El conteo usa el plan EFECTIVO, no el guardado: una suscripción paga
    // vencida ya no es una cuenta de ese plan, y contarla infla la cartera
    // paga. Se reutiliza getEffectivePlan en vez de reescribir la regla de
    // vencimiento en la query.
    const accountsByPlan = PLAN_ORDER.reduce((acc, plan) => {
      acc[plan] = { total: 0, active: 0 };
      return acc;
    }, {});

    users.forEach((user) => {
      const plan = getEffectivePlan(user.subscription, user.subscriptionExpiresAt, now);
      if (!accountsByPlan[plan]) return;
      accountsByPlan[plan].total += 1;
      if (user.active) accountsByPlan[plan].active += 1;
    });

    res.set("Cache-Control", "no-store");
    return res.json({
      usage: PLAN_ORDER.map((plan) => {
        const revenue = revenueByPlan.get(plan);
        return {
          name: plan,
          accounts: accountsByPlan[plan].total,
          activeAccounts: accountsByPlan[plan].active,
          revenueTotal: revenue?.revenueTotal || 0,
          revenue30d: revenue?.revenue30d || 0,
          payments: revenue?.payments || 0,
        };
      }),
    });
  } catch (error) {
    return handleError(res, error);
  }
};

const updatePlan = async (req, res) => {
  const { name } = req.params;
  if (!PLAN_ORDER.includes(name)) return res.status(404).json({ message: "Plan no encontrado." });
  const body = req.body;
  if (!body || Array.isArray(body) || typeof body !== "object"
    || Object.keys(body).some(key => !["price", "discountPrice", "version", "features", "label", "description", "periodMultipliers"].includes(key))
    || !isValidFeatures(body.features)
    || typeof body.label !== "string" || !body.label.trim() || body.label.trim().length > 60
    || typeof body.description !== "string" || !body.description.trim() || body.description.trim().length > 280
    || !Number.isSafeInteger(body.version) || body.version < 0
    || !Number.isSafeInteger(body.price) || body.price < 0 || body.price > 100000000
    || !(body.discountPrice === null || (Number.isSafeInteger(body.discountPrice)
      && body.discountPrice > 0 && body.discountPrice < body.price))
    || (name === "free" ? body.price !== 0 || body.discountPrice !== null : body.price === 0)) {
    return res.status(400).json({ message: "Revisá nombre, descripción, precios y funciones. Usá pesos enteros, límite positivo o ilimitado y al menos un template válido; Gratis conserva precio cero." });
  }
  const hasPeriodMultipliers = Object.prototype.hasOwnProperty.call(body, "periodMultipliers");
  if (hasPeriodMultipliers && (!isValidPeriodMultipliers(body.periodMultipliers)
    || (name !== "free" && Object.values(body.periodMultipliers)
      .some(multiplier => Math.round((body.discountPrice ?? body.price) * multiplier) < 1)))) {
    return res.status(400).json({ message: "Revisá los multiplicadores de 1, 3, 6 y 12 meses: el mensual debe ser 1 y los demás, números positivos hasta la cantidad de meses. Cada período pago debe costar al menos un peso." });
  }
  try {
    const current = await Plan.findOne({ name });
    if (!current) return res.status(404).json({ message: "Plan no encontrado." });
    if ((current.__v ?? 0) !== body.version) {
      return res.status(409).json({ message: "El plan cambió mientras lo editabas. Recargá los datos antes de guardar." });
    }
    current.price = body.price;
    current.discountPrice = body.discountPrice;
    current.features = body.features;
    current.label = body.label;
    current.description = body.description;
    // Los clientes anteriores pueden omitir el mapa; no restablecerlo al guardar.
    if (hasPeriodMultipliers) current.periodMultipliers = body.periodMultipliers;
    current.updatedBy = req.user._id;
    await current.save(); // optimisticConcurrency comprueba __v de forma atómica.
    res.set("Cache-Control", "no-store");
    return res.json({ plan: catalog.planToDTO(current) });
  } catch (error) {
    if (error.name === "VersionError") {
      return res.status(409).json({ message: "Otro administrador actualizó el plan. Recargá los datos antes de guardar." });
    }
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: "La configuración del plan no es válida." });
    }
    return handleError(res, error);
  }
};

module.exports = { listPlans, updatePlan, getPlanUsage };
