const User = require("../models/User");
const { notifyAdmins } = require("./adminPushService");

// ──────────────────────────────────────────────
// Avisos a los admins por vencimientos de planes: plan pago por vencer, plan
// pago vencido y prueba Pro terminada sin pago.
//
// El vencimiento de un plan no dispara nada en la base (se calcula al vuelo
// en cada request, ver getSubscriptionState), así que hace falta revisarlo
// cada tanto. Corre dentro del mismo proceso de la API: no hay otro servicio
// de tareas programadas.
//
// Cada aviso lleva un dedupeKey con la cuenta y su fecha de vencimiento, así
// que es seguro que corra de más (reinicios, varias instancias, la revisión
// de cada hora): cada hecho avisa una sola vez. Si la cuenta renueva, la
// fecha cambia y el próximo vencimiento vuelve a avisar.
// ──────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Con cuánta anticipación se avisa que un plan pago está por vencer.
const EXPIRING_WINDOW_MS = 3 * DAY_MS;
// Hasta cuánto después del vencimiento se sigue avisando. Cubre el tiempo
// que la API pueda pasar apagada sin que se pierda el aviso.
const EXPIRED_LOOKBACK_MS = 3 * DAY_MS;

const CHECK_INTERVAL_MS = HOUR_MS;
// La primera revisión espera a que la API termine de levantar.
const FIRST_CHECK_DELAY_MS = 60 * 1000;
// Tope por corrida, por si un cambio de datos deja cientos de cuentas en la
// ventana: el resto sale en la próxima.
const MAX_NOTICES_PER_RUN = 40;

const PLAN_LABELS = { basic: "Básico", pro: "Pro" };

const formatDay = (date) => date.toLocaleDateString("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires",
  day: "numeric",
  month: "long",
});

/**
 * Arma los avisos que corresponden a las cuentas recibidas. Función pura
 * (no toca la base) para poder testearla.
 */
const buildSubscriptionNotices = (users, now = new Date()) => {
  const notices = [];

  for (const user of users) {
    if (!PLAN_LABELS[user.subscription] || !user.subscriptionExpiresAt) continue;

    const expiresAt = new Date(user.subscriptionExpiresAt);
    const remaining = expiresAt.getTime() - now.getTime();
    if (Number.isNaN(remaining)) continue;
    if (remaining > EXPIRING_WINDOW_MS || remaining < -EXPIRED_LOOKBACK_MS) continue;

    const plan = PLAN_LABELS[user.subscription];
    const stamp = `${user._id}:${expiresAt.toISOString()}`;
    const expired = remaining <= 0;

    if (user.trialActive) {
      // De la prueba gratuita solo interesa el final: mientras dura no hay
      // nada para hacer.
      if (!expired) continue;
      notices.push({
        title: "🧪 Prueba Pro terminada sin pago",
        body: `${user.username} terminó su prueba el ${formatDay(expiresAt)} y no contrató un plan.`,
        url: "/admin",
        type: "subscription",
        dedupeKey: `trial-ended:${stamp}`,
      });
      continue;
    }

    notices.push(expired
      ? {
        title: `📉 Plan ${plan} vencido`,
        body: `El plan de ${user.username} venció el ${formatDay(expiresAt)} sin renovarse.`,
        url: "/admin",
        type: "subscription",
        dedupeKey: `expired:${stamp}`,
      }
      : {
        title: `⏳ Plan ${plan} por vencer`,
        body: `El plan de ${user.username} vence el ${formatDay(expiresAt)}.`,
        url: "/admin",
        type: "subscription",
        dedupeKey: `expiring:${stamp}`,
      });
  }

  return notices;
};

let running = false;

/** Revisa los vencimientos una vez. Nunca lanza. Devuelve cuántos avisó. */
const checkSubscriptionNotices = async (now = new Date()) => {
  if (running) return 0;
  running = true;
  let sent = 0;

  try {
    const users = await User.find({
      admin: { $ne: true },
      subscription: { $in: Object.keys(PLAN_LABELS) },
      subscriptionExpiresAt: {
        $gte: new Date(now.getTime() - EXPIRED_LOOKBACK_MS),
        $lte: new Date(now.getTime() + EXPIRING_WINDOW_MS),
      },
    })
      .select("username subscription subscriptionExpiresAt trialActive")
      .sort({ subscriptionExpiresAt: 1 })
      .lean();

    for (const notice of buildSubscriptionNotices(users, now)) {
      if (sent >= MAX_NOTICES_PER_RUN) break;
      const summary = await notifyAdmins(notice);
      if (!summary.duplicate && !summary.error) sent += 1;
    }
  } catch (error) {
    console.error("No se pudieron revisar los vencimientos de planes:", error);
  } finally {
    running = false;
  }

  return sent;
};

/**
 * Programa la revisión periódica. Se apaga con
 * ADMIN_SUBSCRIPTION_NOTICES=off. Los timers no retienen el proceso.
 */
const startSubscriptionNotices = () => {
  if (String(process.env.ADMIN_SUBSCRIPTION_NOTICES || "").toLowerCase() === "off") {
    console.log("ℹ️  Avisos de vencimientos a admins desactivados (ADMIN_SUBSCRIPTION_NOTICES=off).");
    return;
  }

  setTimeout(() => { void checkSubscriptionNotices(); }, FIRST_CHECK_DELAY_MS).unref();
  setInterval(() => { void checkSubscriptionNotices(); }, CHECK_INTERVAL_MS).unref();
};

module.exports = {
  buildSubscriptionNotices,
  checkSubscriptionNotices,
  startSubscriptionNotices,
};
