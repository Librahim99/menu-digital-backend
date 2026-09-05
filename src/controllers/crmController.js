const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const { handleError } = require("../utils/handleError");
const User = require("../models/User");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const CrmProfile = require("../models/CrmProfile");
const PaymentTransaction = require("../models/PaymentTransaction");
const PageView = require("../models/PageView");
const Seller = require("../models/Seller");
const { buenosAiresDateStr } = require("../utils/dates");
const { getSubscriptionState } = require("../config/plans");
const { STAGES } = CrmProfile;

const STAGE_LABEL = {
  lead: "Lead",
  onboarding: "Onboarding",
  activo: "Activo",
  en_riesgo: "En riesgo",
  baja: "Baja",
};

const PLAN_LABEL = { free: "Gratis", basic: "Básico", pro: "Pro" };
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Todas las rutas de este controller ya pasan por protect + isAdmin (ver
// crmRoutes), así que acá no re-chequeamos permisos.

// Perfil "por defecto" que devolvemos cuando un cliente todavía no tiene CRM
// creado — así el front siempre recibe la misma forma sin tener que crear la
// fila hasta que el CEO realmente escriba algo.
const defaultProfile = () => ({ stage: "lead", tags: [], nextFollowUp: null, notes: [] });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const buildOnboardingStatus = ({ user, categoryCount, itemCount }) => {
  const businessName = user.contactInfo?.businessName || "";
  const address = user.contactInfo?.address || "";
  const checks = {
    businessInfo: Boolean(businessName.trim() && address.trim()),
    contactChannel: Boolean(user.contactInfo?.mail?.trim() || user.contactInfo?.number),
    schedule: DAY_KEYS.some((day) => Boolean(user.schedule?.[day]?.enabled)),
    branding: Boolean(user.media?.backgroundPicture || user.media?.pictures?.length),
    menuStructure: categoryCount > 0,
    products: itemCount > 0,
    publicMenu: Boolean(user.active && user.slug && itemCount > 0),
  };
  const completedCount = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    ...checks,
    completedCount,
    total,
    completed: completedCount === total,
  };
};

