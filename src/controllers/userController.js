const { handleError } = require("../utils/handleError");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const PageView = require("../models/PageView");
const { hasMinPlan, FREE_ITEM_LIMIT } = require("../config/plans");

// ──────────────────────────────────────────────
// Helper: suma 1 a la visita de hoy del local (upsert, no bloqueante).
// Se llama desde la carta pública — nunca debe romper ni frenar esa
// respuesta si falla, por eso no se hace "await" en el caller.
// ──────────────────────────────────────────────
const trackView = (userID) => {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  PageView.findOneAndUpdate(
    { userID, date: today },
    { $inc: { count: 1 } },
    { upsert: true }
  ).catch(() => {});
};

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
// Helper: valida la contraseña en el registro.
// Solo longitud + una lista chica de las más triviales — no pedimos
// mayúscula/número/símbolo obligatorio: esa regla de "complejidad" está
// desaconsejada desde NIST 800-63B, porque en la práctica termina en
// patrones predecibles (ej. "Contraseña1!") en vez de contraseñas más
// fuertes. Lo que de verdad ayuda es longitud + no ser una de las
// contraseñas más usadas/filtradas.
// ──────────────────────────────────────────────
const COMMON_WEAK_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "password", "password1",
  "qwertyui", "qwerty123", "11111111", "00000000", "abc12345",
  "contraseña", "contrasena", "argentina", "administrador",
]);

const isWeakPassword = (password) =>
  password.length < 8 || COMMON_WEAK_PASSWORDS.has(password.toLowerCase());

// ──────────────────────────────────────────────
// @desc    Registrar nuevo usuario (local)
// @route   POST /api/users/register
// @access  Public
// ──────────────────────────────────────────────
const newUser = async (req, res) => {
  try {
    const { username, password, contactInfo, acceptedTerms } = req.body;

    // express-mongo-sanitize ya saca claves tipo operador ($ne, $regex) del
    // body, pero no bloquea otros tipos no-string (ej. un array) — por eso
    // validamos el tipo acá también, antes de que username/password lleguen
    // a la query de Mongo o a bcrypt.
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Usuario y contraseña son obligatorios" });
    }

    if (isWeakPassword(password)) {
      return res.status(400).json({
        message: "La contraseña debe tener al menos 8 caracteres y no puede ser una demasiado común.",
      });
    }

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
    handleError(res, error);
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

    // Mismo motivo que en newUser: sin esto, mandar username/password como
    // objeto o array en vez de string puede llegar a la query de Mongo o a
    // bcrypt.compare con un tipo inesperado.
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

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
    handleError(res, error);
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
    handleError(res, error);
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

    // Esta ruta es la que carga el cliente al ver la carta (ej: al escanear
    // el QR de la mesa), así que es el lugar correcto para contar la
    // visita — no se cuenta la landing pública (fetchUser) por separado,
    // para no duplicar el conteo de una misma sesión de un cliente.
    trackView(user._id);

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
    handleError(res, error);
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

    // El front usa esto para mostrar "X/15 productos", deshabilitar
    // "Agregar producto" al llegar al tope, y mostrar el candado en
    // "Importar desde Excel" — la fuente de verdad real sigue siendo
    // el check en newItem y el middleware requirePlan en massiveRoutes,
    // esto es solo para la UI.
    const unlimited = hasMinPlan(req.user.subscription, "monthly");
    const limits = {
      itemCount: allItems.length,
      itemLimit: unlimited ? null : FREE_ITEM_LIMIT,
      canImportExcel: unlimited, // misma condición: plan mensual o superior
    };

    res.json({ menu: menuArmado, limits });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Estadísticas de visitas a la carta pública del usuario
//          autenticado: total y serie diaria de los últimos 30 días.
//          El gating a semestral+ lo hace el middleware requirePlan
//          en la ruta, no este controller.
// @route   GET /api/users/me/stats
// @access  Private (semestral+)
// ──────────────────────────────────────────────
const fetchStats = async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 29); // 30 días incluyendo hoy
    const sinceStr = since.toISOString().slice(0, 10);

    const rows = await PageView.find({
      userID: req.user._id,
      date: { $gte: sinceStr },
    });

    const byDate = {};
    rows.forEach((r) => { byDate[r.date] = r.count; });

    // Completamos los días sin visitas con 0 para que el front dibuje
    // una serie continua de 30 puntos en vez de saltear huecos.
    const last30Days = [];
    let totalViews = 0;
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const count = byDate[key] || 0;
      totalViews += count;
      last30Days.push({ date: key, count });
    }

    res.json({ totalViews, last30Days });
  } catch (error) {
    handleError(res, error);
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
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Editar datos del usuario autenticado
// @route   PUT /api/users/me
// @access  Private
// ──────────────────────────────────────────────
const editUser = async (req, res) => {
  try {
    // "template" queda afuera a propósito: cambiar el template pasa por
    // PATCH /api/users/template (useTemplate), que valida si es premium y
    // el usuario tiene plan pago. Si "template" estuviera acá, cualquiera
    // podría mandarlo por este endpoint y saltarse esa validación.
    const allowedFields = ["contactInfo", "hasDelivery", "media"];

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
    handleError(res, error);
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
    handleError(res, error);
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
    handleError(res, error);
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
    handleError(res, error);
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
    handleError(res, error);
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
    handleError(res, error);
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
    handleError(res, error);
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
  fetchOwnMenu,
  fetchStats,
  fetchUser,
  editUser,
  uploadImage,
  uploadBackground,
  removeImage,
  deleteBackground,
  useTemplate,
  setActive,
};