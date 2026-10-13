const Seller = require("../models/Seller");
const User = require("../models/User");
const { handleError } = require("../utils/handleError");
const { isValidEmail, isWeakPassword, isValidUsername } = require("../utils/validators");
const { toStoredPhone } = require("../utils/phone");
const { createUserWithUniqueSlug } = require("../utils/slug");
const { getPlanForUser } = require("../services/planCatalog");

// Campos del ABM (alta/baja/modificación de vendedores). Comisiones, métricas
// de facturación y el CRM de cada vendedor viven en su propio panel
// (/sellers), no en este listado — ver sellerPanelController/crmController.
const SELLER_FIELDS =
  "name mail number startDate dni code active admin influencer receivesLeads profilePicture createdAt updatedAt";

const sellerToDTO = (seller) => ({
  _id: seller._id,
  name: seller.name,
  mail: seller.mail,
  number: seller.number,
  startDate: seller.startDate,
  dni: seller.dni,
  code: seller.code,
  active: seller.active,
  admin: seller.admin,
  influencer: seller.influencer === true,
  receivesLeads: seller.receivesLeads === true,
  profilePicture: seller.profilePicture,
  createdAt: seller.createdAt,
  updatedAt: seller.updatedAt,
});

// Obtener todos los sellers
const getSellers = async (req, res) => {
  try {
    // Por default no se listan los vendedores dados de baja (active:false) —
    // el ABM sigue mostrando solo al equipo vigente salvo que se pida lo
    // contrario explícitamente.
    const includeInactive = req.query?.includeInactive === "true";
    const sellerFilter = includeInactive ? {} : { active: true };
    const sellers = await Seller.find(sellerFilter)
      .select(SELLER_FIELDS)
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(sellers.map(sellerToDTO));
  } catch (error) {
    handleError(res, error);
  }
};

// Obtener seller por ID
const getSellerById = async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id).select(SELLER_FIELDS).lean();

    if (!seller) {
      return res.status(404).json({
        message: "Vendedor no encontrado",
      });
    }

    res.status(200).json(sellerToDTO(seller));
  } catch (error) {
    handleError(res, error);
  }
};

// Crear seller
const createSeller = async (req, res) => {
  try {
    const { name, password, dni, mail, number, startDate, active, admin, influencer, receivesLeads } = req.body;
    if ([influencer, receivesLeads].some(value => value !== undefined && typeof value !== "boolean")) {
      return res.status(400).json({ message: "Influencer y recepción de leads deben ser booleanos" });
    }
    if (influencer && receivesLeads) {
      return res.status(400).json({ message: "Un influencer no puede recibir leads para seguimiento" });
    }
    let response = ""
    // Validar datos obligatorios
    if (!name || !dni) {
      response = "El nombre y DNI son obligatorios";
    }
    if( !password || password.length < 8) {
      response = response + "\nLa contraseña es obligatoria y debe tener al menos 8 caracteres";
    }
    if (!mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      response = response + "\nEl correo electrónico es obligatorio y debe ser válido";
    }
    if(response != "") {
      return res.status(400).json({
        message: response,
      });
    }

    // Verificar si ya existe un seller con ese DNI
    const existingDNI = await Seller.findOne({ dni });

    if (existingDNI) {
      return res.status(409).json({
        message: "Ya existe un vendedor con ese DNI",
      });
    }

    // Generar código único
    let code;
    let existingCode;

    do {
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const numbers = "0123456789";

      let randomLetters = "";
      let randomNumbers = "";

      for (let i = 0; i < 3; i++) {
        randomLetters += letters.charAt(
          Math.floor(Math.random() * letters.length)
        );
      }

      for (let i = 0; i < 3; i++) {
        randomNumbers += numbers.charAt(
          Math.floor(Math.random() * numbers.length)
        );
      }

      code = `${randomLetters}-${randomNumbers}`;

      existingCode = await Seller.findOne({ code });
    } while (existingCode);

    // Crear seller
    const seller = await Seller.create({
      name,
      password,
      mail,
      number,
      startDate,
      dni,
      code,
      admin: typeof admin === "boolean" ? admin : false,
      active: typeof active === "boolean" ? active : true,
      influencer: influencer === true,
      receivesLeads: receivesLeads === true,
    });

    res.status(201).json({
      message: "Vendedor creado correctamente",
      seller: sellerToDTO(seller),
    });
  } catch (error) {
    // Manejar duplicados de MongoDB
    if (error.code === 11000) {
      return res.status(409).json({
        message: "El vendedor ya existe",
      });
    }

    handleError(res, error);
  }
};