// ──────────────────────────────────────────────
// @desc    Lista 360 de clientes enriquecida con CRM, onboarding, último pago
//          y señales operativas. Las colecciones relacionadas se consultan en
//          lote y se cruzan en memoria para evitar N+1.
// @route   GET /api/admin/crm/clients
// @access  Admin
// ──────────────────────────────────────────────
const listClients = async (req, res) => {
  try {
    const users = await User.find({ admin: false })
      .select(
        "username slug subscription subscriptionExpiresAt active createdAt sellerID menu " +
        "contactInfo.businessName contactInfo.mail contactInfo.number contactInfo.address " +
        "media.pictures media.backgroundPicture schedule"
      )
      .sort({ createdAt: -1 });

    const userIDs = users.map((user) => user._id);

    // Ventanas de tráfico. PageView.date es "YYYY-MM-DD" en horario de Buenos
    // Aires, así que se comparan strings (ordenables por construcción) en vez
    // de rangos de Date: es el formato con el que la colección ya está escrita.
    // Se piden 60 días para poder contrastar los últimos 30 contra los 30
    // previos y mostrar tendencia, no solo un número suelto.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const startedAt = new Date();
    const currentWindowStart = buenosAiresDateStr(new Date(startedAt.getTime() - (29 * DAY_MS)));
    const previousWindowStart = buenosAiresDateStr(new Date(startedAt.getTime() - (59 * DAY_MS)));

    const [profiles, menus, paymentRows, viewRows] = await Promise.all([
      CrmProfile.find({ userID: { $in: userIDs } })
        .select("userID stage tags nextFollowUp"),
      Menu.find({ userID: { $in: userIDs } })
        .select("_id userID section"),
      PaymentTransaction.aggregate([
        { $match: { userID: { $in: userIDs } } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$userID",
            latestPayment: {
              $first: {
                status: "$status",
                entitlementStatus: "$entitlementStatus",
                amount: "$amount",
                currency: "$currency",
                createdAt: { $ifNull: ["$paymentCreatedAt", "$createdAt"] },
              },
            },
            attentionCount: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      {
                        $and: [
                          { $eq: ["$status", "approved"] },
                          { $ne: ["$entitlementStatus", "applied"] },
                        ],
                      },
                      { $eq: ["$checkoutValidation", "failed"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      PageView.aggregate([
        {
          $match: {
            userID: { $in: userIDs },
            date: { $gte: previousWindowStart },
          },
        },
        {
          $group: {
            _id: "$userID",
            last30d: {
              $sum: {
                $cond: [{ $gte: ["$date", currentWindowStart] }, "$count", 0],
              },
            },
            previous30d: {
              $sum: {
                $cond: [{ $lt: ["$date", currentWindowStart] }, "$count", 0],
              },
            },
          },
        },
      ]),
    ]);

    // Vendedor que trajo cada cuenta: `sellerID` vive en User desde siempre,
    // pero nunca se resolvía acá, así que desde la ficha del cliente no había
    // forma de saber de quién era la venta.
    const sellerIDs = [...new Set(
      users.filter((u) => u.sellerID).map((u) => u.sellerID.toString())
    )];
    const sellers = sellerIDs.length
      ? await Seller.find({ _id: { $in: sellerIDs } }).select("name code")
      : [];
    const sellersByID = new Map(
      sellers.map((seller) => [seller._id.toString(), seller])
    );

    const menuIDs = menus.map((menu) => menu._id);
    const itemRows = menuIDs.length
      ? await Item.aggregate([
          { $match: { menuID: { $in: menuIDs } } },
          { $group: { _id: "$menuID", count: { $sum: 1 } } },
        ])
      : [];

    const profilesByUser = new Map(
      profiles.map((profile) => [profile.userID.toString(), profile])
    );
    const menuStatsByUser = new Map();
    const menuToUser = new Map();
    menus.forEach((menu) => {
      const userKey = menu.userID.toString();
      const current = menuStatsByUser.get(userKey) || {
        categoryCount: 0,
        sectionCount: 0,
        itemCount: 0,
      };
      if (menu.section) current.sectionCount += 1;
      else current.categoryCount += 1;
      menuStatsByUser.set(userKey, current);
      menuToUser.set(menu._id.toString(), userKey);
    });
    itemRows.forEach((row) => {
      const userKey = menuToUser.get(row._id.toString());
      if (!userKey) return;
      const current = menuStatsByUser.get(userKey);
      current.itemCount += row.count;
    });
    const paymentsByUser = new Map(
      paymentRows.map((row) => [row._id.toString(), row])
    );
    const viewsByUser = new Map(
      viewRows.map((row) => [row._id.toString(), row])
    );

    const now = new Date();
    const expiringLimit = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
    const todayCalendarCutoff = new Date(`${buenosAiresDateStr(now)}T00:00:00.000Z`);

    const clients = users.map((u) => {
      const userKey = u._id.toString();
      const p = profilesByUser.get(userKey);
      const menuStats = menuStatsByUser.get(userKey) || {
        categoryCount: 0,
        sectionCount: 0,
        itemCount: 0,
      };
      const payment = paymentsByUser.get(userKey);
      const views = viewsByUser.get(userKey);
      const onboarding = buildOnboardingStatus({
        user: u,
        categoryCount: menuStats.categoryCount,
        itemCount: menuStats.itemCount,
      });
      const subscriptionExpiresAt = u.subscriptionExpiresAt || null;
      const subscriptionState = getSubscriptionState(
        u.subscription,
        subscriptionExpiresAt,
        now
      );
      const attention = [];
      const isOperationalClient = u.active && p?.stage !== "baja";

      if (payment?.attentionCount > 0) attention.push("payment_issue");
      if (isOperationalClient && u.subscription !== "free") {
        if (subscriptionState.subscriptionStatus === "expired") attention.push("subscription_expired");
        else if (!subscriptionExpiresAt) attention.push("subscription_missing_expiry");
        else if (subscriptionExpiresAt <= expiringLimit) attention.push("subscription_expiring");
      }
      if (p?.nextFollowUp && p.nextFollowUp < todayCalendarCutoff) {
        attention.push("follow_up_overdue");
      }
      if (isOperationalClient && !onboarding.completed) attention.push("onboarding_incomplete");

      // Señal temprana de baja: paga, tiene la carta publicada, y aun así
      // nadie la miró en 30 días. Se exige carta publicada para no marcar a
      // quien todavía está en onboarding (ese caso ya lo cubre
      // onboarding_incomplete) y plan pago porque es donde hay plata en juego.
      const viewsLast30d = views?.last30d || 0;
      if (
        isOperationalClient
        && subscriptionState.effectivePlan !== "free"
        && onboarding.publicMenu
        && viewsLast30d === 0
      ) {
        attention.push("no_traffic");
      }

      return {
        _id: u._id,
        username: u.username,
        businessName: u.contactInfo?.businessName || "",
        slug: u.slug,
        subscription: u.subscription,
        effectiveSubscription: subscriptionState.effectivePlan,
        subscriptionStatus: subscriptionState.subscriptionStatus,
        previousSubscription: subscriptionState.previousSubscription,
        downgradeReason: subscriptionState.downgradeReason,
        downgradedAt: subscriptionState.downgradedAt,
        subscriptionExpiresAt,
        active: u.active,
        createdAt: u.createdAt,
        contactInfo: {
          mail: u.contactInfo?.mail || "",
          number: u.contactInfo?.number ?? null,
        },
        stage: p?.stage || "lead",
        tags: p?.tags || [],
        nextFollowUp: p?.nextFollowUp || null,
        onboarding,
        lastPayment: payment?.latestPayment || null,
        paymentAttentionCount: payment?.attentionCount || 0,
        views: {
          last30d: viewsLast30d,
          previous30d: views?.previous30d || 0,
        },
        seller: u.sellerID
          ? (() => {
              const seller = sellersByID.get(u.sellerID.toString());
              return seller
                ? { _id: seller._id, name: seller.name, code: seller.code }
                : null;
            })()
          : null,
        attention,
      };
    });

    res.json({
      clients,
      stages: STAGES,
      attentionSummary: {
        clients: clients.filter((client) => client.attention.length > 0).length,
        paymentIssues: clients.filter((client) => client.attention.includes("payment_issue")).length,
        expiredSubscriptions: clients.filter((client) => client.attention.includes("subscription_expired")).length,
        expiringSubscriptions: clients.filter((client) => client.attention.includes("subscription_expiring")).length,
        missingExpirySubscriptions: clients.filter((client) => client.attention.includes("subscription_missing_expiry")).length,
        overdueFollowUps: clients.filter((client) => client.attention.includes("follow_up_overdue")).length,
        incompleteOnboarding: clients.filter((client) => client.attention.includes("onboarding_incomplete")).length,
        noTraffic: clients.filter((client) => client.attention.includes("no_traffic")).length,
      },
    });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Detalle de un cliente: datos del local + su perfil de CRM (o el
//          default si no tiene) + un resumen de actividad.
// @route   GET /api/admin/crm/clients/:userID
// @access  Admin
// ──────────────────────────────────────────────
const getClient = async (req, res) => {
  try {
    const { userID } = req.params;
    if (!isValidId(userID)) return res.status(400).json({ message: "ID inválido" });

    // El detalle CRM expone un DTO acotado: no entrega el documento User
    // completo ni campos sensibles que el panel no necesita.
    const user = await User.findOne({ _id: userID, admin: false }).select(
      "username slug subscription subscriptionExpiresAt active hasDelivery createdAt " +
      "contactInfo.businessName contactInfo.mail contactInfo.number contactInfo.address " +
      "media.pictures media.backgroundPicture schedule"
    );
    if (!user) return res.status(404).json({ message: "Cliente no encontrado" });

    const [profile, menus] = await Promise.all([
      CrmProfile.findOne({ userID }).populate("notes.author", "username"),
      Menu.find({ userID }).select("_id section"),
    ]);
    const menuIds = menus.map((m) => m._id);
    const itemCount = await Item.countDocuments({ menuID: { $in: menuIds } });
    const categoryCount = menus.filter((m) => !m.section).length;
    const sectionCount = menus.filter((m) => m.section).length;
    // Este resumen se calcula en el servidor para que el frontend solo refleje
    // el estado real del cliente y no duplique criterios operativos.
    const onboarding = buildOnboardingStatus({ user, categoryCount, itemCount });
    const businessName = user.contactInfo?.businessName || "";
    const address = user.contactInfo?.address || "";

    res.json({
      user: {
        _id: user._id,
        username: user.username,
        slug: user.slug || "",
        subscription: user.subscription,
        subscriptionExpiresAt: user.subscriptionExpiresAt || null,
        active: user.active,
        hasDelivery: user.hasDelivery,
        createdAt: user.createdAt,
        contactInfo: {
          businessName,
          mail: user.contactInfo?.mail || "",
          number: user.contactInfo?.number ?? null,
          address,
        },
      },
      crm: profile || defaultProfile(),
      activity: { categoryCount, sectionCount, itemCount },
      onboarding,
    });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Actualizar etapa / tags / próximo seguimiento de un cliente.
//          Crea el perfil si no existía (upsert).
// @route   PATCH /api/admin/crm/clients/:userID
// @access  Admin
// ──────────────────────────────────────────────
const updateProfile = async (req, res) => {
  try {
    const { userID } = req.params;
    if (!isValidId(userID)) return res.status(400).json({ message: "ID inválido" });

    // No creamos un CRM para un userID que no existe (evita perfiles huérfanos).
    const exists = await User.exists({ _id: userID, admin: false });
    if (!exists) return res.status(404).json({ message: "Cliente no encontrado" });

    const { stage, tags, nextFollowUp } = req.body;
    const updates = {};

    if (stage !== undefined) {
      if (!STAGES.includes(stage)) return res.status(400).json({ message: "Etapa inválida" });
      updates.stage = stage;
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return res.status(400).json({ message: "tags debe ser un array" });
      if (tags.some((tag) => typeof tag !== "string")) {
        return res.status(400).json({ message: "Cada tag debe ser texto" });
      }
      updates.tags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    }
    if (nextFollowUp !== undefined) {
      if (!nextFollowUp) {
        updates.nextFollowUp = null;
      } else {
        const parsedDate = new Date(nextFollowUp);
        if (Number.isNaN(parsedDate.getTime())) {
          return res.status(400).json({ message: "Fecha de seguimiento inválida" });
        }
        updates.nextFollowUp = parsedDate;
      }
    }

    const profile = await CrmProfile.findOneAndUpdate(
      { userID },
      { $set: updates },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate("notes.author", "username");

    res.json(profile);
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Agregar una nota al historial de un cliente (la más nueva primero).
// @route   POST /api/admin/crm/clients/:userID/notes
// @access  Admin
// ──────────────────────────────────────────────
const addNote = async (req, res) => {
  try {
    const { userID } = req.params;
    if (!isValidId(userID)) return res.status(400).json({ message: "ID inválido" });

    const { text } = req.body;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ message: "La nota no puede estar vacía" });
    }

    const exists = await User.exists({ _id: userID, admin: false });
    if (!exists) return res.status(404).json({ message: "Cliente no encontrado" });

    const profile = await CrmProfile.findOneAndUpdate(
      { userID },
      { $push: { notes: { $each: [{ text: text.trim(), author: req.user._id }], $position: 0 } } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate("notes.author", "username");

    res.status(201).json(profile);
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Borrar una nota puntual del historial.
// @route   DELETE /api/admin/crm/clients/:userID/notes/:noteID
// @access  Admin
// ──────────────────────────────────────────────
const deleteNote = async (req, res) => {
  try {
    const { userID, noteID } = req.params;
    if (!isValidId(userID) || !isValidId(noteID)) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const profile = await CrmProfile.findOneAndUpdate(
      { userID },
      { $pull: { notes: { _id: noteID } } },
      { new: true }
    ).populate("notes.author", "username");

    res.json(profile || defaultProfile());
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Cantidad de clientes con seguimiento vencido (nextFollowUp en el
//          pasado). Endpoint liviano — lo consulta el sidebar del panel para
//          el badge de alerta, sin traer la lista completa de clientes.
// @route   GET /api/admin/crm/overdue-count
// @access  Admin
// ──────────────────────────────────────────────
const getOverdueCount = async (req, res) => {
  try {
    const todayCalendarCutoff = new Date(`${buenosAiresDateStr()}T00:00:00.000Z`);
    const count = await CrmProfile.countDocuments({
      nextFollowUp: { $ne: null, $lt: todayCalendarCutoff },
    });
    res.json({ count });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Exporta el listado de clientes (opcionalmente filtrado por etapa)
//          a un .xlsx — mismo patrón de ExcelJS que el exportador de menús
//          (massiveController.getTemplate).
// @route   GET /api/admin/crm/export?stage=lead
// @access  Admin
// ──────────────────────────────────────────────
const exportClients = async (req, res) => {
  try {
    const { stage } = req.query;
    if (stage && !STAGES.includes(stage)) {
      return res.status(400).json({ message: "Etapa inválida" });
    }

    const users = await User.find({ admin: false })
      .select("username slug subscription subscriptionExpiresAt active createdAt contactInfo.businessName")
      .sort({ createdAt: -1 });

    const profiles = await CrmProfile.find({ userID: { $in: users.map((u) => u._id) } })
      .select("userID stage tags nextFollowUp");
    const byUser = {};
    profiles.forEach((p) => { byUser[p.userID.toString()] = p; });

    const rows = users
      .map((u) => {
        const p = byUser[u._id.toString()];
        const subscriptionState = getSubscriptionState(
          u.subscription,
          u.subscriptionExpiresAt
        );
        return {
          businessName: u.contactInfo?.businessName || "",
          username: u.username,
          slug: u.slug || "",
          subscription: subscriptionState.effectivePlan,
          previousSubscription: subscriptionState.previousSubscription,
          subscriptionStatus: subscriptionState.subscriptionStatus,
          subscriptionExpiresAt: u.subscriptionExpiresAt || null,
          active: u.active,
          stage: p?.stage || "lead",
          tags: (p?.tags || []).join(", "),
          nextFollowUp: p?.nextFollowUp || null,
          createdAt: u.createdAt,
        };
      })
      .filter((r) => !stage || r.stage === stage);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Menú Digital";
    const sheet = workbook.addWorksheet("Clientes CRM");

    sheet.columns = [
      { header: "Negocio", key: "businessName", width: 30 },
      { header: "Usuario", key: "username", width: 20 },
      { header: "Slug", key: "slug", width: 24 },
      { header: "Plan", key: "subscription", width: 12 },
      { header: "Estado del plan", key: "subscriptionStatus", width: 16 },
      { header: "Vigencia", key: "subscriptionExpiresAt", width: 16 },
      { header: "Estado", key: "active", width: 12 },
      { header: "Etapa", key: "stage", width: 14 },
      { header: "Etiquetas", key: "tags", width: 28 },
      { header: "Próximo seguimiento", key: "nextFollowUp", width: 18 },
      { header: "Cliente desde", key: "createdAt", width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };

    rows.forEach((r) => {
      sheet.addRow({
        businessName: r.businessName,
        username: r.username,
        slug: r.slug,
        subscription: PLAN_LABEL[r.subscription] || r.subscription,
        subscriptionStatus: r.subscriptionStatus === "expired" ? "Downgrade por vencimiento" : "Vigente",
        subscriptionExpiresAt: r.subscriptionExpiresAt
          ? new Date(r.subscriptionExpiresAt).toLocaleDateString("es-AR")
          : "Sin fecha registrada",
        active: r.active ? "Activo" : "Inactivo",
        stage: STAGE_LABEL[r.stage] || r.stage,
        tags: r.tags,
        nextFollowUp: r.nextFollowUp ? new Date(r.nextFollowUp).toLocaleDateString("es-AR") : "",
        createdAt: new Date(r.createdAt).toLocaleDateString("es-AR"),
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=crm-clientes${stage ? `-${stage}` : ""}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    handleError(res, err);
  }
};

module.exports = { listClients, getClient, updateProfile, addNote, deleteNote, getOverdueCount, exportClients };
