const Seller = require("../models/Seller");
const User = require("../models/User");
const PaymentTransaction = require("../models/PaymentTransaction");
const { getSubscriptionState } = require("../config/plans");
const { handleError } = require("../utils/handleError");

const DAY_MS = 24 * 60 * 60 * 1000;
const CLIENT_FIELDS =
  "username slug active menu subscription subscriptionExpiresAt " +
  "contactInfo.businessName sellerID createdAt";

const toTime = (value) => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

/**
 * Facturación atribuida a cada cliente, para poder sumarla por vendedor.
 * Solo cuenta plata que entró Y se acreditó: un pago aprobado cuyo plan nunca
 * se aplicó no es una venta cerrada. Neto de reembolsos.
 */
const getRevenueByClient = async (clientIDs, now = new Date()) => {
  if (clientIDs.length === 0) return new Map();

  const windowStart = new Date(now.getTime() - 30 * DAY_MS);
  const net = {
    $subtract: [{ $ifNull: ["$amount", 0] }, { $ifNull: ["$refundedAmount", 0] }],
  };

  const rows = await PaymentTransaction.aggregate([
    {
      $match: {
        userID: { $in: clientIDs },
        status: "approved",
        entitlementStatus: "applied",
      },
    },
    {
      $group: {
        _id: "$userID",
        revenueTotal: { $sum: net },
        revenue30d: {
          $sum: {
            $cond: [
              { $gte: [{ $ifNull: ["$paymentApprovedAt", "$createdAt"] }, windowStart] },
              net,
              0,
            ],
          },
        },
        payments: { $sum: 1 },
        renewals: {
          $sum: { $cond: [{ $eq: ["$operation", "renewal"] }, 1, 0] },
        },
      },
    },
  ]);

  return new Map(rows.map((row) => [String(row._id), row]));
};

const getSellerMetrics = (clients, now = new Date(), revenueByClient = new Map()) => {
  const nowTime = now.getTime();
  const thirtyDaysAgo = nowTime - 30 * DAY_MS;
  const thirtyDaysAhead = nowTime + 30 * DAY_MS;
  const metrics = {
    clientsTotal: clients.length,
    activeAccounts: 0,
    paidCurrent: 0,
    newClients30d: 0,
    expiring30d: 0,
    expired: 0,
    withMenu: 0,
    plans: { basic: 0, pro: 0 },
    lastClientAt: null,
    revenueTotal: 0,
    revenue30d: 0,
    payments: 0,
    renewals: 0,
    // Clientes atribuidos que efectivamente pagaron alguna vez. Mide la
    // calidad de la venta, no solo el volumen de altas.
    payingClients: 0,
  };
  let latestClientTime = null;

  for (const client of clients) {
    const createdAt = toTime(client.createdAt);
    const expiresAt = toTime(client.subscriptionExpiresAt);
    const subscriptionState = getSubscriptionState(
      client.subscription,
      client.subscriptionExpiresAt,
      now,
    );
    const effectivePlan = subscriptionState.effectivePlan;

    if (client.active) metrics.activeAccounts += 1;
    if (client.menu) metrics.withMenu += 1;
    if (
      createdAt !== null &&
      createdAt >= thirtyDaysAgo &&
      createdAt <= nowTime
    ) {
      metrics.newClients30d += 1;
    }
    if (createdAt !== null && (latestClientTime === null || createdAt > latestClientTime)) {
      latestClientTime = createdAt;
      metrics.lastClientAt = client.createdAt;
    }

    if (effectivePlan === "basic" || effectivePlan === "pro") {
      metrics.paidCurrent += 1;
      metrics.plans[effectivePlan] += 1;
      if (expiresAt !== null && expiresAt > nowTime && expiresAt <= thirtyDaysAhead) {
        metrics.expiring30d += 1;
      }
    } else if (subscriptionState.subscriptionStatus === "expired") {
      metrics.expired += 1;
    }

    const revenue = revenueByClient.get(String(client._id));
    if (revenue) {
      metrics.revenueTotal += revenue.revenueTotal || 0;
      metrics.revenue30d += revenue.revenue30d || 0;
      metrics.payments += revenue.payments || 0;
      metrics.renewals += revenue.renewals || 0;
      if ((revenue.payments || 0) > 0) metrics.payingClients += 1;
    }
  }

  return metrics;
};

const sellerToSummary = (seller, clients, now = new Date(), revenueByClient = new Map()) => ({
  ...(typeof seller.toObject === "function" ? seller.toObject() : seller),
  metrics: getSellerMetrics(clients, now, revenueByClient),
});

const clientToDTO = (client, now = new Date()) => ({
  _id: client._id,
  username: client.username,
  businessName: client.contactInfo?.businessName || "",
  slug: client.slug || null,
  active: Boolean(client.active),
  menu: Boolean(client.menu),
  subscription: client.subscription,
  effectiveSubscription: getSubscriptionState(
    client.subscription,
    client.subscriptionExpiresAt,
    now,
  ).effectivePlan,
  subscriptionExpiresAt: client.subscriptionExpiresAt || null,
  createdAt: client.createdAt,
});