// Modificar seller
const updateSeller = async (req, res) => {
  try {
    const { name, dni, mail, number, startDate, active, admin, influencer, receivesLeads } = req.body;
    if ([influencer, receivesLeads].some(value => value !== undefined && typeof value !== "boolean")) {
      return res.status(400).json({ message: "Influencer y recepción de leads deben ser booleanos" });
    }

    const seller = await Seller.findById(req.params.id);

    if (!seller) {
      return res.status(404).json({
        message: "Vendedor no encontrado",
      });
    }

    if ((influencer ?? seller.influencer) && (receivesLeads ?? seller.receivesLeads)) {
      return res.status(400).json({ message: "Un influencer no puede recibir leads para seguimiento" });
    }

    // Verificar nombre duplicado
    if (name && name !== seller.name) {
      const existingName = await Seller.findOne({
        name,
        _id: { $ne: seller._id },
      });

      if (existingName) {
        return res.status(409).json({
          message: "Ya existe un vendedor con ese nombre",
        });
      }

      seller.name = name;
    }

    // Verificar DNI duplicado
    if (dni && dni !== seller.dni) {
      const existingDni = await Seller.findOne({
        dni,
        _id: { $ne: seller._id },
      });

      if (existingDni) {
        return res.status(409).json({
          message: "Ya existe un vendedor con ese DNI",
        });
      }

      seller.dni = dni;
    }

    if (mail && mail !== seller.mail) {
      seller.mail = mail;
    }

    if (number !== undefined && number !== seller.number) {
      seller.number = number;
    }

    if (startDate !== undefined && startDate !== seller.startDate) {
      seller.startDate = startDate;
    }

    if (typeof active === "boolean" && active !== seller.active) {
      seller.active = active;
    }

    if (typeof admin === "boolean" && admin !== seller.admin) {
      seller.admin = admin;
    }
    if (typeof influencer === "boolean") seller.influencer = influencer;
    if (typeof receivesLeads === "boolean") seller.receivesLeads = receivesLeads;

    await seller.save();

    res.status(200).json({ seller: sellerToDTO(seller) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "El vendedor ya existe",
      });
    }

    handleError(res, error);
  }
};

// Dar de baja a un seller. Baja lógica (active:false), no borrado físico: si
// más adelante ese vendedor tiene ventas históricas en SellerSale, el
// ranking/panel general siguen pudiendo resolver su nombre y código.
const deleteSeller = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true },
    );

    if (!seller) {
      return res.status(404).json({
        message: "Vendedor no encontrado",
      });
    }

    res.status(200).json({
      message: "Vendedor dado de baja correctamente",
      seller,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Admin resetea la contraseña de un vendedor sin pedir la actual (a
// diferencia de PATCH /api/sellers/me/password, de autoservicio).
const resetSellerPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({
        message: "La nueva contraseña debe tener al menos 8 caracteres",
      });
    }

    const seller = await Seller.findById(req.params.id);
    if (!seller) {
      return res.status(404).json({ message: "Vendedor no encontrado" });
    }

    seller.password = newPassword;
    await seller.save(); // el hook pre("save") la rehashea

    res.status(200).json({ message: "Contraseña restablecida correctamente" });
  } catch (error) {
    handleError(res, error);
  }
};

// Crea el usuario de prueba de un vendedor: una cuenta de comercio (User, no
// Seller) para que la use en sus demos. Plan Pro sin vencimiento
// (subscriptionExpiresAt:null, ver getEffectivePlan), con el mail y el
// teléfono del vendedor y su sellerID. Por lo demás nace vacía, igual que un
// alta normal: sin nombre de negocio, sin slug y sin menú. Va marcada con
// testUser para no contar en ninguna estadística (utils/testUsers.js).
const createSellerTestUser = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Mismo chequeo de tipos que newUser: express-mongo-sanitize no bloquea
    // un array o un objeto sin operadores.
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Usuario y contraseña son obligatorios" });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (!cleanUsername) {
      return res.status(400).json({ message: "Usuario y contraseña son obligatorios" });
    }
    if (!isValidUsername(cleanUsername)) {
      return res.status(400).json({ message: "El usuario no puede contener guiones" });
    }
    if (isWeakPassword(password)) {
      return res.status(400).json({
        message: "La contraseña debe tener al menos 8 caracteres y no puede ser una demasiado común.",
      });
    }

    const seller = await Seller.findById(req.params.id).select("name mail number active");
    if (!seller) {
      return res.status(404).json({ message: "Vendedor no encontrado" });
    }
    if (seller.active === false) {
      return res.status(400).json({
        message: "No se puede crear un usuario de prueba para un vendedor dado de baja",
      });
    }

    const cleanMail = String(seller.mail || "").trim().toLowerCase();
    if (!isValidEmail(cleanMail)) {
      return res.status(400).json({
        message: "El vendedor no tiene un mail válido. Corregilo antes de crear el usuario de prueba.",
      });
    }

    // Un email, una cuenta — mismo criterio que las altas públicas: la baja y
    // el arrepentimiento buscan la cuenta por mail. De paso evita crearle dos
    // usuarios de prueba al mismo vendedor.
    const existing = await User.findOne({
      $or: [{ username: cleanUsername }, { "contactInfo.mail": cleanMail }],
    }).select("username");
    if (existing) {
      return res.status(409).json({
        message: existing.username === cleanUsername
          ? "El username ya está en uso"
          : `Ya existe una cuenta con el mail del vendedor (usuario ${existing.username}).`,
      });
    }

    // Aborta temprano si el catálogo del plan Pro no está disponible.
    await getPlanForUser({ subscription: "pro" });

    const user = await createUserWithUniqueSlug({
      username: cleanUsername,
      password,
      contactInfo: { mail: cleanMail, number: toStoredPhone(seller.number) },
      // Nadie del otro lado para tipear un código: la crea un admin y tiene
      // que servir para la demo apenas se entrega.
      emailVerified: true,
      subscription: "pro",
      subscriptionExpiresAt: null,
      sellerID: seller._id,
      testUser: true,
    });

    res.status(201).json({
      message: "Usuario de prueba creado correctamente",
      user: {
        _id: user._id,
        username: user.username,
        mail: user.contactInfo.mail,
        number: user.contactInfo.number,
        subscription: user.subscription,
        subscriptionExpiresAt: user.subscriptionExpiresAt,
        sellerID: user.sellerID,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "El username ya está en uso" });
    }

    handleError(res, error);
  }
};

module.exports = {
  getSellers,
  getSellerById,
  createSeller,
  updateSeller,
  deleteSeller,
  resetSellerPassword,
  createSellerTestUser,
};

