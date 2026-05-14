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
    .replace(/\s+/g, "-");           // Espacios -> guiones

// ──────────────────────────────────────────────
// @desc    Registrar nuevo usuario (local)
// @route   POST /api/users/register
// @access  Public
// ──────────────────────────────────────────────
const newUser = async (req, res) => {
  try {
    const { username, password, contactInfo } = req.body;

    // Verifica que el username no esté tomado
    const exists = await User.findOne({ username });
    if (exists) {
      return res.status(400).json({ message: "El username ya está en uso" });
    }

    // Crea el user; el hook pre-save hashea la password automáticamente
    const user = await User.create({
      username,
      password,
      contactInfo,
      // Si ya viene businessName en el registro, generamos el slug desde el inicio
      slug: contactInfo?.businessName ? generateSlug(contactInfo.businessName) : undefined,
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
    res.json(user);
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
 
    res.json({ user, menu: menuArmado });
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
 
    res.json({ user });
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

    // Si actualizaron el businessName, regeneramos el slug automáticamente
    if (updates.contactInfo?.businessName) {
      updates.slug = generateSlug(updates.contactInfo.businessName);
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
// @desc    Obtener lista de todos los usuarios (solo para admin)
// @route   GET /api/users/all
// @access  Private (admin)
// ──────────────────────────────────────────────
const getAllUsers = async (req, res) => {
  try {
    if (!req.user.admin) {
      return res.status(403).json({ message: "Acceso denegado" });
    }

    const users = await User.find().select("-password");
    res.json(users);
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
// Exportamos todas las funciones para usarlas en las rutas
// ──────────────────────────────────────────────

module.exports = {
  newUser,
  loginUser,
  getAuthUser,
  fetchUserWithMenu,
  fetchUser,
  editUser,
  getAllUsers,
  uploadImage,
  useTemplate,
  setActive,
};