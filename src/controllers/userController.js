const mongoose = require("mongoose");
const { handleError } = require("../utils/handleError");
const { generateAuthToken } = require("../utils/authToken");
const User = require("../models/User");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const PageView = require("../models/PageView");
const ItemView = require("../models/ItemView");
const {
  getSubscriptionState,
  getTemplateForFeatures,
  TEMPLATE_IDS,
} = require("../config/plans");
const { getPlanForUser, getRequestPlan } = require("../services/planCatalog");
const {
  MENU_STYLES, MENU_STYLE_LABELS, getMenuStyle, getMenuStyleFeature, getMenuStyleForFeatures,
} = require("../config/menuStyles");
const { buenosAiresDateStr } = require("../utils/dates");
const { buildStatsPeriod } = require("../utils/statsPeriod");
const { logCrmEvent } = require("../utils/crmEvents");
const { buildMenuHTML, buildFooterTemplate } = require("../utils/menuPdfTemplate");
const { getBrowser } = require("../utils/pdfBrowser");
const {
  createUserWithUniqueSlug,
  generateSlug,
  updateUserWithUniqueSlug,
} = require("../utils/slug");
const { isScheduleAvailableAt } = require("../utils/itemAvailability");
const { getEmptyOfferSchedule, isOfferActive } = require("../utils/offers");
const {
  buildPublicMenu, getReachableCategoryIds, toPublicContactInfo, toPublicMedia, toPublicFeatures,
} = require("../utils/publicMenu");
const { MENU_ORDER_SORT, sortByMenuOrder } = require("../utils/menuOrder");
const { isValidEmail, isWeakPassword, isValidUsername, isValidPhone } = require("../utils/validators");
const { escapeRegex } = require("../utils/regex");
const { normalizeArPhone, isValidArLocalPhone, toStoredPhone } = require("../utils/phone");
const {
  maskEmail,
  createPendingServiceAction,
  claimPendingServiceAction,
} = require("../utils/serviceActionCodes");
const Seller = require("../models/Seller");
const { nextLeadSeller } = require("../services/leadAssignmentService");

// Manda el código de verificación de email: al registrarse (newUser) y cada
// vez que cambia el mail real de la cuenta (editUser). Best-effort a
// propósito: la escritura que la dispara (alta o edición de perfil) ya se
// guardó — si el mail falla acá no queremos revertir ni bloquear esa
// respuesta, el dueño puede reenviarlo después con
// POST /users/me/verify-email/resend.
const sendEmailVerificationCode = async (user) => {
  try {
    await createPendingServiceAction({
      action: "verificacion_email",
      userID: user._id,
      email: user.contactInfo.mail,
    });
  } catch (error) {
    console.error("No se pudo enviar el email de verificación al registrarse:", error);
  }
};

// ──────────────────────────────────────────────
// Helper: suma 1 a la visita de hoy del local (upsert, no bloqueante).
// Se llama desde la carta pública — nunca debe romper ni frenar esa
// respuesta si falla, por eso no se hace "await" en el caller.
// El "hoy" se calcula en horario de Buenos Aires (ver utils/dates): así el
// contador diario corta a la medianoche local y no a las 21:00 (medianoche UTC).
// ──────────────────────────────────────────────
const trackView = (userID) => {
  const today = buenosAiresDateStr(); // "YYYY-MM-DD" en horario argentino
  PageView.findOneAndUpdate(
    { userID, date: today },
    { $inc: { count: 1 } },
    { upsert: true }
  ).catch(() => {});
};

// ──────────────────────────────────────────────
// Helper: suma 1 a la vista de hoy de un producto puntual (upsert, no
// bloqueante). Mismo criterio que trackView, a nivel de item.
// ──────────────────────────────────────────────
const trackItemView = (userID, itemID) => {
  const today = buenosAiresDateStr();
  ItemView.findOneAndUpdate(
    { userID, itemID, date: today },
    { $inc: { count: 1 } },
    { upsert: true }
  ).catch(() => {});
};

// Exponer y editar solo el contrato vigente, aunque un documento antiguo
// todavía conserve campos que ya no forman parte del producto.
const getContactInfo = (contactInfo) => {
  const source = contactInfo?.toObject?.() ?? contactInfo ?? {};
  const fields = ["mail", "number", "whatsappNumbers", "location", "address", "social", "businessName", "reservationMessage", "orderMessage"];
  return Object.fromEntries(fields
    .filter(field => Object.prototype.hasOwnProperty.call(source, field))
    .map(field => [field, source[field]]));
};

// Tope de contactInfo.orderMessage (ver editUser); el modelo repite el mismo
// número como red de contención.
const ORDER_MESSAGE_MAX_LENGTH = 500;

// Topes de contactInfo.whatsappNumbers; el modelo repite los mismos.
const WHATSAPP_NUMBERS_MAX = 10;
const WHATSAPP_NAME_MAX_LENGTH = 40;

// Valida y normaliza la lista de números de WhatsApp que manda el panel.
// Devuelve { value } o { error } con el mensaje para el dueño.
const parseWhatsappNumbers = (raw) => {
  if (!Array.isArray(raw)) return { error: "Los números de WhatsApp no son válidos." };
  if (raw.length > WHATSAPP_NUMBERS_MAX) {
    return { error: `Podés cargar hasta ${WHATSAPP_NUMBERS_MAX} números de WhatsApp.` };
  }
  const value = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { error: "Los números de WhatsApp no son válidos." };
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name.length > WHATSAPP_NAME_MAX_LENGTH) {
      return { error: `El nombre de cada WhatsApp no puede superar los ${WHATSAPP_NAME_MAX_LENGTH} caracteres.` };
    }
    const number = normalizeArPhone(entry.number);
    if (!isValidArLocalPhone(number)) {
      return {
        error: `El WhatsApp${name ? ` "${name}"` : ""} no es válido: ingresá código de área y número, sin 0 ni 15 (ej: 11 2345-6789).`,
      };
    }
    value.push({ name, number });
  }
  // Con más de un número el cliente elige por nombre: tiene que haber uno.
  if (value.length > 1 && value.some(entry => !entry.name)) {
    return { error: "Si cargás más de un WhatsApp, ponele un nombre a cada uno (ej: la sucursal)." };
  }
  return { value };
};

// Datos que el dueño puede ocultar de la landing pública desde el panel de
// Configuración (ver panelSettings.landingVisibility en models/User.js).
const LANDING_VISIBILITY_KEYS = ["phone", "whatsappReserve", "mail", "address", "schedule", "instagram", "facebook"];

// `!== false` y no `=== true`: un documento anterior a esta opción no tiene
// el campo guardado, y eso significa "mostrar" (mismo default que el schema).
const getLandingVisibility = (user) => Object.fromEntries(
  LANDING_VISIBILITY_KEYS.map(key => [key, user?.panelSettings?.landingVisibility?.[key] !== false])
);

// contactInfo público sin lo que el dueño eligió ocultar. Se quita del JSON
// en vez de mandarlo igual y esconderlo solo en el front: si el dueño no
// quiere mostrar su mail, no tiene por qué quedar expuesto en la respuesta
// de la API. `keys` acota qué opciones se aplican (ver fetchUserWithMenu).
const hideContactInfo = (contactInfo, visibility, keys = LANDING_VISIBILITY_KEYS) => {
  const isHidden = (key) => keys.includes(key) && !visibility[key];
  const info = { ...contactInfo };
  const blank = (field, value) => {
    if (Object.prototype.hasOwnProperty.call(info, field)) info[field] = value;
  };

  // El número alimenta dos cosas en la landing (la fila de teléfono y el
  // botón de reservas, cuando no hay números de WhatsApp cargados): solo
  // deja de enviarse si ninguna de las dos lo usa.
  const hasWhatsappNumbers = Array.isArray(info.whatsappNumbers) && info.whatsappNumbers.length > 0;
  if (isHidden("phone") && (isHidden("whatsappReserve") || hasWhatsappNumbers)) blank("number", null);
  if (isHidden("whatsappReserve")) blank("whatsappNumbers", []);
  if (isHidden("mail")) blank("mail", "");
  // location (lat/lng) ubica el local igual que la dirección.
  if (isHidden("address")) { blank("address", ""); blank("location", {}); }
  if (info.social && (isHidden("instagram") || isHidden("facebook"))) {
    info.social = { ...info.social }; // copia: no tocar el objeto del documento
    if (isHidden("instagram")) delete info.social.instagram;
    if (isHidden("facebook")) delete info.social.facebook;
  }
  return info;
};

