const { handleError } = require("../utils/handleError");
const Item = require("../models/Item");
const Menu = require("../models/Menu");
const User = require("../models/User");
const { getRequestPlan } = require("../services/planCatalog");
const { validateAvailabilitySchedule } = require("../utils/itemAvailability");
const { normalizeOffer } = require("../utils/offers");
const { cloudinary } = require("../config/cloudinary");
const { isValidImageUrl } = require("../utils/imageUrl");

// ──────────────────────────────────────────────
// Helper: verifica que el menuID pertenezca al user autenticado.
// Se usa en todas las funciones para garantizar ownership.
// ──────────────────────────────────────────────
// `options` llega desde req.body como objeto plano (JSON no tiene Map), a
// diferencia de price/offerPrice no tenía ningún chequeo — se podía cargar
// una variante con precio negativo sin que nada lo rechazara.
const hasNegativeOptionPrice = (options) => {
  if (!options || typeof options !== "object") return false;
  return Object.values(options).some((price) => price != null && Number(price) < 0);
};

const verifyMenuOwnership = async (menuID, userID) => {
  const menu = await Menu.findById(menuID);
  if (!menu) return { error: "Menú no encontrado", status: 404 };
  if (menu.userID.toString() !== userID.toString())
    return { error: "No autorizado", status: 403 };
  return { menu };
};

// ──────────────────────────────────────────────
// Helpers para las acciones en lote (setAvailableBulk/setHiddenBulk/
// deleteItemsBulk): a diferencia de verifyMenuOwnership (una consulta por
// item), acá se resuelve la ownership de TODO el lote en dos consultas
// (Item.find + Menu.find), sin importar cuántos items se seleccionen.
// ──────────────────────────────────────────────
const MAX_BULK_ITEMS = 200;

const validateBulkItemIds = (req, res) => {
  const { itemIds } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    res.status(400).json({ message: "itemIds debe ser un array con al menos un id." });
    return null;
  }
  const uniqueIds = [...new Set(itemIds)];
  if (uniqueIds.length > MAX_BULK_ITEMS) {
    res.status(400).json({ message: `No se pueden procesar más de ${MAX_BULK_ITEMS} productos a la vez.` });
    return null;
  }
  return uniqueIds;
};

// Separa itemIds en los que existen y pertenecen al usuario autenticado
// (ownedIds) de los que no (failedIds: no existen o son de otro usuario).
// No distingue esos dos casos en la respuesta a propósito — mismo criterio
// que verifyMenuOwnership, que tampoco filtra qué tan "no autorizado" es
// cada caso, para no revelar la existencia de items ajenos.
const resolveOwnedItemIds = async (itemIds, userID) => {
  const items = await Item.find({ _id: { $in: itemIds } }).select("_id menuID");
  if (items.length === 0) return { ownedIds: [], failedIds: itemIds };

  const menuIDs = [...new Set(items.map((item) => item.menuID.toString()))];
  const ownedMenuIDs = new Set(
    (await Menu.find({ _id: { $in: menuIDs }, userID }).select("_id")).map((menu) => menu._id.toString())
  );

  const ownedIdSet = new Set();
  items.forEach((item) => {
    if (ownedMenuIDs.has(item.menuID.toString())) ownedIdSet.add(item._id.toString());
  });

  const failedIds = itemIds.filter((id) => !ownedIdSet.has(id));
  return { ownedIds: [...ownedIdSet], failedIds };
};

