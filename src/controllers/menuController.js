const { handleError } = require("../utils/handleError");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const User = require("../models/User");

// ──────────────────────────────────────────────
// Helper: verifica ownership del menú
// ──────────────────────────────────────────────
const verifyOwnership = async (menuID, userID) => {
  const menu = await Menu.findById(menuID);
  if (!menu) return { error: "Menú no encontrado", status: 404 };
  if (menu.userID.toString() !== userID.toString())
    return { error: "No autorizado", status: 403 };
  return { menu };
};

// ──────────────────────────────────────────────
// @desc    Crear una nueva categoría/sección de menú
// @route   POST /api/menus
// @access  Private
// ──────────────────────────────────────────────
const newMenu = async (req, res) => {
  try {
    const { title, description, code, sectionID, section } = req.body;

    // Si tiene sectionID, verificamos que esa sección pertenezca al user
    if (sectionID) {
      const { error, status } = await verifyOwnership(sectionID, req.user._id);
      if (error) return res.status(status).json({ message: error });
    }

    // Verifica que el código sea único para este usuario
    const existingMenu = await Menu.findOne({ userID: req.user._id, code });
    if (existingMenu) return res.status(400).json({ message: "Código de menú ya existe" });

    const menu = await Menu.create({
      userID: req.user._id,
      title,
      description,
      code,
      sectionID: sectionID || null,
      section: section || false,
    });

    // Marca al user como que ya tiene menú creado
    await User.findByIdAndUpdate(req.user._id, { menu: true });

    res.status(201).json(menu);
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Editar datos de una sección o categoría
//          (título, descripción, code)
//          Para mover entre secciones usar moveMenu.
// @route   PUT /api/menus/:menuID
// @access  Private
// ──────────────────────────────────────────────
const editMenu = async (req, res) => {
  try {
    const { error, status, menu } = await verifyOwnership(req.params.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });
 
    const allowedFields = ["title", "description", "code"];
    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    // Si se está cambiando el código, verifica que el nuevo código no exista ya para este usuario
    if (updates.code && updates.code !== menu.code) {
      const existingMenuWithCode = await Menu.findOne({ userID: req.user._id, code: updates.code });
      if (existingMenuWithCode) {
        return res.status(400).json({ message: "Código de menú ya existe" });
      }
    }
 
    const updated = await Menu.findByIdAndUpdate(
      req.params.menuID,
      { $set: updates },
      { new: true, runValidators: true }
    );
 
    res.json(updated);
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Mover una categoría a otra sección (drag & drop entre secciones)
//          También sirve para quitarle la sección (sectionID: null)
// @route   PATCH /api/menus/:menuID/move
// @access  Private
// ──────────────────────────────────────────────
const moveMenu = async (req, res) => {
  try {
    const { sectionID: newSectionID } = req.body;
 
    const { error, status } = await verifyOwnership(req.params.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });
 
    // Si se manda un sectionID destino, verificamos que también pertenezca al user
    if (newSectionID) {
      const { error: errSec, status: stSec } = await verifyOwnership(newSectionID, req.user._id);
      if (errSec) return res.status(stSec).json({ message: errSec });
    }
 
    const updated = await Menu.findByIdAndUpdate(
      req.params.menuID,
      { sectionID: newSectionID || null },
      { new: true }
    );
 
    res.json(updated);
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Ocultar/mostrar una sección o categoría completa
//          No verifica si tiene contenido — solo la oculta visualmente.
// @route   PATCH /api/menus/:menuID/hidden
// @access  Private
// ──────────────────────────────────────────────
const hideMenu = async (req, res) => {
  try {
    const { hidden } = req.body;
    if (typeof hidden !== "boolean")
      return res.status(400).json({ message: "hidden debe ser un booleano" });
 
    const { error, status } = await verifyOwnership(req.params.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });
 
    const updated = await Menu.findByIdAndUpdate(
      req.params.menuID,
      { hidden },
      { new: true }
    );
 
    res.json({ hidden: updated.hidden });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Eliminar una sección o categoría SOLO si está vacía.
//          - Si es sección: no debe tener categorías hijas.
//          - Si es categoría: no debe tener items.
//          Para ocultar sin borrar, usar hideMenu.
// @route   DELETE /api/menus/:menuID
// @access  Private
// ──────────────────────────────────────────────
const deleteMenu = async (req, res) => {
  try {
    const { error, status, menu } = await verifyOwnership(req.params.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });
 
    if (menu.section) {
      // Es una sección: verifica que no tenga categorías hijas
      const categoriasHijas = await Menu.countDocuments({ sectionID: menu._id });
      if (categoriasHijas > 0) {
        return res.status(400).json({
          message: `No se puede eliminar: esta sección tiene ${categoriasHijas} categoría(s). Eliminá o movelas primero.`,
        });
      }
    } else {
      // Es una categoría: verifica que no tenga items
      const itemsHijos = await Item.countDocuments({ menuID: menu._id });
      if (itemsHijos > 0) {
        return res.status(400).json({
          message: `No se puede eliminar: esta categoría tiene ${itemsHijos} producto(s). Eliminá o movalos primero.`,
        });
      }
    }
 
    await Menu.findByIdAndDelete(req.params.menuID);
    res.json({ message: "Eliminado correctamente" });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Subir imagen para una sección o categoría
// @route   POST /api/menus/:menuID/upload-image
// @access  Private
// ──────────────────────────────────────────────
const uploadImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No se recibió ningún archivo" });
 
    const { error, status } = await verifyOwnership(req.params.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });
 
    const updated = await Menu.findByIdAndUpdate(
      req.params.menuID,
      { image: req.file.path }, // Cloudinary devuelve la URL en req.file.path
      { new: true }
    );
 
    res.json({ imageUrl: req.file.path, menu: updated });
  } catch (error) {
    handleError(res, error);
  }
};


module.exports = { newMenu, editMenu, moveMenu, hideMenu, deleteMenu, uploadImage };