const groupClientsBySeller = (clients) => {
  const grouped = new Map();
  for (const client of clients) {
    const sellerID = String(client.sellerID || "");
    if (!sellerID) continue;
    const current = grouped.get(sellerID) || [];
    current.push(client);
    grouped.set(sellerID, current);
  }
  return grouped;
};

// Obtener todos los sellers
const getSellers = async (req, res) => {
  try {
    const sellers = await Seller.find().sort({ createdAt: -1 }).lean();
    if (sellers.length === 0) return res.status(200).json([]);

    const clients = await User.find({
      admin: false,
      sellerID: { $in: sellers.map((seller) => seller._id) },
    })
      .select(CLIENT_FIELDS)
      .sort({ createdAt: -1 })
      .lean();
    const clientsBySeller = groupClientsBySeller(clients);
    const now = new Date();
    // Una sola agregación para todos los clientes de todos los vendedores, no
    // una por vendedor: el listado tiene que seguir siendo una sola pasada.
    const revenueByClient = await getRevenueByClient(
      clients.map((client) => client._id),
      now,
    );

    res.status(200).json(
      sellers.map((seller) =>
        sellerToSummary(
          seller,
          clientsBySeller.get(String(seller._id)) || [],
          now,
          revenueByClient,
        ),
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
};

// Obtener seller por ID
const getSellerById = async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id).lean();

    if (!seller) {
      return res.status(404).json({
        message: "Vendedor no encontrado",
      });
    }

    const clients = await User.find({
      admin: false,
      sellerID: seller._id,
    })
      .select(CLIENT_FIELDS)
      .sort({ createdAt: -1 })
      .lean();
    const now = new Date();
    const revenueByClient = await getRevenueByClient(
      clients.map((client) => client._id),
      now,
    );

    res.status(200).json({
      ...sellerToSummary(seller, clients, now, revenueByClient),
      clients: clients.map((client) => clientToDTO(client, now)),
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Crear seller
const createSeller = async (req, res) => {
  try {
    const { name, dni } = req.body;

    // Validar datos obligatorios
    if (!name || !dni) {
      return res.status(400).json({
        message: "El nombre y el DNI son obligatorios",
      });
    }

    // Verificar si ya existe un seller con ese nombre
    const existingName = await Seller.findOne({ name });

    if (existingName) {
      return res.status(409).json({
        message: "Ya existe un vendedor con ese nombre",
      });
    }

    // Verificar si ya existe un seller con ese DNI
    const existingDni = await Seller.findOne({ dni });

    if (existingDni) {
      return res.status(409).json({
        message: "Ya existe un vendedor con ese DNI",
      });
    }

    // Generar código único
    let code;
    let existingCode;

    do {
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const numbers = "0123456789";

      let randomLetters = "";
      let randomNumbers = "";

      for (let i = 0; i < 3; i++) {
        randomLetters += letters.charAt(
          Math.floor(Math.random() * letters.length)
        );
      }

      for (let i = 0; i < 3; i++) {
        randomNumbers += numbers.charAt(
          Math.floor(Math.random() * numbers.length)
        );
      }

      code = `${randomLetters}-${randomNumbers}`;

      existingCode = await Seller.findOne({ code });
    } while (existingCode);

    // Crear seller
    const seller = await Seller.create({
      name,
      dni,
      code,
    });

    res.status(201).json(seller);
  } catch (error) {
    // Manejar duplicados de MongoDB
    if (error.code === 11000) {
      return res.status(409).json({
        message: "El vendedor ya existe",
      });
    }

    handleError(res, error);
  }
};

// Modificar seller
const updateSeller = async (req, res) => {
  try {
    const { name, dni } = req.body;

    const seller = await Seller.findById(req.params.id);

    if (!seller) {
      return res.status(404).json({
        message: "Vendedor no encontrado",
      });
    }

    // Verificar nombre duplicado
    if (name && name !== seller.name) {
      const existingName = await Seller.findOne({
        name,
        _id: { $ne: seller._id },
      });

      if (existingName) {
        return res.status(409).json({
          message: "Ya existe un vendedor con ese nombre",
        });
      }

      seller.name = name;
    }

    // Verificar DNI duplicado
    if (dni && dni !== seller.dni) {
      const existingDni = await Seller.findOne({
        dni,
        _id: { $ne: seller._id },
      });

      if (existingDni) {
        return res.status(409).json({
          message: "Ya existe un vendedor con ese DNI",
        });
      }

      seller.dni = dni;
    }

    await seller.save();

    res.status(200).json(seller);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "El vendedor ya existe",
      });
    }

    handleError(res, error);
  }
};

// Eliminar seller
const deleteSeller = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndDelete(req.params.id);

    if (!seller) {
      return res.status(404).json({
        message: "Vendedor no encontrado",
      });
    }

    res.status(200).json({
      message: "Vendedor eliminado correctamente",
      seller,
    });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = {
  getSellers,
  getSellerById,
  createSeller,
  updateSeller,
  deleteSeller,
  getSellerMetrics,
  clientToDTO,
};