// ──────────────────────────────────────────────
// Helper: cuando se borra un item con imagen, esa imagen vuelve al Gestor
// de imágenes (User.pendingMenuImages) en vez de perderse — salvo que otro
// item del mismo usuario siga usando exactamente esa misma URL (imagen
// legacy compartida entre dos productos desde antes del Gestor); en ese
// caso no se toca pendingMenuImages, para no dejarla ahí Y asignada a la vez.
// ──────────────────────────────────────────────
const recycleDeletedItemImages = async (deletedItems, userID) => {
  const urls = [...new Set(deletedItems.map((item) => item.image).filter(Boolean))];
  if (urls.length === 0) return;

  const deletedIds = deletedItems.map((item) => item._id);
  const userMenuIDs = (await Menu.find({ userID }).select("_id")).map((m) => m._id);
  const stillUsedUrls = new Set(
    (
      await Item.find({
        image: { $in: urls },
        menuID: { $in: userMenuIDs },
        _id: { $nin: deletedIds },
      }).select("image")
    ).map((item) => item.image)
  );

  const toRecycle = urls.filter((url) => !stillUsedUrls.has(url));
  if (toRecycle.length > 0) {
    await User.findByIdAndUpdate(userID, { $addToSet: { pendingMenuImages: { $each: toRecycle } } });
  }
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
      offerPrice, offerRange, availabilitySchedule, options, isExtra, recommended, apt, hidden, available
    } = req.body;

        if (req.body.price != null && Number(req.body.price) < 0) {
          return res.status(400).json({ message: "El precio no puede ser negativo" });
        }
        if (req.body.offerPrice != null && Number(req.body.offerPrice) < 0) {
          return res.status(400).json({ message: "El precio de oferta no puede ser negativo" });
        }
        if (hasNegativeOptionPrice(req.body.options)) {
          return res.status(400).json({ message: "El precio de una variante no puede ser negativo" });
        }

    const { error, status } = await verifyMenuOwnership(menuID, req.user._id);
    if (error) return res.status(status).json({ message: error });

    // IDs de todas las categorías del usuario — se usan tanto para el tope
    // del plan gratuito como para el chequeo de código único de acá abajo.
    const userMenuIDs = (await Menu.find({ userID: req.user._id }).select("_id")).map((m) => m._id);

    // Tope total escalonado por plan (todas las categorías juntas).
    const { features } = await getRequestPlan(req);
    const itemLimit = features.item_limit;
    if (itemLimit !== null) {
      const itemCount = await Item.countDocuments({ menuID: { $in: userMenuIDs } });
      if (itemCount >= itemLimit) {
        return res.status(403).json({
          message: `Alcanzaste el límite de ${itemLimit} productos de tu plan. Mejorá tu plan para agregar más productos.`,
        });
      }
    }

    const normalizedOffer = normalizeOffer({ price, offerPrice, offerRange });
    if (normalizedOffer.error) return res.status(400).json({ message: normalizedOffer.error });
    if (normalizedOffer.isScheduled && !features.programacion_productos) {
      return res.status(403).json({ message: "La programación de ofertas no está incluida en tu plan." });
    }

    let normalizedAvailabilitySchedule;
    if (availabilitySchedule !== undefined) {
      const validation = validateAvailabilitySchedule(availabilitySchedule);
      if (validation.error) return res.status(400).json({ message: validation.error });
      if (validation.schedule.enabled && !features.programacion_productos) {
        return res.status(403).json({ message: "Programar la disponibilidad no está incluida en tu plan." });
      }
      normalizedAvailabilitySchedule = validation.schedule;
    }

    // Verifica que el código sea único entre los productos de ESTE usuario
    // (antes se chequeaba contra TODA la colección — dos locales distintos
    // no podían usar el mismo código de producto entre sí).
    const existingItem = await Item.findOne({ code, menuID: { $in: userMenuIDs } });
    if (existingItem) return res.status(400).json({ message: "Código de item ya existe en este menú" });
    const item = await Item.create({
        menuID, code, title, description, price, image,
        offerPrice: normalizedOffer.offerPrice, offerRange: normalizedOffer.offerRange,
        availabilitySchedule: normalizedAvailabilitySchedule,
        options, isExtra, recommended, apt, hidden, available
      });
        res.status(201).json(item) 
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Editar campos de contenido de un item
//          (título, descripción, precios, opciones, etc.)
//          No mueve el item entre categorías — para eso está moveItem.
//          No cambia imagen — para eso está uploadImage.
//          hidden/available también llegan desde el formulario completo;
//          setHidden/setAvailable quedan para los toggles rápidos.
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
  "availabilitySchedule",
  "options",
  "isExtra",
  "recommended",
  "hidden",
  "available",
  "apt",
];
 
    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    for (const field of ["available", "hidden", "recommended"]) {
      if (updates[field] !== undefined && typeof updates[field] !== "boolean") {
        return res.status(400).json({ message: `${field} debe ser un booleano` });
      }
    }

    if (updates.options !== undefined && hasNegativeOptionPrice(updates.options)) {
      return res.status(400).json({ message: "El precio de una variante no puede ser negativo" });
    }

    const { features } = await getRequestPlan(req);
    const changesOffer = updates.offerPrice !== undefined || updates.offerRange !== undefined;
    const changesPrice = updates.price !== undefined && (
          updates.price == null ? item.price != null : Number(updates.price) !== Number(item.price)
        );

        if (changesPrice || changesOffer) {
          // Rechazar precios negativos
          if (updates.price !== undefined && updates.price != null && Number(updates.price) < 0) {
            return res.status(400).json({ message: "El precio no puede ser negativo" });
          }
          if (updates.offerPrice !== undefined && updates.offerPrice != null && Number(updates.offerPrice) < 0) {
            return res.status(400).json({ message: "El precio de oferta no puede ser negativo" });
          }

          const normalizedOffer = normalizeOffer({
            price: updates.price !== undefined ? updates.price : item.price,
            offerPrice: updates.offerPrice !== undefined ? updates.offerPrice : item.offerPrice,
            offerRange: updates.offerRange !== undefined ? updates.offerRange : item.offerRange,
          });

          if (normalizedOffer.error) {
            return res.status(400).json({ message: normalizedOffer.error });
          }

          if (changesOffer && normalizedOffer.isScheduled && !features.programacion_productos) {
            return res.status(403).json({ message: "La programación de ofertas no está incluida en tu plan." });
          }

          if (changesOffer) {
            updates.offerPrice = normalizedOffer.offerPrice;
            updates.offerRange = normalizedOffer.offerRange;
          }
        }

    if (updates.availabilitySchedule !== undefined) {
      const validation = validateAvailabilitySchedule(updates.availabilitySchedule);
      if (validation.error) return res.status(400).json({ message: validation.error });
      if (validation.schedule.enabled && !features.programacion_productos) {
        return res.status(403).json({ message: "Programar la disponibilidad no está incluida en tu plan." });
      }
      updates.availabilitySchedule = validation.schedule;
    }

    // Solo chequear unicidad si el código realmente cambia, y solo contra
    // los items de ESTE usuario (antes: Item.findOne({ code: undefined })
    // cuando no se mandaba code encontraba cualquier item al azar de TODA
    // la colección, de cualquier usuario, y podía rechazar la edición por error).
    if (updates.code !== undefined) {
      const userMenuIDs = (await Menu.find({ userID: req.user._id }).select("_id")).map((m) => m._id);
      const existingItemWithCode = await Item.findOne({ code: updates.code, menuID: { $in: userMenuIDs } });
      if (existingItemWithCode && existingItemWithCode._id.toString() !== item._id.toString()) {
        return res.status(400).json({ message: "Código de item ya existe" });
      }
    }

    const updated = await Item.findByIdAndUpdate(
      req.params.itemID,
      { $set: updates },
      { new: true, runValidators: true }
    );
 
    res.json(updated);
  } catch (err) {
    handleError(res, err);
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
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Subir imagen de un item
// @route   POST /api/items/:itemID/upload-image
// @access  Private
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// @desc    Subir una imagen todavía no asociada a un item (el editor pide la
//          imagen antes de crear el producto, cuando no hay itemID). Existe
//          para que ese caso no tenga que ir directo a Cloudinary desde el
//          navegador con un preset sin firmar, que era una puerta de subida
//          abierta a internet sin autenticación.
// @route   POST /api/items/upload-image
// @access  Private (requiere plan con menu_editor)
// ──────────────────────────────────────────────
const uploadDraftImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No se recibió ningún archivo" });
    // multer + storage de Cloudinary ya subieron el archivo: req.file.path es
    // la URL final, la misma que valida el schema de Item.
    res.json({ imageUrl: req.file.path });
  } catch (err) {
    handleError(res, err);
  }
};

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
    handleError(res, err);
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
    handleError(res, err);
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
    handleError(res, err);
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
    await recycleDeletedItemImages([item], req.user._id);
    res.json({ message: "Item eliminado" });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Marcar varios items como disponibles/no disponibles a la vez
