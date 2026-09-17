const { handleError } = require("../utils/handleError");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const User = require("../models/User");
const { getRequestPlan } = require("../services/planCatalog");

// Tarjeta Trello "Plantillas de menúes": el mismo user marcado
// presetImagesUser (ver itemController.getPresetImagesOwner) actúa también
// como dueño del "menú plantilla" — su Menu/Item propios (cargados como
// cualquier usuario, a mano) son el catálogo que el resto puede copiar.
// Se reutiliza el flag existente en vez de sumar uno nuevo, tal como lo
// especifica la tarjeta.
const getPresetMenuOwner = () => User.findOne({ presetImagesUser: true }).select("_id");

const MAX_TEMPLATE_SELECTION = 300;

const toIdSet = (value) =>
  new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string" && id) : []);

const pickCategoryFields = (menu) => {
  const { title, description, image, code } = menu.toObject();
  return { title, description, image, code };
};

const pickItemFields = (item) => {
  const {
    title, description, price, offerPrice, offerRange, offerSchedule, options, image,
    isExtra, recommended, apt, availabilitySchedule, code,
  } = item.toObject();
  return { title, description, price, offerPrice, offerRange, offerSchedule, options, image, isExtra, recommended, apt, availabilitySchedule, code };
};

// Trae las categorías/secciones e items propios del usuario destino, para
// poder detectar qué códigos de la plantilla ya fueron importados antes.
const loadOwnCatalog = async (userID) => {
  const menus = await Menu.find({ userID });
  const items = await Item.find({ menuID: { $in: menus.map((m) => m._id) } });
  return {
    menuByCode: new Map(menus.filter((m) => m.code).map((m) => [m.code, m])),
    itemCodes: new Set(items.map((i) => i.code).filter(Boolean)),
  };
};

