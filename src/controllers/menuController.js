const { handleError } = require("../utils/handleError");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const User = require("../models/User");
const { generateAutoCode } = require("../utils/autoCode");
const {
  getNextOrder, menuContainerFilter, isObjectIdString, parseReorderIds, buildReorder,
} = require("../utils/menuOrder");

// ──────────────────────────────────────────────
// Helper: verifica ownership del menú
// ──────────────────────────────────────────────
const verifyOwnership = async (menuID, userID) => {
  // select cubre la unión de lo que leen todos los callers: userID (el
  // check de ownership acá abajo), code (editMenu), section (deleteMenu y
  // moveMenu) y sectionID (moveMenu).
  const menu = await Menu.findById(menuID).select("userID code section sectionID");
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

    // Mismo criterio que itemController.newItem: código en blanco + config
    // activa => código temporal y se reemplaza por el definitivo ya con el
    // ID real. Un código en blanco nunca compite en el chequeo de unicidad
    // (si compitiera, la segunda categoría/sección sin código chocaría
    // contra la primera).
    const cleanCode = typeof code === "string" ? code.trim() : "";
    const autoGenerate = cleanCode === "" && req.user.panelSettings?.autoGenerateCodes === true;

    if (!autoGenerate && cleanCode) {
      const existingMenu = await Menu.findOne({ userID: req.user._id, code: cleanCode });
      if (existingMenu) return res.status(400).json({ message: "Código de menú ya existe" });
    }

    // Se arma antes de guardar para calcular la posición con `section` y
    // `sectionID` ya casteados: va al final de su contenedor (las secciones,
    // o las categorías de su sección). Ver utils/menuOrder.js.
    const menu = new Menu({
      userID: req.user._id,
      title,
      description,
      code: autoGenerate ? String(Date.now()) : cleanCode,
      sectionID: sectionID || null,
      section: section || false,
    });
    menu.order = await getNextOrder(Menu, menuContainerFilter(req.user._id, menu));
    await menu.save();

    if (autoGenerate) {
      const siblingCodes = (await Menu.find({ userID: req.user._id, _id: { $ne: menu._id } }).select("code")).map((m) => m.code);
      menu.code = generateAutoCode(menu.title, menu._id.toString(), siblingCodes);
      await menu.save();
    }

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
 
    const { error, status, menu } = await verifyOwnership(req.params.menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });

    // Si se manda un sectionID destino, verificamos que también pertenezca al user
    if (newSectionID) {
      const { error: errSec, status: stSec } = await verifyOwnership(newSectionID, req.user._id);
      if (errSec) return res.status(stSec).json({ message: errSec });
    }

    // Una categoría que cambia de sección va al final de la nueva.
    const update = { sectionID: newSectionID || null };
    if (menu.section !== true && String(menu.sectionID ?? "") !== String(newSectionID || "")) {
      update.order = await getNextOrder(
        Menu,
        menuContainerFilter(req.user._id, { section: false, sectionID: newSectionID || null })
      );
    }

    const updated = await Menu.findByIdAndUpdate(
      req.params.menuID,
      update,
      { new: true }
    );

    res.json(updated);
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Ordenar secciones o categorías (arrastrar en el editor).
//          Dos formas, según lo que se mande:
//          - { sectionIds }: todas las secciones del local, en el nuevo orden.
//          - { sectionID, categoryIds }: las categorías de esa sección
//            (sectionID null = las que no tienen sección) en el nuevo orden.
//            Una categoría que hoy está en otra sección pasa a esta, en esa
//            posición: un solo pedido cubre ordenar y mover.
//          Lo que ya estaba en el contenedor y no viene en la lista (algo
//          creado desde otra pestaña) queda al final, en su orden. Es todo o
//          nada: si algún id no existe o no es del usuario, no se escribe nada.
// @route   PATCH /api/menus/reorder
// @access  Private
// ──────────────────────────────────────────────
const reorderMenus = async (req, res) => {
  try {
    const reorderingSections = req.body.sectionIds !== undefined;
    const requestedIds = parseReorderIds(reorderingSections ? req.body.sectionIds : req.body.categoryIds);
    const targetSectionID = req.body.sectionID ?? null;
    const validShape = reorderingSections
      ? req.body.categoryIds === undefined
      : targetSectionID === null || isObjectIdString(targetSectionID);
    if (!requestedIds || !validShape) {
      return res.status(400).json({ message: "El pedido para ordenar el menú no es válido." });
    }

    // Todo el menú del local en una consulta: son decenas de documentos, y
    // alcanza para validar y para saber qué hay en cada contenedor.
    const userMenus = await Menu.find({ userID: req.user._id }).select("_id section sectionID order").lean();
    const userMenusById = new Map(userMenus.map((menu) => [String(menu._id), menu]));
    const requestedMenus = requestedIds.map((id) => userMenusById.get(id));

    if (reorderingSections) {
      if (!requestedMenus.every((menu) => menu?.section === true)) {
        return res.status(409).json({ message: "Alguna sección ya no existe. Recargá el menú e intentá de nuevo." });
      }
      const { orderedIds, operations } = buildReorder({
        requestedIds,
        containerDocs: userMenus.filter((menu) => menu.section === true),
        docsById: userMenusById,
        containerPatch: {},
      });
      if (operations.length > 0) await Menu.bulkWrite(operations);
      return res.json({ sectionIds: orderedIds });
    }

    const targetSection = targetSectionID === null ? null : userMenusById.get(targetSectionID.toLowerCase());
    if (targetSectionID !== null && targetSection?.section !== true) {
      return res.status(404).json({ message: "Sección no encontrada." });
    }
    if (!requestedMenus.every((menu) => menu && menu.section !== true)) {
      return res.status(409).json({ message: "Alguna categoría ya no existe. Recargá el menú e intentá de nuevo." });
    }

    const targetKey = targetSection ? String(targetSection._id) : null;
    const { orderedIds, operations } = buildReorder({
      requestedIds,
      containerDocs: userMenus.filter((menu) => menu.section !== true
        && (menu.sectionID ? String(menu.sectionID) : null) === targetKey),
      docsById: userMenusById,
      containerPatch: { sectionID: targetSection ? targetSection._id : null },
    });
    if (operations.length > 0) await Menu.bulkWrite(operations);
    res.json({ sectionID: targetSection ? targetSection._id : null, categoryIds: orderedIds });
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
    if (req.user.panelSettings?.disableMenuDelete === true) {
      return res.status(403).json({ message: "Eliminar categorías y secciones está deshabilitado desde Configuración." });
    }

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


module.exports = { newMenu, editMenu, moveMenu, reorderMenus, hideMenu, deleteMenu, uploadImage };