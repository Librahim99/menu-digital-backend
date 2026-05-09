const Menu = require("../models/Menu");
const User = require("../models/User");
const multer = require("multer");
const path = require("path");

// ──────────────────────────────────────────────
// @desc    Crear una nueva categoría/sección de menú
// @route   POST /api/menus
// @access  Private
// ──────────────────────────────────────────────
const newMenu = async (req, res) => {
  try {
    const { title, description, code, sectionID, section } = req.body;

    const menu = await Menu.create({
      userID: req.user._id,
      title,
      description: description || null,
      code,
      sectionID: sectionID || null,
      section: section || false,
    });

    // Marca al user como que ya tiene menú creado
    await User.findByIdAndUpdate(req.user._id, { menu: true });

    res.status(201).json(menu);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Editar una categoría del menú
// @route   PUT /api/menus/:menuID
// @access  Private
// ──────────────────────────────────────────────
const editMenu = async (req, res) => {
  try {
    const menu = await Menu.findById(req.params.menuID);

    if (!menu) {
      return res.status(404).json({ message: "Menú no encontrado" });
    }

    // Verifica que el menú pertenezca al user autenticado
    if (menu.userID.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "No autorizado" });
    }

    const allowedFields = ["title", "description", "code", "sectionID", "section", "image"];
    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await Menu.findByIdAndUpdate(
      req.params.menuID,
      { $set: updates },
      { new: true, runValidators: true }
    );

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};



const hideMenu = async (req, res) => {
  try {
    const menu = await Menu.findById(req.params.menuID);
    const { hidden } = req.body;

    if (typeof hidden !== "boolean") {
      return res.status(400).json({ message: "hidden debe ser un booleano" });
    }
    
    if (!menu) {
      return res.status(404).json({ message: "Menú no encontrado" });
    }

    // Verifica que el menú pertenezca al user autenticado
    if (menu.userID.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "No autorizado" });
    }


    const updated = await Menu.findByIdAndUpdate(
      req.params.menuID,
      { hidden },
      { new: true }
    );

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Subir imagen para una categoría del menú
// @route   POST /api/menus/:menuID/upload-image
// @access  Private
// ──────────────────────────────────────────────
const uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No se recibió ningún archivo" });
    }

    const menu = await Menu.findById(req.params.menuID);

    if (!menu) return res.status(404).json({ message: "Menú no encontrado" });
    if (menu.userID.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "No autorizado" });
    }

    // Cloudinary devuelve la URL pública en req.file.path
    const imageUrl = req.file.path;

    const updated = await Menu.findByIdAndUpdate(
      req.params.menuID,
      { image: imageUrl },
      { new: true }
    );

    res.json({ imageUrl, menu: updated });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Obtener el menú completo de un local por su businessName (ruta pública)
// @route   GET /api/menus/public/:businessName
// @access  Public (vista del cliente final)
// ──────────────────────────────────────────────
const uploadMenu = async (req, res) => {
  try {
    const { businessName } = req.params;

    // Busca el user por businessName en contactInfo
    const user = await User.findOne({
      "contactInfo.businessName": businessName,
      active: true,
    });

    if (!user) {
      return res.status(404).json({ message: "Local no encontrado" });
    }

    // Trae todas las categorías del menú de ese local
    const menus = await Menu.find({ userID: user._id });

    res.json({ user, menus });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { newMenu,hideMenu, editMenu, uploadImage, uploadMenu };