// ──────────────────────────────────────────────
// @desc    Catálogo de plantillas: menú del usuario presetImagesUser,
//          armado igual que fetchOwnMenu (secciones → categorías → items),
//          de solo lectura. Sin banco configurado, devuelve un menú vacío
//          (mismo contrato que getPresetImages con la imagen). Los productos
//          cuyo código ya existe en el menú del usuario que consulta (una
//          importación anterior, ver copyMenuTemplates) se excluyen para no
//          ofrecerlos de nuevo; una categoría/sección sin nada pendiente
//          por importar tampoco se lista.
// @route   GET /api/menu-templates
// @access  Private
// ──────────────────────────────────────────────
const getMenuTemplates = async (req, res) => {
  try {
    const owner = await getPresetMenuOwner();
    if (!owner) return res.json({ secciones: [], sinSeccion: [] });

    const menus = await Menu.find({ userID: owner._id, hidden: false });
    const menuIDs = menus.map((m) => m._id);
    const items = await Item.find({ menuID: { $in: menuIDs }, hidden: false });
    const { itemCodes: ownItemCodes } = await loadOwnCatalog(req.user._id);

    const secciones = menus.filter((m) => m.section === true);
    const categorias = menus.filter((m) => m.section === false);

    const buildCategoria = (cat) => {
      const pendingItems = items
        .filter((item) => item.menuID.equals(cat._id))
        .filter((item) => !item.code || !ownItemCodes.has(item.code));
      if (pendingItems.length === 0) return null;
      return {
        _id: cat._id,
        ...pickCategoryFields(cat),
        items: pendingItems.map((item) => ({ _id: item._id, ...pickItemFields(item) })),
      };
    };

    const seccionesConPendientes = secciones
      .map((sec) => ({
        _id: sec._id,
        ...pickCategoryFields(sec),
        categorias: categorias
          .filter((cat) => cat.sectionID && cat.sectionID.equals(sec._id))
          .map(buildCategoria)
          .filter(Boolean),
      }))
      .filter((sec) => sec.categorias.length > 0);

    const sinSeccion = categorias.filter((cat) => !cat.sectionID).map(buildCategoria).filter(Boolean);

    res.json({ secciones: seccionesConPendientes, sinSeccion });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Copia secciones/categorías enteras y/o productos sueltos del
//          menú plantilla al menú del usuario autenticado, como contenido
//          propio e independiente (no referenciado) — mismo efecto que si
//          el usuario los hubiera cargado a mano. Un producto suelto cuya
//          categoría no fue elegida entera se copia dentro de una copia de
//          esa misma categoría (un Item siempre necesita un menuID).
//
//          Las copias conservan el código original de la plantilla (en vez
//          de generar uno nuevo) para poder reconocer qué ya se importó: si
//          el usuario ya tiene una categoría/sección con ese código, se
//          reutiliza en vez de duplicarla, y un producto cuyo código ya
//          existe en el destino se omite en silencio (ya estaba importado).
// @route   POST /api/menu-templates/copy
// @access  Private
// ──────────────────────────────────────────────
const copyMenuTemplates = async (req, res) => {
  try {
    const sectionIds = toIdSet(req.body.sectionIds);
    const categoryIds = toIdSet(req.body.categoryIds);
    const itemIds = toIdSet(req.body.itemIds);

    if (sectionIds.size === 0 && categoryIds.size === 0 && itemIds.size === 0) {
      return res.status(400).json({ message: "Seleccioná al menos un producto, categoría o sección." });
    }
    if (sectionIds.size + categoryIds.size + itemIds.size > MAX_TEMPLATE_SELECTION) {
      return res.status(400).json({ message: `No se pueden seleccionar más de ${MAX_TEMPLATE_SELECTION} elementos a la vez.` });
    }

    const owner = await getPresetMenuOwner();
    if (!owner) return res.status(404).json({ message: "No hay un menú de plantillas configurado." });

    // Todo el menú plantilla en dos consultas — pensado para el tamaño de un
    // catálogo curado a mano, no para un menú de miles de productos.
    const ownerMenus = await Menu.find({ userID: owner._id, hidden: false });
    const ownerMenusById = new Map(ownerMenus.map((m) => [m._id.toString(), m]));
    const ownerItems = await Item.find({ menuID: { $in: ownerMenus.map((m) => m._id) }, hidden: false });

    const selectedSections = ownerMenus.filter((m) => m.section && sectionIds.has(m._id.toString()));

    // Categorías a copiar COMPLETAS: elegidas directamente o hijas de una sección elegida.
    const fullCategoryIds = new Set([
      ...ownerMenus.filter((m) => !m.section && categoryIds.has(m._id.toString())).map((m) => m._id.toString()),
      ...ownerMenus
        .filter((m) => !m.section && m.sectionID && selectedSections.some((sec) => sec._id.equals(m.sectionID)))
        .map((m) => m._id.toString()),
    ]);

    // Productos sueltos: pedidos explícitamente y cuya categoría no está ya cubierta arriba.
    const looseItems = ownerItems.filter(
      (item) => itemIds.has(item._id.toString()) && !fullCategoryIds.has(item.menuID.toString())
    );
    const looseMenuIds = new Set(looseItems.map((item) => item.menuID.toString()));

    const categoryIdsToCreate = new Set([...fullCategoryIds, ...looseMenuIds]);
    if (categoryIdsToCreate.size === 0) {
      return res.status(400).json({ message: "La selección no es válida o ya no está disponible." });
    }

    const itemsByCategory = new Map(
      [...categoryIdsToCreate].map((catId) => [
        catId,
        fullCategoryIds.has(catId)
          ? ownerItems.filter((item) => item.menuID.toString() === catId)
          : looseItems.filter((item) => item.menuID.toString() === catId),
      ])
    );

    // Descarta lo que el usuario ya importó antes (mismo código) — evita
    // recrearlo y evita que una categoría ya existente cuente como "nueva".
    const { menuByCode: ownMenuByCode, itemCodes: ownItemCodes } = await loadOwnCatalog(req.user._id);
    for (const [catId, catItems] of itemsByCategory) {
      itemsByCategory.set(catId, catItems.filter((item) => !item.code || !ownItemCodes.has(item.code)));
    }
    const totalNewItems = [...itemsByCategory.values()].reduce((sum, arr) => sum + arr.length, 0);
    const hasNewSection = selectedSections.some((sec) => !sec.code || !ownMenuByCode.has(sec.code));
    const hasNewCategory = [...categoryIdsToCreate].some((catId) => {
      const cat = ownerMenusById.get(catId);
      return !cat.code || !ownMenuByCode.has(cat.code);
    });
    if (totalNewItems === 0 && !hasNewSection && !hasNewCategory) {
      return res.status(400).json({ message: "Esa selección ya estaba importada en tu menú." });
    }

    const { features } = await getRequestPlan(req);
    if (features.item_limit !== null && totalNewItems > 0) {
      const userMenus = await Menu.find({ userID: req.user._id });
      const existingCount = await Item.countDocuments({ menuID: { $in: userMenus.map((m) => m._id) } });
      if (existingCount + totalNewItems > features.item_limit) {
        return res.status(403).json({
          message: `Esta selección agrega ${totalNewItems} productos y superarías el límite de ${features.item_limit} de tu plan. Elegí menos productos o mejorá tu plan.`,
        });
      }
    }

    // ── Escritura ──────────────────────────────
    // Reutiliza categoría/sección existente por código en vez de duplicarla;
    // si no existe, la crea con el código de la plantilla (nunca uno nuevo).
    const newSectionIdByOldId = new Map();
    let createdSections = 0;
    for (const sec of selectedSections) {
      const existing = sec.code ? ownMenuByCode.get(sec.code) : null;
      if (existing) {
        newSectionIdByOldId.set(sec._id.toString(), existing._id);
        continue;
      }
      const created = await Menu.create({ userID: req.user._id, ...pickCategoryFields(sec), section: true, sectionID: null });
      newSectionIdByOldId.set(sec._id.toString(), created._id);
      createdSections += 1;
      if (sec.code) ownMenuByCode.set(sec.code, created);
    }

    let createdCategories = 0;
    let createdItems = 0;
    for (const catId of categoryIdsToCreate) {
      const origCat = ownerMenusById.get(catId);
      const newSectionId = origCat.sectionID ? newSectionIdByOldId.get(origCat.sectionID.toString()) || null : null;

      const existingCat = origCat.code ? ownMenuByCode.get(origCat.code) : null;
      let destCatId;
      if (existingCat) {
        destCatId = existingCat._id;
      } else {
        const created = await Menu.create({ userID: req.user._id, ...pickCategoryFields(origCat), section: false, sectionID: newSectionId });
        destCatId = created._id;
        createdCategories += 1;
        if (origCat.code) ownMenuByCode.set(origCat.code, created);
      }

      for (const origItem of itemsByCategory.get(catId)) {
        const fields = pickItemFields(origItem);
        const allowScheduling = features.programacion_productos === true;
        await Item.create({
          menuID: destCatId,
          ...fields,
          offerPrice: allowScheduling ? fields.offerPrice : null,
          offerRange: allowScheduling ? fields.offerRange : { from: null, to: null },
          offerSchedule: allowScheduling ? fields.offerSchedule : undefined,
          availabilitySchedule: allowScheduling ? fields.availabilitySchedule : undefined,
          available: true,
          hidden: false,
        });
        createdItems += 1;
        if (origItem.code) ownItemCodes.add(origItem.code);
      }
    }

    if (createdCategories > 0 || createdItems > 0) await User.findByIdAndUpdate(req.user._id, { menu: true });

    res.status(201).json({ createdSections, createdCategories, createdItems });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = { getMenuTemplates, copyMenuTemplates, getPresetMenuOwner };
