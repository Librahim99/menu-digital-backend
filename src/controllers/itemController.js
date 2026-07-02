const Item = require("../models/Item");
const Menu = require("../models/Menu");
const { hasMinPlan, FREE_ITEM_LIMIT } = require("../config/plans");

// ──────────────────────────────────────────────
// Helper: verifica que el menuID pertenezca al user autenticado.
// Se usa en todas las funciones para garantizar ownership.
// ──────────────────────────────────────────────
const verifyMenuOwnership = async (menuID, userID) => {
  const menu = await Menu.findById(menuID);
  if (!menu) return { error: "Menú no encontrado", status: 404 };
  if (menu.userID.toString() !== userID.toString())
    return { error: "No autorizado", status: 403 };
  return { menu };
};

// ──────────────────────────────────────────────
// @desc    Crear un nuevo item en una categoría
// @route   POST /api/items
// @access  Private
// ──────────────────────────────────────────────
const newItem = async (req, res) => {
  try {
    const {
      menuID, code, title, description, price, image,
      offerPrice, offerRange, options, isExtra, recommended, apt, hidden, available
    } = req.body;
 
    const { error, status } = await verifyMenuOwnership(menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });

    // Plan gratuito: tope de productos totales (todas las categorías juntas).
    // A partir del plan mensual ("menu_ilimitado") no hay tope.
    if (!hasMinPlan(req.user.subscription, "monthly")) {
      const userMenuIDs = (await Menu.find({ userID: req.user._id }).select("_id")).map((m) => m._id);
      const itemCount = await Item.countDocuments({ menuID: { $in: userMenuIDs } });
      if (itemCount >= FREE_ITEM_LIMIT) {
        return res.status(403).json({
          message: `Alcanzaste el límite de ${FREE_ITEM_LIMIT} productos del plan gratuito. Mejorá tu plan para agregar productos ilimitados.`,
        });
      }
    }

    // Verifica que el código sea único dentro del menú
    const existingItem = await Item.findOne({ code });
    if (existingItem) return res.status(400).json({ message: "Código de item ya existe en este menú" });
    const item = await Item.create({
        menuID, code, title, description, price, image,
        offerPrice, offerRange, options, isExtra, recommended, apt, hidden, available
      });
        res.status(201).json(item) 
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Editar campos de contenido de un item
//          (título, descripción, precios, opciones, etc.)
//          No mueve el item entre categorías — para eso está moveItem.
//          No cambia imagen — para eso está uploadImage.
//          No cambia hidden/available — para eso están setHidden/setAvailable.
// @route   PUT /api/items/:itemID
// @access  Private
// ──────────────────────────────────────────────
const editItem = async (req, res) => {
  try {
    const item = await Item.findById(req.params.itemID);
    if (!item) return res.status(404).json({ message: "Item no encontrado" });
 
    const { error, status } = await verifyMenuOwnership(item.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });
 
    const allowedFields = [
  "code",
  "title",
  "description",
  "price",
  "image",
  "offerPrice",
  "offerRange",
  "options",
  "isExtra",
  "recommended",
  "apt",
];
 
    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });
 const existingItemWithCode = await Item.findOne({ code: updates.code });
  if(existingItemWithCode && existingItemWithCode._id.toString() !== item._id.toString()) {
    return res.status(400).json({ message: "Código de item ya existe" });
  }

    const updated = await Item.findByIdAndUpdate(
      req.params.itemID,
      { $set: updates },
      { new: true, runValidators: true }
    );
 
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Mover un item a otra categoría (drag & drop entre categorías)
//          Verifica ownership tanto de la categoría origen como la destino.
// @route   PATCH /api/items/:itemID/move
// @access  Private
// ──────────────────────────────────────────────
const moveItem = async (req, res) => {
  try {
    const { menuID: newMenuID } = req.body;
    if (!newMenuID) return res.status(400).json({ message: "menuID destino requerido" });
 
    const item = await Item.findById(req.params.itemID);
    if (!item) return res.status(404).json({ message: "Item no encontrado" });
 
    // Verifica ownership del menú origen
    const { error: errorOrigen, status: statusOrigen } = await verifyMenuOwnership(item.menuID, req.user._id);
    if (errorOrigen) return res.status(statusOrigen).json({ message: errorOrigen });
 
    // Verifica ownership del menú destino
    const { error: errorDestino, status: statusDestino } = await verifyMenuOwnership(newMenuID, req.user._id);
    if (errorDestino) return res.status(statusDestino).json({ message: errorDestino });
 
    const updated = await Item.findByIdAndUpdate(
      req.params.itemID,
      { menuID: newMenuID },
      { new: true }
    );
 
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Subir imagen de un item
// @route   POST /api/items/:itemID/upload-image
// @access  Private
// ──────────────────────────────────────────────
const uploadImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No se recibió ningún archivo" });
 
    const item = await Item.findById(req.params.itemID);
    if (!item) return res.status(404).json({ message: "Item no encontrado" });
 
    const { error, status } = await verifyMenuOwnership(item.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });
 
    const updated = await Item.findByIdAndUpdate(
      req.params.itemID,
      { image: req.file.path }, // Cloudinary devuelve la URL en req.file.path
      { new: true }
    );
 
    res.json({ imageUrl: req.file.path, item: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Ocultar/mostrar un item del menú público
// @route   PATCH /api/items/:itemID/hidden
// @access  Private
// ──────────────────────────────────────────────
const setHidden = async (req, res) => {
  try {
    const { hidden } = req.body;
    if (typeof hidden !== "boolean") return res.status(400).json({ message: "hidden debe ser un booleano" });
 
    const item = await Item.findById(req.params.itemID);
    if (!item) return res.status(404).json({ message: "Item no encontrado" });
 
    const { error, status } = await verifyMenuOwnership(item.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });
 
    const updated = await Item.findByIdAndUpdate(req.params.itemID, { hidden }, { new: true });
    res.json({ hidden: updated.hidden });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Marcar un item como disponible o no disponible
// @route   PATCH /api/items/:itemID/available
// @access  Private
// ──────────────────────────────────────────────
const setAvailable = async (req, res) => {
  try {
    const { available } = req.body;
    if (typeof available !== "boolean") return res.status(400).json({ message: "available debe ser un booleano" });
 
    const item = await Item.findById(req.params.itemID);
    if (!item) return res.status(404).json({ message: "Item no encontrado" });
 
    const { error, status } = await verifyMenuOwnership(item.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });
 
    const updated = await Item.findByIdAndUpdate(req.params.itemID, { available }, { new: true });
    res.json({ available: updated.available });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Eliminar un item del menú
// @route   DELETE /api/items/:itemID   
// @access  Private
// ──────────────────────────────────────────────

const deleteItem = async (req, res) => {
  try {
    const item = await Item.findById(req.params.itemID);
    if (!item) return res.status(404).json({ message: "Item no encontrado" });
      
      const { error, status } = await verifyMenuOwnership(item.menuID, req.user._id);
      if (error) return res.status(status).json({ message: error });

    await Item.findByIdAndDelete(req.params.itemID);
    res.json({ message: "Item eliminado" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};  

module.exports = {
  newItem,
  editItem,
  moveItem,
  uploadImage,
  setHidden,
  setAvailable,
  deleteItem
};