//          (selección múltiple del editor). Los ids que no existan o no
//          pertenezcan al usuario se ignoran y se listan en failedIds, en
//          vez de hacer fallar todo el lote.
// @route   PATCH /api/items/bulk/available
// @access  Private
// ──────────────────────────────────────────────
const setAvailableBulk = async (req, res) => {
  try {
    const { available } = req.body;
    if (typeof available !== "boolean") return res.status(400).json({ message: "available debe ser un booleano" });

    const itemIds = validateBulkItemIds(req, res);
    if (!itemIds) return;

    const { ownedIds, failedIds } = await resolveOwnedItemIds(itemIds, req.user._id);
    if (ownedIds.length > 0) {
      await Item.updateMany({ _id: { $in: ownedIds } }, { $set: { available } });
    }
    res.json({ available, updatedCount: ownedIds.length, failedIds });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Ocultar/mostrar varios items del menú público a la vez
// @route   PATCH /api/items/bulk/hidden
// @access  Private
// ──────────────────────────────────────────────
const setHiddenBulk = async (req, res) => {
  try {
    const { hidden } = req.body;
    if (typeof hidden !== "boolean") return res.status(400).json({ message: "hidden debe ser un booleano" });

    const itemIds = validateBulkItemIds(req, res);
    if (!itemIds) return;

    const { ownedIds, failedIds } = await resolveOwnedItemIds(itemIds, req.user._id);
    if (ownedIds.length > 0) {
      await Item.updateMany({ _id: { $in: ownedIds } }, { $set: { hidden } });
    }
    res.json({ hidden, updatedCount: ownedIds.length, failedIds });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Eliminar varios items del menú a la vez. POST en vez de DELETE
//          porque el lote de ids viaja en el body, y no todos los proxies/
//          middlewares intermedios preservan el body de un DELETE.
// @route   POST /api/items/bulk/delete
// @access  Private
// ──────────────────────────────────────────────
const deleteItemsBulk = async (req, res) => {
  try {
    const itemIds = validateBulkItemIds(req, res);
    if (!itemIds) return;

    const { ownedIds, failedIds } = await resolveOwnedItemIds(itemIds, req.user._id);
    if (ownedIds.length > 0) {
      const itemsToDelete = await Item.find({ _id: { $in: ownedIds } }).select("_id image");
      await Item.deleteMany({ _id: { $in: ownedIds } });
      await recycleDeletedItemImages(itemsToDelete, req.user._id);
    }
    res.json({ deletedCount: ownedIds.length, failedIds });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Gestor de imágenes: productos del usuario con solo los campos
//          que necesita el buscador (nombre/código) y para saber si ya
//          tienen imagen — no la ficha completa del item.
// @route   GET /api/items/lite
// @access  Private
// ──────────────────────────────────────────────
const getLiteItems = async (req, res) => {
  try {
    const userMenuIDs = (await Menu.find({ userID: req.user._id }).select("_id")).map((m) => m._id);
    const items = await Item.find({ menuID: { $in: userMenuIDs } }).select("_id title code image");
    res.json(items);
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Gestor de imágenes: imágenes ya subidas a Cloudinary que todavía
//          no fueron asignadas a ningún producto.
// @route   GET /api/items/images/pending
// @access  Private
// ──────────────────────────────────────────────
const getPendingImages = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("pendingMenuImages");
    res.json({ pendingImages: user?.pendingMenuImages || [] });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// Helper: tope de imágenes vigente para el usuario, y cuántas ya tiene
// asignadas a productos (la cantidad de pendientes se lee aparte, cambia
// con cada subida).
//   - Planes con item_limit (Free/Basic): el tope es ese número fijo.
//   - Planes sin item_limit (Pro): no hay un número fijo, así que el tope
//     pasa a ser la cantidad de productos que el usuario YA creó — no
//     tiene sentido acumular más imágenes que productos que algún día las
//     puedan usar. Con 0 productos creados, el tope efectivo es 0.
// ──────────────────────────────────────────────
const getImageQuotaLimit = async (req) => {
  const { features } = await getRequestPlan(req);
  const userMenuIDs = (await Menu.find({ userID: req.user._id }).select("_id")).map((m) => m._id);
  const [assignedCount, totalItemCount] = await Promise.all([
    Item.countDocuments({ menuID: { $in: userMenuIDs }, image: { $ne: "" } }),
    features.item_limit === null ? Item.countDocuments({ menuID: { $in: userMenuIDs } }) : Promise.resolve(null),
  ]);
  const effectiveLimit = features.item_limit === null ? totalItemCount : features.item_limit;
  return { effectiveLimit, assignedCount, isDynamic: features.item_limit === null };
};

const imageQuotaMessage = (effectiveLimit, isDynamic) => (isDynamic
  ? `No podés tener más imágenes cargadas que productos creados (tenés ${effectiveLimit}). Creá otro producto o asigná las imágenes pendientes antes de subir una nueva.`
  : `Alcanzaste el límite de ${effectiveLimit} imágenes de tu plan (contando las pendientes y las ya asignadas a productos). Asigná las que ya subiste o mejorá tu plan para subir más.`);

// ──────────────────────────────────────────────
// Middleware: corta ANTES de subir a Cloudinary si el usuario ya alcanzó el
// tope de imágenes. Va antes del multer de subida a propósito: así no se
// gasta una subida real a Cloudinary para una imagen que de todos modos se
// rechaza. No es la única barrera — ver el update atómico en
// uploadLibraryImage, que cierra la carrera entre dos subidas concurrentes
// que pasan este chequeo casi al mismo tiempo.
// ──────────────────────────────────────────────
const checkImageQuota = async (req, res, next) => {
  try {
    const { effectiveLimit, assignedCount, isDynamic } = await getImageQuotaLimit(req);
    const user = await User.findById(req.user._id).select("pendingMenuImages");
    const totalImages = (user?.pendingMenuImages?.length || 0) + assignedCount;

    if (totalImages >= effectiveLimit) {
      return res.status(403).json({ message: imageQuotaMessage(effectiveLimit, isDynamic) });
    }
    next();
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Gestor de imágenes: sube una imagen a Cloudinary sin asociarla
//          todavía a ningún producto — queda en pendingMenuImages hasta
//          que se asigne desde /images/assign. El public_id lo arma
//          uploadItemLibrary (config/cloudinary.js) con el id del user.
// @route   POST /api/items/images/upload
// @access  Private
// ──────────────────────────────────────────────
const uploadLibraryImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No se recibió ningún archivo" });
    const imageUrl = req.file.path;

    // Recalcula el cupo acá (no solo confía en checkImageQuota) y agrega
    // con un update condicional: el frontend sube varias imágenes en
    // paralelo, así que dos requests pueden pasar checkImageQuota casi
    // simultáneamente, antes de que cualquiera de las dos haya escrito
    // todavía. $expr compara contra el tamaño del array en el mismo
    // instante del write, así que solo una de las dos gana si el cupo
    // alcanza para una sola.
    const { effectiveLimit, assignedCount } = await getImageQuotaLimit(req);
    const remainingSlots = Math.max(0, effectiveLimit - assignedCount);

    const updated = await User.findOneAndUpdate(
      { _id: req.user._id, $expr: { $lt: [{ $size: "$pendingMenuImages" }, remainingSlots] } },
      { $push: { pendingMenuImages: imageUrl } },
      { new: true }
    );

    if (!updated) {
      // La imagen ya está en Cloudinary (subida antes de este chequeo) y
      // queda huérfana — mismo tradeoff aceptado que ya existe en el resto
      // del repo para reemplazos/borrados de imagen (ver removeImage en
      // userController.js). Es el caso raro de la carrera, no el camino
      // normal (ese lo corta checkImageQuota antes de llegar a Cloudinary).
      return res.status(403).json({
        message: "Alcanzaste el límite de imágenes de tu plan mientras se subían otras imágenes en simultáneo. Esperá a que terminen y volvé a intentar.",
      });
    }

    res.json({ imageUrl });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Gestor de imágenes: guarda de una vez las asignaciones imagen→
//          producto(s) hechas en el gestor. El estado "actual" de cada
//          imagen (quién la tiene hoy) se recalcula acá, no se confía en lo
//          que mande el cliente, para no pisar datos por una condición de
//          carrera entre dos pestañas/sesiones del mismo usuario.
// @route   POST /api/items/images/assign
// @access  Private
// @body    { changes: [{ imageUrl: string, itemIDs: string[] }, ...] }
//          Solo hace falta mandar las imágenes que cambiaron, no todo el
//          estado del gestor.
// ──────────────────────────────────────────────
const assignImages = async (req, res) => {
  try {
    const { changes } = req.body;
    if (!Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ message: "changes debe ser un array con al menos un elemento." });
    }
    if (changes.length > MAX_BULK_ITEMS) {
      return res.status(400).json({ message: `No se pueden procesar más de ${MAX_BULK_ITEMS} imágenes a la vez.` });
    }

    // Validación de forma + sin repetidos entre entradas. El frontend ya
    // evita elegir el mismo producto en dos imágenes a la vez (mapa único
    // itemID→imageUrl), esto es la segunda barrera por si un bug de cliente
    // o dos pestañas mandan un payload inconsistente.
    const seenUrls = new Set();
    const seenItemIds = new Set();
    let totalItemIds = 0;
    for (const change of changes) {
      if (!change || typeof change.imageUrl !== "string" || !Array.isArray(change.itemIDs)) {
        return res.status(400).json({ message: "Cada cambio necesita imageUrl (string) e itemIDs (array)." });
      }
      if (seenUrls.has(change.imageUrl)) {
        return res.status(400).json({ message: "No se puede repetir la misma imagen en dos cambios." });
      }
      seenUrls.add(change.imageUrl);
      for (const itemID of change.itemIDs) {
        if (seenItemIds.has(itemID)) {
          return res.status(400).json({
            message: "No se puede asignar el mismo producto a dos imágenes distintas en un solo guardado.",
          });
        }
        seenItemIds.add(itemID);
      }
      totalItemIds += change.itemIDs.length;
    }
    if (totalItemIds > MAX_BULK_ITEMS) {
      return res.status(400).json({ message: `No se pueden procesar más de ${MAX_BULK_ITEMS} productos a la vez.` });
    }

    const userMenuIDs = (await Menu.find({ userID: req.user._id }).select("_id")).map((m) => m._id.toString());
    const userMenuIDSet = new Set(userMenuIDs);

    const user = await User.findById(req.user._id).select("pendingMenuImages");
    const pendingSet = new Set(user?.pendingMenuImages || []);

    // Ownership de todos los productos mencionados, en una sola consulta.
    const allItemIds = [...seenItemIds];
    const itemsByID = new Map(
      (await Item.find({ _id: { $in: allItemIds } }).select("_id menuID")).map((it) => [it._id.toString(), it])
    );
    for (const itemID of allItemIds) {
      const item = itemsByID.get(itemID);
      if (!item || !userMenuIDSet.has(item.menuID.toString())) {
        return res.status(403).json({ message: "No autorizado sobre uno de los productos enviados." });
      }
    }

    // Quién tiene hoy cada imagen (para el diff toAdd/toRemove), también en
    // una sola consulta para todas las entradas.
    const allUrls = [...seenUrls];
    const currentHoldersByUrl = new Map(allUrls.map((url) => [url, []]));
    (await Item.find({ image: { $in: allUrls }, menuID: { $in: userMenuIDs } }).select("_id image")).forEach(
      (it) => {
        currentHoldersByUrl.get(it.image).push(it._id.toString());
      }
    );

    const bulkOps = [];
    const urlsToPull = [];
    const urlsToAdd = [];
    let updatedItemCount = 0;

    for (const { imageUrl, itemIDs } of changes) {
      const uniqueItemIDs = [...new Set(itemIDs)];

      // La imagen tiene que ser del usuario: o está en sus pendientes, o ya
      // es la imagen de algún producto suyo. Si no, alguien está tratando
      // de asignarse una imagen ajena (pendiente de otro usuario, nunca
      // asignada a nada) como si fuera propia.
      const currentHolders = currentHoldersByUrl.get(imageUrl) || [];
      if (!pendingSet.has(imageUrl) && currentHolders.length === 0) {
        return res.status(403).json({ message: "No autorizado sobre una de las imágenes enviadas." });
      }

      const currentSet = new Set(currentHolders);
      const nextSet = new Set(uniqueItemIDs);
      const toAdd = uniqueItemIDs.filter((id) => !currentSet.has(id));
      const toRemove = currentHolders.filter((id) => !nextSet.has(id));

      if (toAdd.length > 0) {
        bulkOps.push({ updateMany: { filter: { _id: { $in: toAdd } }, update: { $set: { image: imageUrl } } } });
      }
      if (toRemove.length > 0) {
        bulkOps.push({ updateMany: { filter: { _id: { $in: toRemove } }, update: { $set: { image: "" } } } });
      }
      updatedItemCount += toAdd.length + toRemove.length;

      if (uniqueItemIDs.length > 0) {
        urlsToPull.push(imageUrl);
      } else {
        urlsToAdd.push(imageUrl);
      }
    }

    if (bulkOps.length > 0) {
      await Item.bulkWrite(bulkOps);
    }
    // $pull y $addToSet no se pueden combinar sobre el mismo campo en un
    // solo update de Mongo — van en dos llamadas separadas.
    if (urlsToPull.length > 0) {
      await User.findByIdAndUpdate(req.user._id, { $pull: { pendingMenuImages: { $in: urlsToPull } } });
    }
    if (urlsToAdd.length > 0) {
      await User.findByIdAndUpdate(req.user._id, { $addToSet: { pendingMenuImages: { $each: urlsToAdd } } });
    }

    const updatedUser = await User.findById(req.user._id).select("pendingMenuImages");
    res.json({ updatedCount: updatedItemCount, pendingImages: updatedUser?.pendingMenuImages || [] });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// Helper: extrae el public_id de Cloudinary a partir de la URL guardada en
// Mongo. Las imágenes del Gestor siempre se suben con uploadItemLibrary
// (config/cloudinary.js), que arma la secure_url como
// .../upload/v<version>/menu-digital/items/<public_id>.<ext> — sin
// transformaciones en la URL de entrega, así que alcanza con capturar todo
// lo que va después de "/upload/v<version>/" y antes de la extensión final.
// Devuelve null si la URL no tiene esa forma (no debería pasar si ya se
// validó con isValidImageUrl, pero mejor no reventar el borrado en Mongo
// por eso).
// ──────────────────────────────────────────────
const extractCloudinaryPublicId = (imageUrl) => {
  const match = imageUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
  return match ? match[1] : null;
};

// ──────────────────────────────────────────────
// Helper: borra el archivo real en Cloudinary. Se llama DESPUÉS de limpiar
// Mongo (ver deleteLibraryImage) y nunca propaga el error: si Cloudinary
// falla o el public_id no se pudo extraer, la imagen ya quedó sin
// referencias en la app (que es lo que le importa al usuario) y el archivo
// huérfano en Cloudinary es el mismo tradeoff aceptado en el resto del
// repo para casos raros de reemplazo/borrado (ver removeImage en
// userController.js).
// ──────────────────────────────────────────────
const destroyCloudinaryImage = async (imageUrl) => {
  const publicId = extractCloudinaryPublicId(imageUrl);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  } catch (err) {
    console.error("No se pudo borrar de Cloudinary el public_id", publicId, err.message);
  }
};

// ──────────────────────────────────────────────
// @desc    Gestor de imágenes: elimina una imagen definitivamente — la saca
//          de Cloudinary, de cualquier producto que la tenga asignada (esos
//          productos quedan sin imagen) y del array de pendientes. A
//          diferencia de removeImage (galería del local, userController.js)
//          esta sí borra el archivo real en Cloudinary: la única referencia
//          posible a esa URL fuera de acá es el/los producto(s) que se
//          limpian en el mismo request, así que no hay riesgo de dejar un
//          <img> roto colgando en otro lado de la app.
// @route   DELETE /api/items/images
// @access  Private
// @body    { imageUrl: string }
// ──────────────────────────────────────────────
const deleteLibraryImage = async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl || typeof imageUrl !== "string" || !isValidImageUrl(imageUrl)) {
      return res.status(400).json({ message: "Falta una imageUrl válida." });
    }

    const userMenuIDs = (await Menu.find({ userID: req.user._id }).select("_id")).map((m) => m._id);
    const user = await User.findById(req.user._id).select("pendingMenuImages");
    const isPending = (user?.pendingMenuImages || []).includes(imageUrl);
    const holders = await Item.find({ image: imageUrl, menuID: { $in: userMenuIDs } }).select("_id");

    // Misma barrera de ownership que assignImages: la imagen tiene que ser
    // pendiente propia o estar asignada a un producto propio. Si no, alguien
    // está tratando de borrar un archivo que no le pertenece.
    if (!isPending && holders.length === 0) {
      return res.status(403).json({ message: "No autorizado sobre esta imagen." });
    }

    if (holders.length > 0) {
      await Item.updateMany({ _id: { $in: holders.map((h) => h._id) } }, { $set: { image: "" } });
    }
    if (isPending) {
      await User.findByIdAndUpdate(req.user._id, { $pull: { pendingMenuImages: imageUrl } });
    }

    await destroyCloudinaryImage(imageUrl);

    res.json({ removedFromItems: holders.length });
  } catch (err) {
    handleError(res, err);
  }
};

module.exports = {
  newItem,
  editItem,
  moveItem,
  uploadImage,
  uploadDraftImage,
  setHidden,
  setAvailable,
  deleteItem,
  setAvailableBulk,
  setHiddenBulk,
  deleteItemsBulk,
  getLiteItems,
  getPendingImages,
  checkImageQuota,
  uploadLibraryImage,
  assignImages,
  deleteLibraryImage,
  MAX_BULK_ITEMS
};
