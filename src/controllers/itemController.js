const Item = require("../models/Item");
const Menu = require("../models/Menu");

// ──────────────────────────────────────────────
// Helper: verifica que el menuID pertenezca al user autenticado
// ──────────────────────────────────────────────
const verifyMenuOwnership = async (menuID, userID) => {
  const menu = await Menu.findById(menuID);
  if (!menu) return { error: "Menú no encontrado", status: 404 };
  if (menu.userID.toString() !== userID.toString())
    return { error: "No autorizado", status: 403 };
  return { menu };
};

// ──────────────────────────────────────────────
// @desc    Crear un nuevo item en un menú
// @route   POST /api/items
// @access  Private
// ──────────────────────────────────────────────
const newItem = async (req, res) => {
  try {
    const { menuID, title, description, price, offerPrice, offerDate, options, isExtra, recommended, code, apt } = req.body;

    const { error, status } = await verifyMenuOwnership(menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });

    const item = await Item.create({
      menuID,
      title,
      description,
      price,
      offerPrice,
      offerDate,
      options,
      isExtra,
      recommended,
      code,
      apt,
    });

    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Editar un item existente
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
      "title", "description", "price", "offerPrice", "offerDate",
      "options", "image", "available", "isExtra", "recommended",
      "hidden", "code", "apt",
    ];

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

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
// @desc    Editar múltiples items a la vez (ej: reordenar, cambiar precios en lote)
// @route   PUT /api/items/massive
// @access  Private
// Body: { items: [{ _id, ...campos }] }
// ──────────────────────────────────────────────
const editItemMassive = async (req, res) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Se requiere un array de items" });
    }

    // Ejecuta todas las actualizaciones en paralelo
    const updatePromises = items.map(({ _id, ...fields }) =>
      Item.findByIdAndUpdate(_id, { $set: fields }, { new: true })
    );

    const updated = await Promise.all(updatePromises);

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
    if (!req.file) {
      return res.status(400).json({ message: "No se recibió ningún archivo" });
    }

    const item = await Item.findById(req.params.itemID);
    if (!item) return res.status(404).json({ message: "Item no encontrado" });

    const { error, status } = await verifyMenuOwnership(item.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });

    // Cloudinary devuelve la URL pública en req.file.path
    const imageUrl = req.file.path;

    const updated = await Item.findByIdAndUpdate(
      req.params.itemID,
      { image: imageUrl },
      { new: true }
    );

    res.json({ imageUrl, item: updated });
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

    if (typeof hidden !== "boolean") {
      return res.status(400).json({ message: "hidden debe ser un booleano" });
    }

    const item = await Item.findById(req.params.itemID);
    if (!item) return res.status(404).json({ message: "Item no encontrado" });

    const { error, status } = await verifyMenuOwnership(item.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });

    const updated = await Item.findByIdAndUpdate(
      req.params.itemID,
      { hidden },
      { new: true }
    );

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

    if (typeof available !== "boolean") {
      return res.status(400).json({ message: "available debe ser un booleano" });
    }

    const item = await Item.findById(req.params.itemID);
    if (!item) return res.status(404).json({ message: "Item no encontrado" });

    const { error, status } = await verifyMenuOwnership(item.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });

    const updated = await Item.findByIdAndUpdate(
      req.params.itemID,
      { available },
      { new: true }
    );

    res.json({ available: updated.available });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  newItem,
  editItem,
  editItemMassive,
  uploadImage,
  setHidden,
  setAvailable,
};