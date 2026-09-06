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
const { buenosAiresDateStr } = require("../utils/dates");
const { logCrmEvent } = require("../utils/crmEvents");
const { buildMenuHTML } = require("../utils/menuPdfTemplate");
const { getBrowser } = require("../utils/pdfBrowser");
const {
  createUserWithUniqueSlug,
  generateSlug,
  updateUserWithUniqueSlug,
} = require("../utils/slug");
const { isScheduleAvailableAt } = require("../utils/itemAvailability");
const { isOfferActive } = require("../utils/offers");
const { isValidEmail, isWeakPassword } = require("../utils/validators");
const { escapeRegex } = require("../utils/regex");
const {
  maskEmail,
  createPendingServiceAction,
  claimPendingServiceAction,
} = require("../utils/serviceActionCodes");

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
  const fields = ["mail", "number", "location", "address", "social", "businessName", "reservationMessage"];
  return Object.fromEntries(fields
    .filter(field => Object.prototype.hasOwnProperty.call(source, field))
    .map(field => [field, source[field]]));
};

const getPublicItemForPlan = (item, features) => {
  const filtered = item.toObject({ flattenMaps: true });
  const hasSchedule = filtered.offerRange?.from || filtered.offerRange?.to;
  if (hasSchedule && !features.programacion_productos) {
    filtered.offerPrice = null;
    filtered.offerRange = { from: null, to: null };
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

    // El email de contacto no es solo un dato de perfil: baja y arrepentimiento
    // (Ley 24.240) dependen de poder mandarle un código de confirmación a esta
    // cuenta. Sin este chequeo, una cuenta con contactInfo.mail vacío o
    // inválido (ej. "ididid") queda sin forma de ejercer esos derechos.
    if (!isValidEmail(contactInfo?.mail)) {
      return res.status(400).json({ message: "Ingresá un email de contacto válido" });
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
      contactInfo,
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
    const user = await User.findById(req.user._id);
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
    const plan = await getPlanForUser(user);
    const effectivePlan = plan.name;

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
      contactInfo: getContactInfo(user.contactInfo),
      media: user.media,
      hasDelivery: user.hasDelivery,
      template: getTemplateForFeatures(user.template, plan.features),
      schedule: user.schedule,
      subscription: effectivePlan,
      features: plan.features,
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
              .map((item) => getPublicItemForPlan(item, plan.features)),
          })),
      })),
      sinSeccion: categorias
        .filter((cat) => !cat.sectionID)
        .map((cat) => ({
          ...cat.toObject(),
          items: allItems
            .filter((item) => item.menuID.equals(cat._id))
            .map((item) => getPublicItemForPlan(item, plan.features)),
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

    const menus = await Menu.find({ userID: user._id, hidden: false });
    const menuIDs = menus.map((m) => m._id);

    // Solo lo que realmente se ve en la carta: no ocultos, disponibles y
    // sin contar extras/adicionales (igual criterio que la ruta del menú PDF
    // que armamos antes, pensado para que el PDF no incluya salsas/bebidas
    // sueltas como si fueran platos del listado principal).
    const allItems = (await Item.find({
      menuID: { $in: menuIDs },
      hidden: false,
      available: true,
      isExtra: false,
    }).select("-__v")).filter((item) =>
      getPublicItemForPlan(item, plan.features).available
    );

    const secciones  = menus.filter((m) => m.section === true);
    const categorias = menus.filter((m) => m.section === false);

    // flattenMaps: true convierte item.options (Mongoose Map) a un objeto
    // plano — sin esto, Object.entries() en el template no itera bien las
    // variantes/adicionales del item.
    const menuArmado = {
      secciones: secciones.map((sec) => ({
        ...sec.toObject(),
        categorias: categorias
          .filter((cat) => cat.sectionID && cat.sectionID.equals(sec._id))
          .map((cat) => ({
            ...cat.toObject(),
            items: allItems
              .filter((item) => item.menuID.equals(cat._id))
              .map((item) => getPublicItemForPlan(item, plan.features)),
          })),
      })),
      sinSeccion: categorias
        .filter((cat) => !cat.sectionID)
        .map((cat) => ({
          ...cat.toObject(),
          items: allItems
            .filter((item) => item.menuID.equals(cat._id))
            .map((item) => getPublicItemForPlan(item, plan.features)),
        })),
    };

    const html = buildMenuHTML({
      businessName: user.contactInfo?.businessName || "Nuestro Menú",
      menuArmado,
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
  margin: { top: "0mm", bottom: "10mm", left: "0mm", right: "0mm" },
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

    const userFiltered = {
      _id: user._id,
      contactInfo: getContactInfo(user.contactInfo),
      media: user.media,
      hasDelivery: user.hasDelivery,
      template: getTemplateForFeatures(user.template, plan.features),
      schedule: user.schedule,
      subscription: effectivePlan,
      features: plan.features,
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
      updates.contactInfo = {
        ...getContactInfo(req.user.contactInfo),
        ...getContactInfo(updates.contactInfo),
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
          return HHMM_RE.test(d.open) && HHMM_RE.test(d.close) && d.open < d.close;
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

    // La lista técnica valida el ID; MongoDB decide si el usuario puede usarlo.
    if (!TEMPLATE_IDS.includes(template)) {
      return res.status(400).json({ message: "Template inválido" });
    }
    const { features } = await getRequestPlan(req);
    if (!features.templateIds.includes(template)) {
      return res.status(403).json({ message: "Tu plan no incluye ese template." });
    }

    const previousTemplate = req.user.template;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { template },
      { new: true }
    );

    if (previousTemplate !== template) {
      await logCrmEvent(req.user._id, `Cambió de template #${previousTemplate} → #${template}`);
    }

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
  verifyEmail,
  resendVerificationCode,
  getAuthUser,
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
  removeImage,
  deleteBackground,
  useTemplate,
  setActive,
};
