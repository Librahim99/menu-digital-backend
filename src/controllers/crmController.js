const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const { handleError } = require("../utils/handleError");
const User = require("../models/User");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const CrmProfile = require("../models/CrmProfile");
const { STAGES } = CrmProfile;

const STAGE_LABEL = {
  lead: "Lead",
  onboarding: "Onboarding",
  activo: "Activo",
  en_riesgo: "En riesgo",
  baja: "Baja",
};

const PLAN_LABEL = { free: "Gratis", basic: "Básico", pro: "Pro" };

// Todas las rutas de este controller ya pasan por protect + isAdmin (ver
// crmRoutes), así que acá no re-chequeamos permisos.

// Perfil "por defecto" que devolvemos cuando un cliente todavía no tiene CRM
// creado — así el front siempre recibe la misma forma sin tener que crear la
// fila hasta que el CEO realmente escriba algo.
const defaultProfile = () => ({ stage: "lead", tags: [], nextFollowUp: null, notes: [] });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// ──────────────────────────────────────────────
// @desc    Lista de clientes (locales) enriquecida con su etapa de CRM,
//          para el tablero del CRM. Dos queries (users + profiles) que se
//          cruzan en memoria — evita un N+1.
// @route   GET /api/admin/crm/clients
// @access  Admin
// ──────────────────────────────────────────────
const listClients = async (req, res) => {
  try {
    const users = await User.find({ admin: false })
      .select("username slug subscription active createdAt contactInfo.businessName")
      .sort({ createdAt: -1 });

    const profiles = await CrmProfile.find({ userID: { $in: users.map((u) => u._id) } })
      .select("userID stage tags nextFollowUp");

    const byUser = {};
    profiles.forEach((p) => { byUser[p.userID.toString()] = p; });

    const clients = users.map((u) => {
      const p = byUser[u._id.toString()];
      return {
        _id: u._id,
        username: u.username,
        businessName: u.contactInfo?.businessName || "",
        slug: u.slug,
        subscription: u.subscription,
        active: u.active,
        createdAt: u.createdAt,
        stage: p?.stage || "lead",
        tags: p?.tags || [],
        nextFollowUp: p?.nextFollowUp || null,
      };
    });

    res.json({ clients, stages: STAGES });
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

    const user = await User.findById(userID).select("-password");
    if (!user) return res.status(404).json({ message: "Cliente no encontrado" });

    const profile = await CrmProfile.findOne({ userID }).populate("notes.author", "username");

    // Resumen de actividad (cuántas categorías/secciones/productos cargó).
    const menus = await Menu.find({ userID }).select("_id section");
    const menuIds = menus.map((m) => m._id);
    const itemCount = await Item.countDocuments({ menuID: { $in: menuIds } });
    const categoryCount = menus.filter((m) => !m.section).length;
    const sectionCount = menus.filter((m) => m.section).length;

    res.json({
      user,
      crm: profile || defaultProfile(),
      activity: { categoryCount, sectionCount, itemCount },
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
    const exists = await User.exists({ _id: userID });
    if (!exists) return res.status(404).json({ message: "Cliente no encontrado" });

    const { stage, tags, nextFollowUp } = req.body;
    const updates = {};

    if (stage !== undefined) {
      if (!STAGES.includes(stage)) return res.status(400).json({ message: "Etapa inválida" });
      updates.stage = stage;
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return res.status(400).json({ message: "tags debe ser un array" });
      updates.tags = tags.map((t) => String(t).trim()).filter(Boolean);
    }
    if (nextFollowUp !== undefined) {
      updates.nextFollowUp = nextFollowUp ? new Date(nextFollowUp) : null;
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

    const exists = await User.exists({ _id: userID });
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
    const count = await CrmProfile.countDocuments({ nextFollowUp: { $ne: null, $lt: new Date() } });
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
      .select("username slug subscription active createdAt contactInfo.businessName")
      .sort({ createdAt: -1 });

    const profiles = await CrmProfile.find({ userID: { $in: users.map((u) => u._id) } })
      .select("userID stage tags nextFollowUp");
    const byUser = {};
    profiles.forEach((p) => { byUser[p.userID.toString()] = p; });

    const rows = users
      .map((u) => {
        const p = byUser[u._id.toString()];
        return {
          businessName: u.contactInfo?.businessName || "",
          username: u.username,
          slug: u.slug || "",
          subscription: u.subscription,
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
