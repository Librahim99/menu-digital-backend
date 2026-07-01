const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Menu = require("../models/Menu");
const Item = require("../models/Item");

// ──────────────────────────────────────────────
// Helper: genera un JWT firmado con el ID del user
// ──────────────────────────────────────────────
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

// ──────────────────────────────────────────────
// Helper: normaliza un string a slug URL-friendly
// "Café Roma" -> "cafe-roma"
// "Don José"  -> "don-jose"
// ──────────────────────────────────────────────
const generateSlug = (name) =>
  name
    .normalize("NFD")                 // Descompone acentos: á -> a + ́
    .replace(/[\u0300-\u036f]/g, "") // Elimina diacríticos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")    // Saca todo lo que no sea letra/número/espacio/guión
    .replace(/\s+/g, "-")            // Espacios -> guiones
    .replace(/-+/g, "-")             // Colapsa guiones repetidos
    .replace(/^-+|-+$/g, "");        // Saca guiones al principio/final

// ──────────────────────────────────────────────
// @desc    Registrar nuevo usuario (local)
// @route   POST /api/users/register
// @access  Public
// ──────────────────────────────────────────────
const newUser = async (req, res) => {
  try {
    const { username, password, contactInfo, acceptedTerms } = req.body;

    // Verifica que el username no esté tomado
    const exists = await User.findOne({ username });
    if (exists) {
  return res.status(400).json({
    message: "El username ya está en uso",
  });
}

if (acceptedTerms !== true) {
  return res.status(400).json({
    message: "Debes aceptar los términos y condiciones",
  });
}

    // Crea el user; el hook pre-save hashea la password automáticamente
    const user = await User.create({
      username,
      password,
      contactInfo,
      acceptedTerms: true,
      acceptedTermsAt: new Date(),
      acceptedTermsVersion: process.env.ACCEPTED_TERMS_VERSION,
      // Si ya viene businessName en el registro, generamos el slug desde el inicio.
      // Si el nombre no deja ningún carácter válido (ej. solo símbolos/emojis),
      // dejamos slug sin definir en vez de guardar un string vacío.
      slug: (contactInfo?.businessName && generateSlug(contactInfo.businessName)) || undefined,
    });

    res.status(201).json({
      _id: user._id,
      username: user.username,
      token: generateToken(user._id),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Login de usuario
// @route   POST /api/users/login
// @access  Public
// ──────────────────────────────────────────────
const loginUser = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Incluimos password explícitamente porque tiene select:false en el modelo
    const user = await User.findOne({ username }).select("+password");

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    if (!user.active) {
      return res.status(403).json({ message: "Cuenta desactivada" });
    }

    res.json({
      _id: user._id,
      username: user.username,
      admin: user.admin,
      subscription: user.subscription,
      token: generateToken(user._id),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Obtener datos del usuario autenticado (para el panel de administración)
// @route   GET /api/users/me
// @access  Private
// ──────────────────────────────────────────────
const getAuthUser = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    // Contar items y categorías del usuario
    const menus = await Menu.find({ userID: user._id });
    const categorias = menus.filter(m => m.section === false);
    const menuIDs = categorias.map(m => m._id);
    const itemCount = await Item.countDocuments({ menuID: { $in: menuIDs }, hidden: false });

    res.json({
      ...user.toObject(),
      itemCount,
      categoryCount: categorias.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Obtener datos públicos de un local por slug + menú completo armado.
//          Se ejecuta UNA sola vez cuando el cliente entra a /negocio/menu.
//          Devuelve el user y el menú estructurado para que el front no necesite
//          más llamadas: secciones → categorías → items anidados.
// @route   GET /api/users/:slug/menu
// @access  Public
// ──────────────────────────────────────────────
const fetchUserWithMenu = async (req, res) => {
  try {
    const { slug } = req.params
    const slugNormalizado = generateSlug(slug);
 
    const user = await User.findOne({ slug: slugNormalizado, active: true });
    if (!user) return res.status(404).json({ message: "Local no encontrado" });
 
    // Traemos todos los menus del user
    const menus = await Menu.find({ userID: user._id, hidden: false });
    const menuIDs = menus.map((m) => m._id);
 
    // Traemos todos los items de esos menus
    const allItems = await Item.find({ menuID: { $in: menuIDs }, hidden: false });
 
    // Separamos secciones y categorías
    const secciones  = menus.filter((m) => m.section === true);
    const categorias = menus.filter((m) => m.section === false);


    const userFiltered = {
      _id: user._id,
      contactInfo: user.contactInfo,
      media: user.media,
      hasDelivery: user.hasDelivery,
      template: user.template
    }
 
    const menuArmado = {
      secciones: secciones.map((sec) => ({
        ...sec.toObject(),
        categorias: categorias
          .filter((cat) => cat.sectionID && cat.sectionID.equals(sec._id))
          .map((cat) => ({
            ...cat.toObject(),
            items: allItems.filter((item) => item.menuID.equals(cat._id)),
          })),
      })),
      sinSeccion: categorias
        .filter((cat) => !cat.sectionID)
        .map((cat) => ({
          ...cat.toObject(),
          items: allItems.filter((item) => item.menuID.equals(cat._id)),
        })),
    };
 
    res.json({ user: userFiltered, menu: menuArmado });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Obtener el menú completo del usuario autenticado, para el panel
//          de administración. A diferencia de fetchUserWithMenu (carta
//          pública), NO filtra secciones/categorías/items ocultos: el dueño
//          necesita verlos para poder reactivarlos.
// @route   GET /api/users/me/menu
// @access  Private
// ──────────────────────────────────────────────
const fetchOwnMenu = async (req, res) => {
  try {
    const menus = await Menu.find({ userID: req.user._id });
    const menuIDs = menus.map((m) => m._id);

    const allItems = await Item.find({ menuID: { $in: menuIDs } });

    const secciones  = menus.filter((m) => m.section === true);
    const categorias = menus.filter((m) => m.section === false);

    const menuArmado = {
      secciones: secciones.map((sec) => ({
        ...sec.toObject(),
        categorias: categorias
          .filter((cat) => cat.sectionID && cat.sectionID.equals(sec._id))
          .map((cat) => ({
            ...cat.toObject(),
            items: allItems.filter((item) => item.menuID.equals(cat._id)),
          })),
      })),
      sinSeccion: categorias
        .filter((cat) => !cat.sectionID)
        .map((cat) => ({
          ...cat.toObject(),
          items: allItems.filter((item) => item.menuID.equals(cat._id)),
        })),
    };

    res.json({ menu: menuArmado });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Obtener datos públicos de un local por slug.
//          Se ejecuta UNA sola vez cuando el cliente entra a /negocio.
// @route   GET /api/users/:slug
// @access  Public
// ──────────────────────────────────────────────

const fetchUser = async (req, res) => {
  try {
    const { slug } = req.params
    const slugNormalizado = generateSlug(slug);
 
    const user = await User.findOne({ slug: slugNormalizado, active: true });
    if (!user) return res.status(404).json({ message: "Local no encontrado" });

    const userFiltered = {
      _id: user._id,
      contactInfo: user.contactInfo,
      media: user.media,
      hasDelivery: user.hasDelivery,
      template: user.template
    }
 
    res.json( userFiltered );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Editar datos del usuario autenticado
// @route   PUT /api/users/me
// @access  Private
// ──────────────────────────────────────────────
const editUser = async (req, res) => {
  try {
    const allowedFields = ["contactInfo", "hasDelivery", "media", "template"];

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    // Si actualizaron el businessName, regeneramos el slug automáticamente.
    // Si el nuevo nombre no deja ningún carácter válido, no tocamos el slug
    // existente (mejor conservar el link viejo que dejarlo vacío).
    if (updates.contactInfo?.businessName) {
      const newSlug = generateSlug(updates.contactInfo.businessName);
      if (newSlug) updates.slug = newSlug;
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// ──────────────────────────────────────────────
// @desc    Subir imagen de perfil/media del local
// @route   POST /api/users/upload-image
// @access  Private
// ──────────────────────────────────────────────
const uploadImage = async (req, res) => {
  try {
    // req.file es seteado por multer (configurado en la ruta)
    if (!req.file) {
      return res.status(400).json({ message: "No se recibió ningún archivo" });
    }

    // Cloudinary devuelve la URL pública en req.file.path
    const imageUrl = req.file.path;

    // Agrega la URL al array de pictures del user
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $push: { "media.pictures": imageUrl } },
      { new: true }
    );

    res.json({ imageUrl, media: user.media });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Subir imagen de portada (background) del local
// @route   POST /api/users/upload-background
// @access  Private
// ──────────────────────────────────────────────
const uploadBackground = async (req, res) => {
  try {
    // req.file es seteado por multer (configurado en la ruta)
    if (!req.file) {
      return res.status(400).json({ message: "No se recibió ningún archivo" });
    }

    // Cloudinary devuelve la URL pública en req.file.path
    const imageUrl = req.file.path;

    // Reemplaza la foto de portada del user (no se agrega a un array, es única)
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { "media.backgroundPicture": imageUrl },
      { new: true }
    );

    res.json({ imageUrl, media: user.media });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Eliminar una foto puntual de la galería (media.pictures) por índice.
//          Solo quita la referencia en MongoDB, no borra el archivo en Cloudinary.
// @route   DELETE /api/users/remove-image
// @access  Private
// @body    { index: number }
// ──────────────────────────────────────────────
const removeImage = async (req, res) => {
  try {
    const { index } = req.body;

    if (typeof index !== "number") {
      return res.status(400).json({ message: "Falta el índice de la imagen a eliminar" });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    if (index < 0 || index >= user.media.pictures.length) {
      return res.status(400).json({ message: "Índice fuera de rango" });
    }

    user.media.pictures.splice(index, 1);
    await user.save();

    res.json({ media: user.media });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Eliminar la foto de portada (media.backgroundPicture).
//          Solo quita la referencia en MongoDB, no borra el archivo en Cloudinary.
// @route   DELETE /api/users/background
// @access  Private
// ──────────────────────────────────────────────
const deleteBackground = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { "media.backgroundPicture": "" },
      { new: true }
    );

    res.json({ media: user.media });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Templates que requieren un plan pago. Debe reflejar el campo `premium`
// de TEMPLATES en UserEditor.tsx (frontend) — ese lado maneja la UI de
// bloqueo/upsell, este es el que realmente impide guardarlo si alguien
// se salta el front (ej. pegando el PATCH directo).
const PREMIUM_TEMPLATE_IDS = [6, 7];

// ──────────────────────────────────────────────
// @desc    Cambiar el template visual del local
// @route   PATCH /api/users/template
// @access  Private
// ──────────────────────────────────────────────
const useTemplate = async (req, res) => {
  try {
    const { template } = req.body;

    if (typeof template !== "number") {
      return res.status(400).json({ message: "Template debe ser un número" });
    }

    if (PREMIUM_TEMPLATE_IDS.includes(template) && req.user.subscription === "none") {
      return res.status(403).json({ message: "Ese template requiere un plan pago." });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { template },
      { new: true }
    );

    res.json({ template: user.template });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// @desc    Activar o desactivar la cuenta del local
// @route   PATCH /api/users/active
// @access  Private
// ──────────────────────────────────────────────
const setActive = async (req, res) => {
  try {
    const { active } = req.body;

    if (typeof active !== "boolean") {
      return res.status(400).json({ message: "active debe ser un booleano" });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { active },
      { new: true }
    );

    res.json({ active: user.active });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// Aquí irían más funciones relacionadas con usuarios, como eliminar cuenta, cambiar password, etc.
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// @desc    Actualizar la suscripción del usuario
// @route   PATCH /api/users/subscription
// @access  Private
// ──────────────────────────────────────────────
const setSubscription = async (req, res) => {
  try {
    const { subscription } = req.body;
    const valid = ["none", "monthly", "semestral", "annual"];

    if (!valid.includes(subscription)) {
      return res.status(400).json({ message: "Valor de suscripción inválido" });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { subscription },
      { new: true }
    );

    res.json({ subscription: user.subscription });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ──────────────────────────────────────────────
// Exportamos todas las funciones para usarlas en las rutas
// ──────────────────────────────────────────────

module.exports = {
  newUser,
  loginUser,
  getAuthUser,
  fetchUserWithMenu,
  fetchOwnMenu,
  fetchUser,
  editUser,
  uploadImage,
  uploadBackground,
  removeImage,
  deleteBackground,
  useTemplate,
  setActive,
  setSubscription,
};