// Opciones de cómo se ve la carta pública, que el dueño activa desde el panel
// de Configuración (ver panelSettings.menuDisplay en models/User.js).
const MENU_DISPLAY_KEYS = ["featuredSection", "collapsibleCategories", "hidePrices"];

// `=== true`, al revés que getLandingVisibility: estas opciones arrancan
// apagadas, así que un documento sin el campo guardado significa "no".
const getMenuDisplay = (user) => Object.fromEntries(
  MENU_DISPLAY_KEYS.map(key => [key, user?.panelSettings?.menuDisplay?.[key] === true])
);

// Item de la carta pública sin precios, para cuando el dueño activó "Ocultar
// precios". Mismo principio que hideContactInfo: las dos rutas públicas con
// los productos, la carta (GET /:slug/menu) y el PDF (GET /:slug/menu/pdf),
// no mandan lo que el dueño ocultó, en vez de mandarlo igual y esconderlo
// solo en el front o en el template. Ver getPublicMenuItem.
// Las claves de options se conservan porque la carta y el PDF siguen
// mostrando los nombres de las variantes (y el pedido por WhatsApp las
// lista); solo se pisa el valor. Recibe el item ya pasado por
// getPublicItemForPlan (objeto plano, options sin Map).
const hideItemPrices = (item) => ({
  ...item,
  price: null,
  offerPrice: null,
  offerRange: { from: null, to: null },
  offerSchedule: getEmptyOfferSchedule(),
  options: Object.fromEntries(Object.keys(item.options ?? {}).map(name => [name, 0])),
});

const getPublicItemForPlan = (item, features) => {
  const filtered = item.toObject({ flattenMaps: true });
  const hasSchedule = filtered.offerRange?.from || filtered.offerRange?.to
    || filtered.offerSchedule?.enabled;
  if (hasSchedule && !features.programacion_productos) {
    filtered.offerPrice = null;
    filtered.offerRange = { from: null, to: null };
    filtered.offerSchedule = getEmptyOfferSchedule();
  }
  if (filtered.offerPrice != null && !isOfferActive(filtered)) {
    filtered.offerPrice = null;
  }
  if (
    filtered.available &&
    features.programacion_productos &&
    filtered.availabilitySchedule?.enabled
  ) {
    filtered.available = isScheduleAvailableAt(filtered.availabilitySchedule);
  }
  return filtered;
};

// Item tal como lo ven los clientes, en la carta (fetchUserWithMenu) y en el
// PDF (downloadMenuPdf): filtrado según el plan y, con "Ocultar precios", sin
// precios. El editor (fetchOwnMenu) no pasa por acá: necesita los precios
// para editarlos.
const getPublicMenuItem = (item, features, menuDisplay) => {
  const publicItem = getPublicItemForPlan(item, features);
  return menuDisplay.hidePrices ? hideItemPrices(publicItem) : publicItem;
};

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

    // Sin esto, dos cuentas con distinta capitalización ("MiLocal" /
    // "milocal") podían coexistir (Mongo compara strings case-sensitive), y
    // solicitarBaja -- que sí busca en minúsculas -- nunca encontraba una
    // cuenta creada con mayúsculas. Se normaliza acá, en el único lugar
    // donde se crea el username, en vez de en cada lugar que lo consulta.
    const cleanUsername = username.trim().toLowerCase();

    if (!isValidUsername(cleanUsername)) {
      return res.status(400).json({ message: "El usuario no puede contener guiones" });
    }

    // El email de contacto no es solo un dato de perfil: baja y arrepentimiento
    // (Ley 24.240) dependen de poder mandarle un código de confirmación a esta
    // cuenta. Sin este chequeo, una cuenta con contactInfo.mail vacío o
    // inválido (ej. "ididid") queda sin forma de ejercer esos derechos.
    if (!isValidEmail(contactInfo?.mail)) {
      return res.status(400).json({ message: "Ingresá un email de contacto válido" });
    }

    // Le da a los vendedores una forma real de contactar al cliente antes de
    // que pague (ver registerTrial) — se exige acá también para que todo
    // alta nueva, con o sin código de promoción, tenga el dato.
    if (!isValidPhone(contactInfo?.number)) {
      return res.status(400).json({ message: "Ingresá un teléfono de contacto válido" });
    }

    if (isWeakPassword(password)) {
      return res.status(400).json({
        message: "La contraseña debe tener al menos 8 caracteres y no puede ser una demasiado común.",
      });
    }

    // Verifica que el username no esté tomado
    const exists = await User.findOne({ username: cleanUsername });
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

    // El alta gratuita también exige un catálogo disponible y válido.
    await getPlanForUser({ subscription: "free" });

    // Crea el user; el hook pre-save hashea la password automáticamente
    const user = await createUserWithUniqueSlug({
      username: cleanUsername,
      password,
      contactInfo: { ...contactInfo, number: toStoredPhone(contactInfo.number) },
      acceptedTerms: true,
      acceptedTermsAt: new Date(),
      acceptedTermsVersion: process.env.ACCEPTED_TERMS_VERSION,
      emailVerified: false,
    });

    await sendEmailVerificationCode(user);

    res.status(201).json({
      _id: user._id,
      username: user.username,
      token: generateAuthToken(user._id),
    });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Registrar cuenta con prueba gratis de 7 días del plan Pro. Solo se
