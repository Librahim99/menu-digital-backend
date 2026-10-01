const mongoose = require("mongoose");
const AdminNotification = require("../models/AdminNotification");
const { handleError } = require("../utils/handleError");

// ──────────────────────────────────────────────
// Bandeja de notificaciones del panel admin. Cada admin solo ve y toca sus
// propias copias: todos los filtros llevan userID: req.user._id, así un ID
// ajeno se comporta igual que uno inexistente (404).
// ──────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// Tope de IDs por acción masiva: alcanza para "seleccionar todo" en una
// página y corta bodies abusivos.
const MAX_BULK_IDS = 200;

const BULK_ACTIONS = new Set(["read", "unread", "archive", "unarchive", "delete"]);

const toPositiveInt = (value, fallback) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const notificationToDTO = (notification) => ({
  id: String(notification._id),
  eventID: notification.eventID,
  type: notification.type,
  title: notification.title,
  body: notification.body,
  url: notification.url,
  read: Boolean(notification.readAt),
  readAt: notification.readAt || null,
  archived: Boolean(notification.archivedAt),
  archivedAt: notification.archivedAt || null,
  createdAt: notification.createdAt,
});

// Las no leídas que importan son las de la bandeja de entrada: archivar un
// aviso sin leerlo lo saca del contador.
const countUnread = (userID) => AdminNotification.countDocuments({
  userID,
  archivedAt: null,
  readAt: null,
});

// @desc    Lista la bandeja del admin logueado
// @route   GET /api/admin/notifications?box=inbox|archived&status=all|unread|read&page&limit
// @access  Admin
const listNotifications = async (req, res) => {
  try {
    const box = req.query.box === "archived" ? "archived" : "inbox";
    const status = ["unread", "read"].includes(req.query.status) ? req.query.status : "all";
    const page = toPositiveInt(req.query.page, 1);
    const limit = Math.min(toPositiveInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);

    const filter = {
      userID: req.user._id,
      archivedAt: box === "archived" ? { $ne: null } : null,
    };
    if (status === "unread") filter.readAt = null;
    if (status === "read") filter.readAt = { $ne: null };

    const [notifications, total, unreadCount] = await Promise.all([
      AdminNotification.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AdminNotification.countDocuments(filter),
      countUnread(req.user._id),
    ]);

    res.json({
      notifications: notifications.map(notificationToDTO),
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Cantidad de no leídas (badge de la sidebar)
// @route   GET /api/admin/notifications/unread-count
// @access  Admin
const getUnreadCount = async (req, res) => {
  try {
    res.json({ unreadCount: await countUnread(req.user._id) });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Abre una notificación: la devuelve y la marca como leída
// @route   GET /api/admin/notifications/:id
// @access  Admin
const openNotification = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ message: "Notificación no encontrada" });
    }

    // readAt solo se setea la primera vez: reabrirla no pisa cuándo se leyó.
    const notification = await AdminNotification.findOneAndUpdate(
      { _id: id, userID: req.user._id },
      [{ $set: { readAt: { $ifNull: ["$readAt", "$$NOW"] } } }],
      { new: true }
    ).lean();

    if (!notification) {
      return res.status(404).json({ message: "Notificación no encontrada" });
    }
    res.json(notificationToDTO(notification));
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Marca como leída/no leída y archiva/desarchiva una notificación
// @route   PATCH /api/admin/notifications/:id   body: { read?: boolean, archived?: boolean }
// @access  Admin
const updateNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const { read, archived } = req.body || {};

    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ message: "Notificación no encontrada" });
    }
    if (
      (read !== undefined && typeof read !== "boolean")
      || (archived !== undefined && typeof archived !== "boolean")
      || (read === undefined && archived === undefined)
    ) {
      return res.status(400).json({ message: "Indicá read y/o archived como true o false" });
    }

    const now = new Date();
    const $set = {};
    if (read !== undefined) $set.readAt = read ? now : null;
    if (archived !== undefined) $set.archivedAt = archived ? now : null;

    const notification = await AdminNotification.findOneAndUpdate(
      { _id: id, userID: req.user._id },
      { $set },
      { new: true }
    ).lean();

    if (!notification) {
      return res.status(404).json({ message: "Notificación no encontrada" });
    }
    res.json(notificationToDTO(notification));
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Elimina definitivamente una notificación (solo la copia de este admin)
// @route   DELETE /api/admin/notifications/:id
// @access  Admin
const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ message: "Notificación no encontrada" });
    }

    const result = await AdminNotification.deleteOne({ _id: id, userID: req.user._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Notificación no encontrada" });
    }
    res.status(204).end();
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Acción sobre varias notificaciones seleccionadas
// @route   POST /api/admin/notifications/bulk   body: { ids: string[], action }
// @access  Admin
const bulkUpdateNotifications = async (req, res) => {
  try {
    const { ids, action } = req.body || {};

    if (!BULK_ACTIONS.has(action)) {
      return res.status(400).json({ message: "Acción inválida" });
    }
    if (
      !Array.isArray(ids)
      || ids.length === 0
      || ids.length > MAX_BULK_IDS
      || !ids.every((id) => typeof id === "string" && mongoose.isValidObjectId(id))
    ) {
      return res.status(400).json({ message: "Selección de notificaciones inválida" });
    }

    const filter = { _id: { $in: ids }, userID: req.user._id };
    const now = new Date();
    let affected;

    if (action === "delete") {
      affected = (await AdminNotification.deleteMany(filter)).deletedCount;
    } else {
      const $set = {
        read: { readAt: now },
        unread: { readAt: null },
        archive: { archivedAt: now },
        unarchive: { archivedAt: null },
      }[action];
      // "read" no pisa el readAt de las que ya estaban leídas.
      if (action === "read") filter.readAt = null;
      affected = (await AdminNotification.updateMany(filter, { $set })).modifiedCount;
    }

    res.json({ affected, unreadCount: await countUnread(req.user._id) });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Marca como leídas todas las de la bandeja de entrada
// @route   POST /api/admin/notifications/read-all
// @access  Admin
const markAllRead = async (req, res) => {
  try {
    const result = await AdminNotification.updateMany(
      { userID: req.user._id, archivedAt: null, readAt: null },
      { $set: { readAt: new Date() } }
    );
    res.json({ affected: result.modifiedCount, unreadCount: 0 });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Marca como leída la copia de este admin de un aviso, por eventID.
//          La usa el panel al abrirse desde el click en una push, que solo
//          conoce el eventID (es el mismo para todos los admins).
// @route   POST /api/admin/notifications/events/:eventID/read
// @access  Admin
const markEventRead = async (req, res) => {
  try {
    const { eventID } = req.params;
    if (typeof eventID !== "string" || eventID.length > 100) {
      return res.status(400).json({ message: "Evento inválido" });
    }

    await AdminNotification.updateOne(
      { eventID, userID: req.user._id, readAt: null },
      { $set: { readAt: new Date() } }
    );
    res.json({ unreadCount: await countUnread(req.user._id) });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = {
  listNotifications,
  getUnreadCount,
  openNotification,
  updateNotification,
  deleteNotification,
  bulkUpdateNotifications,
  markAllRead,
  markEventRead,
  notificationToDTO,
};