//          accede con un código de promoción válido — es lo único que la
//          dispara. Crea el User definitivo de una (como newUser), sin pasar
//          por PendingRegistration ni Mercado Pago: no hay pago que esperar.
// @route   POST /api/users/register-trial
// @access  Public
// ──────────────────────────────────────────────
const registerTrial = async (req, res) => {
  try {
    const { username, password, contactInfo, acceptedTerms, sellerCode } = req.body;

    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Usuario y contraseña son obligatorios" });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (!isValidUsername(cleanUsername)) {
      return res.status(400).json({ message: "El usuario no puede contener guiones" });
    }

    if (!isValidEmail(contactInfo?.mail)) {
      return res.status(400).json({ message: "Ingresá un email de contacto válido" });
    }

    if (!isValidPhone(contactInfo?.number)) {
      return res.status(400).json({ message: "Ingresá un teléfono de contacto válido" });
    }

    if (isWeakPassword(password)) {
      return res.status(400).json({
        message: "La contraseña debe tener al menos 8 caracteres y no puede ser una demasiado común.",
      });
    }

    if (acceptedTerms !== true) {
      return res.status(400).json({ message: "Debes aceptar los términos y condiciones" });
    }

    // El código de promoción es obligatorio acá: es lo único que dispara la
    // prueba gratis (a diferencia de crear-preferencia-registro, donde era
    // opcional porque solo daba un descuento sobre un pago real).
    if (typeof sellerCode !== "string" || !sellerCode.trim()) {
      return res.status(400).json({
        message: "Ingresá un código de promoción válido para activar la prueba gratuita",
      });
    }
    const code = sellerCode.trim().toUpperCase();
    if (!/^[A-Z]{3}-\d{3}$/.test(code)) {
      return res.status(400).json({ message: "Código de promoción inválido" });
    }
    const seller = await Seller.findOne({ code });
    if (!seller || seller.active === false) {
      return res.status(400).json({ message: "Código de promoción no encontrado" });
    }

    // Chequeo de duplicados fuerte (username O email) — más estricto que el
    // de newUser (solo username) a propósito: la prueba gratis reparte un
    // recurso real (7 días de Pro sin pagar), así que no puede repetirse con
    // el mismo email usando un username distinto.
    const cleanMail = String(contactInfo.mail).trim().toLowerCase();
    const existingUser = await User.findOne({
      $or: [{ username: cleanUsername }, { "contactInfo.mail": cleanMail }],
    });
    if (existingUser) {
      return res.status(409).json({ message: "Usuario o email ya registrado" });
    }

    // Aborta temprano si el catálogo del plan Pro no está disponible/inválido,
    // antes de crear ninguna cuenta.
    await getPlanForUser({ subscription: "pro" });

    const now = new Date();
    const trialExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const influencerReferral = seller.influencer === true;
    const assignedSeller = influencerReferral ? await nextLeadSeller() : null;

    const user = await createUserWithUniqueSlug({
      username: cleanUsername,
      password,
      contactInfo: { ...contactInfo, mail: cleanMail, number: toStoredPhone(contactInfo.number) },
      acceptedTerms: true,
      acceptedTermsAt: now,
      acceptedTermsVersion: process.env.ACCEPTED_TERMS_VERSION,
      emailVerified: false,
      subscription: "pro",
      subscriptionExpiresAt: trialExpiresAt,
      sellerID: seller._id,
      influencerReferral,
      assignedSeller,
      assignedSellerAt: assignedSeller ? now : null,
      trialActive: true,
    });

    await sendEmailVerificationCode(user);

    res.status(201).json({
      _id: user._id,
      username: user.username,
      token: generateAuthToken(user._id),
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

    //verificar primero si es un vendedor para no hacer todo el proceso para los usuarios normales
    if(username.includes("-")) {
      const seller = await Seller.findOne({ code: username }).select("+password");
      if (!seller || !(await seller.matchPassword(password))) {
        return res.status(401).json({ message: "Credenciales inválidas" });
      }
      if (!seller.active) {
      return res.status(403).json({ message: "Cuenta desactivada" });
      } 
      let activeAndAuthenticated = true
      if(seller != null && activeAndAuthenticated) {
       return res.json({
      _id: seller._id,
      username: seller.name,
      code: seller.code,
      admin: seller.admin,
      role: "seller",
      influencer: seller.influencer === true,
      profilePicture: seller.profilePicture,
      token: generateAuthToken(seller._id, "seller"),
    });
      }
      
    }


    // Las cuentas nuevas se guardan en minúsculas (ver newUser), pero las
    // creadas antes de ese fix pueden tener mayúsculas guardadas tal cual
    // se escribieron. Un match exacto en minúsculas rompería el login de
    // esas cuentas viejas — se busca case-insensitive (ancorado, sin
    // comodines) para que funcione para ambas sin importar cómo se guardó
    // ni cómo la tipeen ahora.
    const cleanUsername = username.trim();
    const usernamePattern = new RegExp(`^${escapeRegex(cleanUsername)}$`, "i");

    // Incluimos password explícitamente porque tiene select:false en el modelo
    const user = await User.findOne({ username: usernamePattern }).select("+password");

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    if (!user.active) {
      return res.status(403).json({ message: "Cuenta desactivada" });
    }

    const subscriptionState = getSubscriptionState(
      user.subscription,
      user.subscriptionExpiresAt
    );

    res.json({
      _id: user._id,
      username: user.username,
      admin: user.admin,
      slug: user.slug,
      subscription: subscriptionState.effectivePlan,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      subscriptionStatus: subscriptionState.subscriptionStatus,
      previousSubscription: subscriptionState.previousSubscription,
      downgradeReason: subscriptionState.downgradeReason,
      downgradedAt: subscriptionState.downgradedAt,
      emailVerified: user.emailVerified,
      // El front lo usa para saber si la cuenta tiene un precio con
      // descuento por código de promoción (ver /crear-preferencia).
      sellerID: user.sellerID,
      token: generateAuthToken(user._id),
    });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Confirmar el código de verificación de email mandado al crear la
//          cuenta (ver sendEmailVerificationCode en newUser y en el webhook
//          de pagos, processPaymentEvent). No bloquea el login: la cuenta
//          entra normal y el frontend redirige a la pantalla de código
//          mientras emailVerified sea false.
// @route   POST /api/users/me/verify-email
// @access  Private
// ──────────────────────────────────────────────
const verifyEmail = async (req, res) => {
  try {
    if (req.user.emailVerified) {
      return res.json({ emailVerified: true });
    }

    const { code } = req.body;
    if (typeof code !== "string" || !code.trim()) {
      return res.status(400).json({ message: "Ingresá el código que te enviamos por email." });
    }

    const { error } = await claimPendingServiceAction({
      userID: req.user._id,
      code: code.trim(),
      action: "verificacion_email",
    });
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    await User.findByIdAndUpdate(req.user._id, { $set: { emailVerified: true } });

    res.json({ emailVerified: true });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Reenviar el código de verificación de email (ej. el primero se
//          perdió o venció a los 15 min). Invalida cualquier código anterior
//          sin usar (ver createPendingServiceAction).
// @route   POST /api/users/me/verify-email/resend
// @access  Private
// ──────────────────────────────────────────────
const resendVerificationCode = async (req, res) => {
  try {
    if (req.user.emailVerified) {
      return res.json({ emailVerified: true });
    }

    if (!isValidEmail(req.user.contactInfo?.mail)) {
      return res.status(400).json({
        message: "El email de contacto de tu cuenta no es válido. Escribinos a menudigitalappsoporte@gmail.com para resolverlo.",
      });
    }

    try {
      await createPendingServiceAction({
        action: "verificacion_email",
        userID: req.user._id,
        email: req.user.contactInfo.mail,
      });
    } catch (error) {
      if (error.isMailError) {
        console.error("No se pudo reenviar el código de verificación de email:", error.cause);
        return res.status(503).json({
          message: "No pudimos enviar el email. Intentá de nuevo o escribinos a menudigitalappsoporte@gmail.com.",
        });
      }
      throw error;
    }

    res.json({ ok: true, maskedEmail: maskEmail(req.user.contactInfo.mail) });
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
    // Usa el reloj de MongoDB y devuelve el valor persistido en la misma consulta.
    // La actividad no cambia updatedAt: el sitemap lo usa como fecha de contenido.
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $currentDate: { lastConnectionAt: true } },
      { new: true, timestamps: false }
    );
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    // Contar items y categorías del usuario
    const menus = await Menu.find({ userID: user._id });
    const categorias = menus.filter(m => m.section === false);
    const menuIDs = categorias.map(m => m._id);
    const itemCount = await Item.countDocuments({ menuID: { $in: menuIDs }, hidden: false });

    const plan = await getPlanForUser(user);
    const subscriptionState = getSubscriptionState(
      user.subscription,
      user.subscriptionExpiresAt
    );
    const effectivePlan = plan.name;
    res.json({
      ...user.toObject(),
      contactInfo: getContactInfo(user.contactInfo),
      subscription: effectivePlan,
      subscriptionStatus: subscriptionState.subscriptionStatus,
      previousSubscription: subscriptionState.previousSubscription,
      downgradeReason: subscriptionState.downgradeReason,
      downgradedAt: subscriptionState.downgradedAt,
      features: plan.features,
      template: getTemplateForFeatures(user.template, plan.features),
      menuStyle: getMenuStyleForFeatures(user.menuStyle, plan.features),
      itemCount,
      categoryCount: categorias.length,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Versión liviana de GET /me para el dashboard, que solo necesita
//          7 campos y no el usuario completo (ver getAuthUser para el
//          editor de perfil, que sí necesita el objeto entero).
// @route   GET /api/users/me/summary
// @access  Private
// ──────────────────────────────────────────────
const getAuthUserSummary = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      "slug hasDelivery template subscription subscriptionExpiresAt contactInfo.businessName media.backgroundPicture"
    );
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    // Contar items y categorías del usuario. getPlanForUser solo depende del
    // user ya leído (no de los menús), así que corre en paralelo con esa
    // consulta en vez de sumar su propio round-trip a Mongo atrás del resto.
    const [{ categorias, itemCount }, plan] = await Promise.all([
      (async () => {
        const menus = await Menu.find({ userID: user._id });
        const categorias = menus.filter(m => m.section === false);
        const menuIDs = categorias.map(m => m._id);
        const itemCount = await Item.countDocuments({ menuID: { $in: menuIDs }, hidden: false });
        return { categorias, itemCount };
      })(),
      getPlanForUser(user),
    ]);

    res.json({
      slug: user.slug,
      hasDelivery: user.hasDelivery,
      template: getTemplateForFeatures(user.template, plan.features),
      itemCount,
      categoryCount: categorias.length,
      contactInfo: getContactInfo(user.contactInfo),
      media: { backgroundPicture: user.media?.backgroundPicture || "" },
    });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// Carta pública v2: lo que se le pide a Mongo. Solo lo que usa la respuesta:
// del local no se lee ni mail, redes, ubicación, horario, password ni
// pendingMenuImages; de las secciones y categorías, título y jerarquía; del
// producto, lo que hace falta para resolver oferta y disponibilidad AHORA
// (offerRange, offerSchedule, availabilitySchedule, available: después solo
// viajan) más lo que la carta dibuja. `hidden` no se pide en items ni menús
// porque el filtro de la query ya lo garantiza. subscription y
// subscriptionExpiresAt solo sirven para resolver el plan vigente.
// ──────────────────────────────────────────────
const PUBLIC_MENU_USER_SELECT = [
  "contactInfo.businessName", "contactInfo.number", "contactInfo.whatsappNumbers", "contactInfo.address", "contactInfo.orderMessage",
  "media", "hasDelivery", "template", "menuStyle",
  "subscription", "subscriptionExpiresAt", "panelSettings.menuDisplay",
].join(" ");
const PUBLIC_MENU_MENU_SELECT = "title section sectionID";
const PUBLIC_MENU_ITEM_SELECT = [
  "menuID", "title", "price", "offerPrice", "offerRange", "offerSchedule",
  "available", "availabilitySchedule", "description", "image", "options", "recommended", "apt",
].join(" ");

// Los items vienen en un solo batch: con el batchSize por defecto del driver
// (101 documentos) una carta de cientos de productos necesita un getMore, o
// sea un round-trip más a Atlas (medido: ~66 ms con 639 items). 2000 cubre
// de sobra una carta real; por encima de eso sigue funcionando, con getMore.
const PUBLIC_MENU_ITEMS_BATCH_SIZE = 2000;

// ──────────────────────────────────────────────
// @desc    Carta pública en el contrato v2 (GET /:slug/menu?v=2): la misma
//          carta que fetchUserWithMenu pero solo con lo que se dibuja, y
//          resuelta en 3 pasos seriales en vez de 5 (ver utils/publicMenu.js
//          para la forma de la respuesta). fetchUserWithMenu la despacha
//          cuando llega ?v=2; sin el parámetro responde el contrato legacy,
//          porque hay bundles viejos del front y el back y el front se
//          despliegan por separado, en cualquier orden.
//          Sin cache compartida: la respuesta depende de la hora (ofertas y
//          disponibilidad programadas) y cada request cuenta una visita.
// @route   GET /api/users/:slug/menu?v=2
// @access  Public
// ──────────────────────────────────────────────
const fetchPublicMenuV2 = async (req, res) => {
  try {
    const slugNormalizado = generateSlug(req.params.slug);

    // Sin lean a propósito: es un solo documento, y así siguen valiendo los
    // defaults del schema, getContactInfo y getMenuDisplay como en el resto.
    const user = await User.findOne({ slug: slugNormalizado, active: true })
      .select(PUBLIC_MENU_USER_SELECT);
    if (!user) return res.status(404).json({ message: "Local no encontrado" });

    // El plan y los menús no dependen entre sí: van en paralelo. El Plan no se
    // cachea (se lee por petición, ver planCatalog.js).
    const [plan, menus] = await Promise.all([
      getPlanForUser(user),
      Menu.find({ userID: user._id, hidden: false })
        .select(PUBLIC_MENU_MENU_SELECT)
        .sort(MENU_ORDER_SORT) // el orden que eligió el dueño (ver utils/menuOrder.js)
        .lean(),
    ]);

    // Igual que en la carta legacy: se cuenta la visita una vez resuelto el
    // plan, y sin esperarla (fire-and-forget).
    trackView(user._id);

    // Solo se piden los items de las categorías que la carta puede mostrar
    // (sueltas o dentro de una sección visible), no los de huérfanas.
    const categoryIds = getReachableCategoryIds(menus);
    const items = categoryIds.length === 0
      ? []
      : await Item.find({ menuID: { $in: categoryIds }, hidden: false })
        .select(PUBLIC_MENU_ITEM_SELECT)
        .sort(MENU_ORDER_SORT)
        .lean()
        .batchSize(PUBLIC_MENU_ITEMS_BATCH_SIZE);

    const menuDisplay = getMenuDisplay(user);
    const { features } = plan;
    // La hora se toma UNA vez por request: todas las ofertas y horarios se
    // resuelven contra el mismo instante.
    const now = new Date();

    res.json({
      user: {
        contactInfo: toPublicContactInfo(getContactInfo(user.contactInfo)),
        media: toPublicMedia(user.media),
        hasDelivery: user.hasDelivery === true,
        template: getTemplateForFeatures(user.template, features),
        menuStyle: getMenuStyleForFeatures(user.menuStyle, features),
        features: toPublicFeatures(features),
        menuDisplay,
      },
      menu: buildPublicMenu({
        menus, items, features, hidePrices: menuDisplay.hidePrices, now,
      }),
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
  if (req.query?.v === "2") return fetchPublicMenuV2(req, res);
  try {
    const { slug } = req.params
    const slugNormalizado = generateSlug(slug);
 
    const user = await User.findOne({ slug: slugNormalizado, active: true });
    if (!user) return res.status(404).json({ message: "Local no encontrado" });
    const plan = await getPlanForUser(user);
    const effectivePlan = plan.name;

    // Esta ruta es la que carga el cliente al ver la carta (ej: al escanear
    // el QR de la mesa), así que es el lugar correcto para contar la
    // visita — no se cuenta la landing pública (fetchUser) por separado,
    // para no duplicar el conteo de una misma sesión de un cliente.
    trackView(user._id);

    // Traemos todos los menus del user, en el orden de la carta (ver
    // utils/menuOrder.js): el armado de abajo conserva el orden de los arrays.
    const menus = sortByMenuOrder(await Menu.find({ userID: user._id, hidden: false }));
    const menuIDs = menus.map((m) => m._id);

    // Traemos todos los items de esos menus
    const allItems = sortByMenuOrder(await Item.find({ menuID: { $in: menuIDs }, hidden: false }));
 
    // Separamos secciones y categorías
    const secciones  = menus.filter((m) => m.section === true);
    const categorias = menus.filter((m) => m.section === false);

    // Con "Ocultar precios" los items viajan sin precios (getPublicMenuItem),
    // igual que en el PDF. El carrito y el pedido por WhatsApp siguen: la
    // carta los arma con productos y cantidades, sin montos.
    const menuDisplay = getMenuDisplay(user);
    const toPublicItem = (item) => getPublicMenuItem(item, plan.features, menuDisplay);

    const userFiltered = {
      _id: user._id,
      // La carta no muestra mail ni redes, así que si el dueño los ocultó de
      // la landing tampoco se envían acá. Número (pedidos por WhatsApp),
      // dirección (cabecera) y horario siguen: la opción es de la landing.
      contactInfo: hideContactInfo(
        getContactInfo(user.contactInfo),
        getLandingVisibility(user),
        ["mail", "instagram", "facebook"]
      ),
      media: user.media,
      hasDelivery: user.hasDelivery,
      template: getTemplateForFeatures(user.template, plan.features),
      schedule: user.schedule,
      subscription: effectivePlan,
      features: plan.features,
      menuDisplay,
      menuStyle: getMenuStyleForFeatures(user.menuStyle, plan.features),
    }

    const menuArmado = {
      secciones: secciones.map((sec) => ({
        ...sec.toObject(),
        categorias: categorias
          .filter((cat) => cat.sectionID && cat.sectionID.equals(sec._id))
          .map((cat) => ({
            ...cat.toObject(),
            items: allItems
              .filter((item) => item.menuID.equals(cat._id))
              .map(toPublicItem),
          })),
      })),
      sinSeccion: categorias
        .filter((cat) => !cat.sectionID)
        .map((cat) => ({
          ...cat.toObject(),
          items: allItems
            .filter((item) => item.menuID.equals(cat._id))
            .map(toPublicItem),
        })),
    };
 
    res.json({ user: userFiltered, menu: menuArmado });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Genera y descarga en PDF el menú público de un local, a partir
//          del slug. Arma secciones → categorías → items igual que
//          fetchUserWithMenu (mismos filtros de hidden/available), y le pasa
//          esa estructura al template de utils/menuPdfTemplate para renderizar
//          el HTML que Puppeteer convierte en PDF.
//          Respeta "Ocultar precios" (menuDisplay.hidePrices) igual que la
//          carta: con la opción activa el PDF sale sin ningún precio.
// @route   GET /api/users/:slug/menu/pdf
// @access  Public
// ──────────────────────────────────────────────
const downloadMenuPdf = async (req, res) => {
  let page;
  try {
    const { slug } = req.params;
    const slugNormalizado = generateSlug(slug);

    const user = await User.findOne({ slug: slugNormalizado, active: true });
    if (!user) return res.status(404).json({ message: "Local no encontrado" });
    const plan = await getPlanForUser(user);
    if (!plan.features.menu_pdf) {
      return res.status(403).json({ message: "Tu plan no incluye exportar el menú a PDF." });
    }

    // En el orden de la carta (ver utils/menuOrder.js).
    const menus = sortByMenuOrder(await Menu.find({ userID: user._id, hidden: false }));
    const menuIDs = menus.map((m) => m._id);

    // Solo lo que realmente se ve en la carta: no ocultos, disponibles y
    // sin contar extras/adicionales (igual criterio que la ruta del menú PDF
    // que armamos antes, pensado para que el PDF no incluya salsas/bebidas
    // sueltas como si fueran platos del listado principal).
    const allItems = sortByMenuOrder((await Item.find({
      menuID: { $in: menuIDs },
      hidden: false,
      available: true,
      isExtra: false,
    }).select("-__v")).filter((item) =>
      getPublicItemForPlan(item, plan.features).available
    ));

    const secciones  = menus.filter((m) => m.section === true);
    const categorias = menus.filter((m) => m.section === false);

    // Con "Ocultar precios" los items salen sin precios, igual que en la
    // carta (fetchUserWithMenu), y el template tampoco dibuja el lugar del
    // precio ni el valor de las variantes.
    const menuDisplay = getMenuDisplay(user);
    const toPublicItem = (item) => getPublicMenuItem(item, plan.features, menuDisplay);

    // flattenMaps: true (en getPublicItemForPlan) convierte item.options
    // (Mongoose Map) a un objeto plano — sin esto, Object.entries() en el
    // template no itera bien las variantes/adicionales del item.
    const menuArmado = {
      secciones: secciones.map((sec) => ({
        ...sec.toObject(),
        categorias: categorias
          .filter((cat) => cat.sectionID && cat.sectionID.equals(sec._id))
          .map((cat) => ({
            ...cat.toObject(),
            items: allItems
              .filter((item) => item.menuID.equals(cat._id))
              .map(toPublicItem),
          })),
      })),
      sinSeccion: categorias
        .filter((cat) => !cat.sectionID)
        .map((cat) => ({
          ...cat.toObject(),
          items: allItems
            .filter((item) => item.menuID.equals(cat._id))
            .map(toPublicItem),
        })),
    };

    const businessName = user.contactInfo?.businessName || "Nuestro Menú";
    const html = buildMenuHTML({
      businessName,
      menuArmado,
      contactInfo: user.contactInfo,
      hidePrices: menuDisplay.hidePrices,
    });

    const browser = await getBrowser();
    page = await browser.newPage();

    // Timeout acotado: si una imagen remota (Cloudinary) se cuelga o tarda
    // demasiado, esto corta a los 15s en vez de dejar la request colgada
    // hasta que la tumbe el proxy/plataforma (lo que suele volver como una
    // respuesta de texto plano de timeout, no como un error nuestro).
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });

    const pdfBuffer = Buffer.from(await page.pdf({
  format: "A4",
  printBackground: true,
  margin: { top: "0mm", bottom: "14mm", left: "0mm", right: "0mm" },
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate: buildFooterTemplate({ businessName }),
}));

res.set({
  "Content-Type": "application/pdf",
  "Content-Disposition": `attachment; filename="${slugNormalizado}-menu.pdf"`,
  "Content-Length": pdfBuffer.length,
});
res.send(pdfBuffer);
  } catch (error) {
    handleError(res, error);
  } finally {
    // Cerramos solo la página, NO el browser — el browser se reutiliza
    // entre requests (ver utils/pdfBrowser.js).
    if (page) await page.close();
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
    // En el mismo orden que la carta (ver utils/menuOrder.js): el editor lo
    // muestra tal cual y es lo que el dueño reordena arrastrando.
    const menus = sortByMenuOrder(await Menu.find({ userID: req.user._id }));
    const menuIDs = menus.map((m) => m._id);

    const allItems = sortByMenuOrder(await Item.find({ menuID: { $in: menuIDs } }));

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

    // El front usa esto para mostrar "X/límite productos", deshabilitar
    // "Agregar producto" al llegar al tope, y mostrar el candado en
    // "Importar desde Excel" — la fuente de verdad real sigue siendo
    // el check en newItem y el middleware requireFeature en massiveRoutes,
    // esto es solo para la UI.
    const { features } = await getRequestPlan(req);
    const itemLimit = features.item_limit;
    const limits = {
      itemCount: allItems.length,
      itemLimit,
      canEditMenu: features.menu_editor,
      canImportExcel: features.carga_masiva_excel,
      canExportPdf: features.menu_pdf,
      canScheduleItems: features.programacion_productos,
      canScheduleOffers: features.programacion_productos,
      canUseImageManager: features.image_manager,
      canUseTemplates: features.menu_templates,
      // Ordenar arrastrando (PATCH /items/reorder y /menus/reorder) pide lo
      // mismo que editar. La clave además avisa que este backend sabe
      // ordenar: un front nuevo contra un backend anterior no la recibe y no
      // muestra las manijas, así que el orden de despliegue da igual.
      canReorder: features.menu_editor,
      // Configuración del panel (ver newItem/newMenu y las rutas /me/settings).
      autoGenerateCodes: req.user.panelSettings?.autoGenerateCodes === true,
      disableMenuDelete: req.user.panelSettings?.disableMenuDelete === true,
      deleteMenusWithContent: req.user.panelSettings?.deleteMenusWithContent === true,
      // Este backend acepta acciones en lote sobre secciones y categorías
      // (/menus/bulk/*): sin la clave el front solo selecciona productos.
      canBulkMenus: true,
    };

    res.json({ menu: menuArmado, limits });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Estadísticas de visitas a la carta pública del usuario
//          autenticado: total y serie diaria de los últimos 30 días.
//          El gating de estadísticas lo hace el middleware requireFeature
//          en la ruta, no este controller.
// @route   GET /api/users/me/stats
// @access  Private (pro+)
// ──────────────────────────────────────────────
const fetchStats = async (req, res) => {
  try {
    const requestedDays = req.query?.days;
    if (requestedDays !== undefined && requestedDays !== "7" && requestedDays !== "30") {
      return res.status(400).json({ message: "El período debe ser de 7 o 30 días." });
    }
    if (requestedDays !== undefined) {
      const { dates, previousDates, ...period } = buildStatsPeriod(Number(requestedDays), req.user.createdAt);
      const rows = await PageView.find({
        userID: req.user._id,
        date: { $gte: period.previousStart, $lte: period.todayDate },
      });
      const byDate = new Map(rows.map(row => [row.date, row.count]));
      const days = dates.map(date => ({ date, count: byDate.get(date) || 0 }));
      const previousDays = previousDates.map(date => ({ date, count: byDate.get(date) || 0 }));
      return res.json({
        ...period, days, previousDays,
        totalViews: days.reduce((sum, day) => sum + day.count, 0),
        previousTotalViews: previousDays.reduce((sum, day) => sum + day.count, 0),
        todayViews: byDate.get(period.todayDate) || 0,
      });
    }
    // Compatibilidad para clientes anteriores que no envían days.

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Ventana de 30 días incluyendo hoy, con las fechas calculadas en horario
    // de Buenos Aires (mismo criterio que trackView). Buenos Aires no tiene
    // horario de verano, así que restar días en milisegundos y formatear en
    // esa zona da siempre la fecha local correcta.
    const sinceStr = buenosAiresDateStr(new Date(now - 29 * MS_PER_DAY));

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
      const key = buenosAiresDateStr(new Date(now - i * MS_PER_DAY));
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
// @desc    Registra que se tocó un producto puntual de la carta pública
//          (analítica de "platos más vistos"). Resuelve el dueño desde el
//          slug de la URL en vez de confiar en un userID que mande el
//          cliente, y valida que el item sea realmente de ese local antes
//          de contarlo — así datos de otro local no se cuelan en las
//          estadísticas por un itemID cualquiera.
// @route   POST /api/users/:slug/menu/items/:itemID/view
// @access  Public
// ──────────────────────────────────────────────
const trackItemViewEndpoint = async (req, res) => {
  try {
    const { slug, itemID } = req.params;
    if (!mongoose.Types.ObjectId.isValid(itemID)) return res.sendStatus(204);

    const slugNormalizado = generateSlug(slug);
    const user = await User.findOne({ slug: slugNormalizado, active: true }).select("_id");
    if (!user) return res.sendStatus(204);

    const item = await Item.findById(itemID).select("menuID");
    if (!item) return res.sendStatus(204);

    const menu = await Menu.findOne({ _id: item.menuID, userID: user._id }).select("_id");
    if (!menu) return res.sendStatus(204);

    trackItemView(user._id, itemID);
    res.sendStatus(204);
  } catch {
    res.sendStatus(204);
  }
};

// ──────────────────────────────────────────────
// @desc    Top de productos más vistos en los últimos 30 días. Mismo gate
//          de plan que fetchStats. Agrega ItemView por itemID y después
//          busca el título/imagen actual en Item — un producto borrado
//          desde entonces se muestra igual, con un texto genérico en vez
//          de romper la lista.
// @route   GET /api/users/me/item-stats
// @access  Private (pro+)
// ──────────────────────────────────────────────
const fetchItemStats = async (req, res) => {
  try {
    const requestedDays = req.query?.days;
    if (requestedDays !== undefined && requestedDays !== "7" && requestedDays !== "30") {
      return res.status(400).json({ message: "El período debe ser de 7 o 30 días." });
    }
    if (requestedDays !== undefined) {
      const periodData = buildStatsPeriod(Number(requestedDays), req.user.createdAt);
      const { dates: _dates, previousDates: _previousDates, ...period } = periodData;
      const rows = await ItemView.aggregate([
        { $match: { userID: req.user._id, date: { $gte: period.previousStart, $lte: period.periodEnd } } },
        { $group: {
          _id: "$itemID",
          totalViews: { $sum: { $cond: [{ $gte: ["$date", period.periodStart] }, "$count", 0] } },
          previousViews: { $sum: { $cond: [{ $lt: ["$date", period.periodStart] }, "$count", 0] } },
        } },
        { $match: { totalViews: { $gt: 0 } } },
        { $sort: { totalViews: -1, _id: 1 } },
        { $limit: 10 },
      ]);
      const items = await Item.find({ _id: { $in: rows.map(row => row._id) } }).select("title image");
      const byId = new Map(items.map(item => [item._id.toString(), item]));
      return res.json({
        ...period,
        topItems: rows.map(row => ({
          itemID: row._id,
          title: byId.get(row._id.toString())?.title || "(producto eliminado)",
          image: byId.get(row._id.toString())?.image || "",
          totalViews: row.totalViews,
          previousViews: row.previousViews,
        })),
      });
    }
    // Compatibilidad para clientes anteriores que no envían days.

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const sinceStr = buenosAiresDateStr(new Date(now - 29 * MS_PER_DAY));

    const rows = await ItemView.aggregate([
      { $match: { userID: req.user._id, date: { $gte: sinceStr } } },
      { $group: { _id: "$itemID", totalViews: { $sum: "$count" } } },
      { $sort: { totalViews: -1 } },
      { $limit: 10 },
    ]);

    const items = await Item.find({ _id: { $in: rows.map((r) => r._id) } }).select("title image");
    const byId = {};
    items.forEach((it) => { byId[it._id.toString()] = it; });

    const topItems = rows.map((r) => {
      const item = byId[r._id.toString()];
      return {
        itemID: r._id,
        title: item?.title || "(producto eliminado)",
        image: item?.image || "",
        totalViews: r.totalViews,
      };
    });

    res.json({ topItems, windowDays: 30 });
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
    const plan = await getPlanForUser(user);
    const effectivePlan = plan.name;

    if (!plan.features.landing_page) {
      return res.status(403).json({ code: "LANDING_NOT_INCLUDED", message: "La página del local no está incluida en este plan. Consultá la carta." });
    }

    // Lo oculto no se envía (ver hideContactInfo). landingVisibility igual
    // viaja: el número puede venir solo para el botón de reservas, con la
    // fila de teléfono oculta, y eso el front no lo puede deducir del dato.
    const landingVisibility = getLandingVisibility(user);
    const userFiltered = {
      _id: user._id,
      contactInfo: hideContactInfo(getContactInfo(user.contactInfo), landingVisibility),
      media: user.media,
      hasDelivery: user.hasDelivery,
      template: getTemplateForFeatures(user.template, plan.features),
      schedule: landingVisibility.schedule ? user.schedule : undefined,
      menuStyle: getMenuStyleForFeatures(user.menuStyle, plan.features),
      subscription: effectivePlan,
      features: plan.features,
      landingVisibility,
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
    // PATCH /api/users/template (useTemplate), que valida el nivel requerido.
    // Si "template" estuviera acá, cualquiera
    // podría mandarlo por este endpoint y saltarse esa validación.
    const allowedFields = ["contactInfo", "hasDelivery", "media", "schedule"];

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    // Conservar los datos de contacto vigentes que no llegan en una edición
    // parcial, sin volver a aceptar campos retirados enviados por clientes viejos.
    if (updates.contactInfo) {
      const incomingContactInfo = getContactInfo(updates.contactInfo);
      updates.contactInfo = {
        ...getContactInfo(req.user.contactInfo),
        ...incomingContactInfo,
      };

      // Mismo chequeo que en el alta (newUser): el email de contacto no es
      // solo un dato de perfil, baja/arrepentimiento dependen de poder
      // mandarle un código ahí. Se valida el resultado ya fusionado, así
      // una edición parcial que no toca "mail" no se ve afectada, pero
      // tampoco se puede dejar vacío/inválido a propósito.
      if (!isValidEmail(updates.contactInfo.mail)) {
        return res.status(400).json({ message: "Ingresá un email de contacto válido" });
      }

      // Cambiar el mail real de la cuenta no pasa por acá: sin probar que se
      // controla la casilla nueva, cualquiera podría apuntar la cuenta a un
      // mail ajeno. Ver requestEmailChange/confirmEmailChange — este endpoint
      // solo deja tocar el resto de contactInfo (o dejar "mail" como está).
      if (updates.contactInfo.mail !== req.user.contactInfo?.mail) {
        return res.status(400).json({
          message: "Para cambiar tu email de contacto usá la opción de cambiar email y confirmá el código que te mandamos a la casilla nueva.",
        });
      }

      // El texto extra del pedido por WhatsApp termina dentro de un link
      // wa.me que arma la carta: se exige string y se acota el largo para
      // que un texto enorme no rompa ese link. Solo se valida si llegó en
      // esta edición; si no, queda el que ya estaba guardado.
      if (Object.prototype.hasOwnProperty.call(incomingContactInfo, "orderMessage")) {
        if (typeof incomingContactInfo.orderMessage !== "string") {
          return res.status(400).json({ message: "El mensaje de pedido no es válido." });
        }
        const orderMessage = incomingContactInfo.orderMessage.trim();
        if (orderMessage.length > ORDER_MESSAGE_MAX_LENGTH) {
          return res.status(400).json({
            message: `El mensaje de pedido no puede superar los ${ORDER_MESSAGE_MAX_LENGTH} caracteres.`,
          });
        }
        updates.contactInfo.orderMessage = orderMessage;
      }

      // Teléfono y WhatsApps se guardan como código de área + número (ver
      // utils/phone.js), aunque el dueño los tipee con 54, 0 o 15.
      if (Object.prototype.hasOwnProperty.call(incomingContactInfo, "number")) {
        const number = incomingContactInfo.number;
        if (number !== null && number !== "" && !isValidPhone(number)) {
          return res.status(400).json({ message: "El teléfono no es válido." });
        }
        updates.contactInfo.number = toStoredPhone(number);
      }
      if (Object.prototype.hasOwnProperty.call(incomingContactInfo, "whatsappNumbers")) {
        const parsed = parseWhatsappNumbers(incomingContactInfo.whatsappNumbers);
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        updates.contactInfo.whatsappNumbers = parsed.value;
      }
    }

    // Validación liviana del horario para que la carta pública no reciba datos que rompan
    // el cálculo de "abierto ahora" (ver ScheduleSection en UserHome.tsx).
    // El front (UserEditor.tsx) ya valida esto mismo antes de mandar, esto
    // es la segunda barrera del lado del servidor.
    const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    if (updates.schedule !== undefined) {
      const sched = updates.schedule;
      const isValid =
        sched && typeof sched === "object" &&
        DAY_KEYS.every((day) => {
          const d = sched[day];
          if (!d || typeof d !== "object") return false;
          if (typeof d.enabled !== "boolean") return false;
          if (!d.enabled) return true; // open/close no importan si está cerrado
          // Cierre <= apertura termina al día siguiente; iguales son 24 horas.
          return typeof d.open === "string" && typeof d.close === "string" &&
            HHMM_RE.test(d.open) && HHMM_RE.test(d.close);
        });
      if (!isValid) {
        return res.status(400).json({ message: "El horario cargado no es válido." });
      }
    }

    // Si hay nombre de negocio, la actualización también reintenta ante una
    // colisión simultánea. Si el nombre no genera un slug válido, conserva el
    // actual. Las ediciones que no incluyen contactInfo evitan ese trabajo.
    const user = updates.contactInfo?.businessName
      ? await updateUserWithUniqueSlug(req.user._id, updates)
      : await User.findByIdAndUpdate(
          req.user._id,
          { $set: updates },
          { new: true, runValidators: true }
        );

    // Devuelve el documento entero, con template y menuStyle crudos. No se
    // recortan a propósito: este endpoint no toca la apariencia (template
    // queda fuera de allowedFields) y el panel ignora esos campos de la
    // respuesta, así que recortarlos solo serviría para acoplar el guardado de
    // "Información" al catálogo de planes y hacerlo fallar cuando el catálogo
    // no responde. La apariencia vigente se lee de GET /me.
    res.json(user);
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Iniciar el cambio del mail de contacto. No lo guarda todavía —
//          manda un código al mail NUEVO para probar que el dueño lo
//          controla; recién se escribe en confirmEmailChange. La cuenta
//          sigue verificada durante todo el proceso: emailVerified nunca se
//          toca acá, porque en ningún momento queda un mail sin confirmar
//          guardado como el de la cuenta.
// @route   POST /api/users/me/email-change
// @access  Private
// ──────────────────────────────────────────────
const requestEmailChange = async (req, res) => {
  try {
    const { mail } = req.body;
    if (!isValidEmail(mail)) {
      return res.status(400).json({ message: "Ingresá un email válido." });
    }

    const cleanMail = String(mail).trim().toLowerCase();
    if (cleanMail === req.user.contactInfo?.mail) {
      return res.status(400).json({ message: "Ese ya es el email de tu cuenta." });
    }

    const takenByAnotherAccount = await User.findOne({
      "contactInfo.mail": cleanMail,
      _id: { $ne: req.user._id },
    }).select("_id");
    if (takenByAnotherAccount) {
      return res.status(409).json({ message: "Ese email ya está en uso por otra cuenta." });
    }

    try {
      await createPendingServiceAction({
        action: "cambio_email",
        userID: req.user._id,
        email: cleanMail,
      });
    } catch (error) {
      if (error.isMailError) {
        console.error("No se pudo enviar el email de confirmación de cambio de mail:", error.cause);
        return res.status(503).json({
          message: "No pudimos enviar el email. Intentá de nuevo o escribinos a menudigitalappsoporte@gmail.com.",
        });
      }
      throw error;
    }

    res.json({ ok: true, maskedEmail: maskEmail(cleanMail) });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Confirmar el cambio de mail pendiente con el código mandado a la
//          casilla nueva (ver requestEmailChange). Recién acá se escribe
//          contactInfo.mail — antes de esto la cuenta sigue con el mail
//          viejo, así que un código vencido o nunca confirmado no deja
//          ningún mail sin verificar guardado.
// @route   POST /api/users/me/email-change/confirm
// @access  Private
// ──────────────────────────────────────────────
const confirmEmailChange = async (req, res) => {
  try {
    const { code } = req.body;
    if (typeof code !== "string" || !code.trim()) {
      return res.status(400).json({ message: "Ingresá el código que te enviamos por email." });
    }

    const { pending, error } = await claimPendingServiceAction({
      userID: req.user._id,
      code: code.trim(),
      action: "cambio_email",
    });
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { "contactInfo.mail": pending.email } },
      { new: true }
    );

    res.json({ contactInfo: getContactInfo(user.contactInfo) });
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

// ──────────────────────────────────────────────
// @desc    Subir el logo que la landing y la carta usan como favicon.
//          El tamaño (1MB) y el tipo los valida multer en la ruta.
// @route   POST /api/users/upload-favicon
// @access  Private
// ──────────────────────────────────────────────
const uploadFavicon = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No se recibió ningún archivo" });
    }

    const imageUrl = req.file.path;
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { "media.favicon": imageUrl },
      { new: true }
    );

    res.json({ imageUrl, media: user.media });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Quitar el logo del favicon: la landing y la carta vuelven al
//          favicon de Menú Digital. Mismo criterio que deleteBackground:
//          solo quita la referencia, no borra el archivo en Cloudinary.
// @route   DELETE /api/users/favicon
// @access  Private
// ──────────────────────────────────────────────
const deleteFavicon = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { "media.favicon": "" },
      { new: true }
    );

    res.json({ media: user.media });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Cambiar el template visual del local
// @route   PATCH /api/users/template
// @access  Private
// ──────────────────────────────────────────────
const useTemplate = async (req, res) => {
  try {
    const { template, menuStyle } = req.body;

    if (menuStyle !== undefined && !MENU_STYLES.includes(menuStyle)) {
      return res.status(400).json({ message: "Diseño de carta inválido" });
    }

    if (typeof template !== "number") {
      return res.status(400).json({ message: "Template debe ser un número" });
    }

    // La lista técnica valida el ID; MongoDB decide si el usuario puede usarlo.
    if (!TEMPLATE_IDS.includes(template)) {
      return res.status(400).json({ message: "Template inválido" });
    }
    const { features } = await getRequestPlan(req);
    if (!features.templateIds.includes(template)) {
      return res.status(403).json({ message: "Tu plan no incluye ese template." });
    }

    // Las familias visuales son una feature de plan aparte de las paletas, y
    // los diseños premium tienen la suya (premium_menu_styles).
    // Clásico y Bistró no pasan por acá: quedan abiertos a todos los planes.
    // La guarda exige menuStyle definido; si no, cambiar solo de paleta daría
    // un 403 espurio a quien ya tiene una familia guardada de un plan vencido.
    const styleFeature = menuStyle !== undefined ? getMenuStyleFeature(menuStyle) : null;
    if (styleFeature && features[styleFeature] !== true) {
      return res.status(403).json({
        code: "FEATURE_NOT_INCLUDED",
        feature: styleFeature,
        message: styleFeature === "premium_menu_styles"
          ? "Tu plan no incluye los diseños premium."
          : "Tu plan no incluye las familias visuales.",
      });
    }

    const previousTemplate = req.user.template;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { template, ...(menuStyle !== undefined ? { menuStyle } : {}) },
      { new: true, runValidators: true }
    );

    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    if (previousTemplate !== template) {
      await logCrmEvent(req.user._id, `Cambió de template #${previousTemplate} → #${template}`);
    }

    if (menuStyle !== undefined && getMenuStyle(req.user.menuStyle) !== menuStyle) {
      await logCrmEvent(req.user._id, `Cambió el diseño de carta a ${MENU_STYLE_LABELS[menuStyle]}`);
    }

    // El template va crudo: la guarda de arriba ya probó que está permitido.
    // El estilo se recorta igual porque el body puede no traerlo (cambio de
    // paleta a secas) y el guardado en Mongo puede ser una familia de un plan
    // ya vencido; sin recortar, el panel se contradiría con GET /me.
    res.json({
      template: user.template,
      menuStyle: getMenuStyleForFeatures(user.menuStyle, features),
    });
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
// Panel de "Configuración" del dashboard (tarjeta "Agregar opción en el
// dashboard de user para configuraciones"). La contraseña acá es un gate de
// ENTRADA a la pantalla, independiente del password de login — protege que
// un empleado con el login compartido del local no toque estos ajustes a la
// ligera. Una vez adentro (verify-password devolvió ok), cambiar los
// toggles no vuelve a pedirla.
// ──────────────────────────────────────────────

// Valor vigente de los toggles, con la misma forma en todas las respuestas
// de /me/settings.
const getPanelSettingsValues = (user) => ({
  autoGenerateCodes: user?.panelSettings?.autoGenerateCodes === true,
  disableMenuDelete: user?.panelSettings?.disableMenuDelete === true,
  deleteMenusWithContent: user?.panelSettings?.deleteMenusWithContent === true,
  landingVisibility: getLandingVisibility(user),
  menuDisplay: getMenuDisplay(user),
});

// ──────────────────────────────────────────────
// @desc    Estado del panel de Configuración: si ya existe una contraseña
//          seteada (para que el front sepa si mostrar "crear" o "ingresar")
//          y el valor vigente de los toggles.
// @route   GET /api/users/me/settings
// @access  Private
// ──────────────────────────────────────────────
const getPanelSettingsStatus = async (req, res) => {
  try {
    const withPassword = await User.findById(req.user._id).select("+panelSettings.password");
    res.json({
      hasPassword: !!withPassword?.panelSettings?.password,
      ...getPanelSettingsValues(req.user),
    });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Ingresar al panel de Configuración. Si todavía no existe una
//          contraseña del panel, esta llamada la establece (alta); si ya
//          existe, la verifica.
// @route   POST /api/users/me/settings/verify-password
// @access  Private
// ──────────────────────────────────────────────
const verifyPanelSettingsPassword = async (req, res) => {
  try {
    const { password } = req.body;
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Ingresá la contraseña." });
    }

    const user = await User.findById(req.user._id).select("+panelSettings.password");
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    if (!user.panelSettings?.password) {
      if (isWeakPassword(password)) {
        return res.status(400).json({
          message: "La contraseña debe tener al menos 8 caracteres y no puede ser una demasiado común.",
        });
      }
      user.panelSettings.password = password; // el hook pre-save la hashea
      await user.save();
      return res.json({
        ok: true,
        created: true,
        ...getPanelSettingsValues(user),
      });
    }

    const matches = await user.matchPanelSettingsPassword(password);
    // 400 y no 401 a propósito: en el resto de la app un 401 de cualquier
    // endpoint dispara un logout global (ver parseApiResponse en
    // MenuEditor.tsx y los fetch de UserEditor.tsx) — acá solo significa que
    // el PIN del panel está mal, la sesión sigue vigente.
    if (!matches) return res.status(400).json({ message: "Contraseña incorrecta." });

    res.json({
      ok: true,
      created: false,
      ...getPanelSettingsValues(user),
    });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Cambiar la contraseña del panel de Configuración (requiere la
//          actual). Distinto del password de login.
// @route   PATCH /api/users/me/settings/password
// @access  Private
// ──────────────────────────────────────────────
const changePanelSettingsPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return res.status(400).json({ message: "Faltan datos." });
    }
    if (isWeakPassword(newPassword)) {
      return res.status(400).json({
        message: "La nueva contraseña debe tener al menos 8 caracteres y no puede ser una demasiado común.",
      });
    }

    const user = await User.findById(req.user._id).select("+panelSettings.password");
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    const matches = await user.matchPanelSettingsPassword(currentPassword);
    // Mismo motivo que en verifyPanelSettingsPassword: 400, no 401.
    if (!matches) return res.status(400).json({ message: "La contraseña actual no es correcta." });

    user.panelSettings.password = newPassword;
    await user.save();

    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Guardar los toggles del panel de Configuración. No vuelve a pedir
//          la contraseña del panel (ver nota arriba) — la sesión ya
//          verificó al entrar a la pantalla.
// @route   PATCH /api/users/me/settings
// @access  Private
// ──────────────────────────────────────────────
const updatePanelSettings = async (req, res) => {
  try {
    const { autoGenerateCodes, disableMenuDelete, deleteMenusWithContent } = req.body;
    const updates = {};
    if (typeof autoGenerateCodes === "boolean") updates["panelSettings.autoGenerateCodes"] = autoGenerateCodes;
    if (typeof disableMenuDelete === "boolean") updates["panelSettings.disableMenuDelete"] = disableMenuDelete;
    if (typeof deleteMenusWithContent === "boolean") {
      updates["panelSettings.deleteMenusWithContent"] = deleteMenusWithContent;
    }
    // Edición parcial (el panel manda solo el toggle que cambió): se toman
    // únicamente las claves conocidas con valor booleano. landingVisibility y
    // menuDisplay siguen el mismo criterio.
    [
      ["landingVisibility", LANDING_VISIBILITY_KEYS],
      ["menuDisplay", MENU_DISPLAY_KEYS],
    ].forEach(([group, keys]) => {
      const values = req.body[group];
      if (!values || typeof values !== "object") return;
      keys.forEach((key) => {
        if (typeof values[key] === "boolean") {
          updates[`panelSettings.${group}.${key}`] = values[key];
        }
      });
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "Nada para actualizar." });
    }

    const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true });
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });
    res.json(getPanelSettingsValues(user));
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
  registerTrial,
  loginUser,
  verifyEmail,
  resendVerificationCode,
  getAuthUser,
  getAuthUserSummary,
  fetchUserWithMenu,
  downloadMenuPdf,
  fetchOwnMenu,
  fetchStats,
  trackItemViewEndpoint,
  fetchItemStats,
  fetchUser,
  editUser,
  requestEmailChange,
  confirmEmailChange,
  uploadImage,
  uploadBackground,
  uploadFavicon,
  removeImage,
  deleteBackground,
  deleteFavicon,
  useTemplate,
  setActive,
  getPanelSettingsStatus,
  verifyPanelSettingsPassword,
  changePanelSettingsPassword,
  updatePanelSettings,
};
