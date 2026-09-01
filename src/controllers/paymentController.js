const crypto = require("crypto");
const mongoose = require("mongoose");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const User = require("../models/User");
const PendingRegistration = require("../models/PendingRegistration");
const PaymentCheckout = require("../models/PaymentCheckout");
const PaymentTransaction = require("../models/PaymentTransaction");
const { PLAN_MAP, PLAN_ORDER, getEffectivePlan } = require("../config/plans");
const { getExpectedPaymentLiveMode } = require("../config/environment");
const { logCrmEvent } = require("../utils/crmEvents");
const { addCalendarMonths } = require("../utils/dates");
const { handleError } = require("../utils/handleError");
const { generateAuthToken } = require("../utils/authToken");
const { decryptPendingPassword } = require("../utils/pendingCredentials");
const { createUserWithUniqueSlug } = require("../utils/slug");


const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

const toNullableString = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const toNullableNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
};

const toNullableDate = (value) => {
  if (!value) return null;
  const normalized = new Date(value);
  return Number.isNaN(normalized.getTime()) ? null : normalized;
};

const reconcileRegistrationEntitlement = ({
  currentPlan,
  currentExpiresAt,
  purchasedPlan,
  purchasedExpiresAt,
}) => {
  const normalizedPurchasedExpiry = toNullableDate(purchasedExpiresAt);
  if (!normalizedPurchasedExpiry) {
    throw new Error("La transacción no tiene un vencimiento durable válido");
  }

  const normalizedCurrentExpiry = toNullableDate(currentExpiresAt);
  const effectiveCurrentPlan = getEffectivePlan(
    currentPlan,
    normalizedCurrentExpiry
  );
  const currentPlanRank = PLAN_ORDER.indexOf(effectiveCurrentPlan);
  const purchasedPlanRank = PLAN_ORDER.indexOf(purchasedPlan);
  if (purchasedPlanRank === -1) {
    throw new Error("La transacción no tiene un plan durable válido");
  }

  // Un plan legacy sin vencimiento solo se conserva abierto si ya cubre el
  // nivel comprado. Si compra un nivel superior, ese upgrade sí debe usar el
  // vencimiento del pago; de lo contrario lo convertiríamos en Pro eterno.
  const keepsOpenEndedLegacyPlan = currentPlanRank > 0
    && currentPlanRank >= purchasedPlanRank
    && !normalizedCurrentExpiry;

  return {
    subscription: currentPlanRank > purchasedPlanRank
      ? effectiveCurrentPlan
      : purchasedPlan,
    subscriptionExpiresAt: keepsOpenEndedLegacyPlan
      ? null
      : normalizedCurrentExpiry
          && normalizedCurrentExpiry > normalizedPurchasedExpiry
        ? normalizedCurrentExpiry
        : normalizedPurchasedExpiry,
  };
};

const getPaymentOperation = (paymentData) => {
  if (paymentData.metadata?.type === "registration") return "registration";
  if (paymentData.metadata?.type !== "upgrade") return "unknown";
  return paymentData.metadata?.payment_mode === "renewal" ? "renewal" : "upgrade";
};

const compactTransactionFields = (fields) => Object.fromEntries(
  Object.entries(fields).filter(([, value]) => value !== undefined)
);

const withSession = (options, session) => (
  session ? { ...options, session } : options
);

const preparePaymentEntitlement = ({
  paymentID,
  subscriptionExpiresAtBefore,
  subscriptionExpiresAtAfter,
  planId,
  months,
  userID,
  pendingRegistrationID,
  preferenceId,
  checkoutID,
  session,
}) => PaymentTransaction.findOneAndUpdate(
  {
    paymentID,
    entitlementStatus: { $ne: "applied" },
    subscriptionExpiresAtBefore: { $exists: false },
  },
  {
    $set: {
      entitlementStatus: "pending",
      entitlementReason: null,
      subscriptionExpiresAtBefore: subscriptionExpiresAtBefore ?? null,
      subscriptionExpiresAtAfter,
      appliedPlanId: planId,
      appliedMonths: months,
      ...compactTransactionFields({
        userID,
        pendingRegistrationID,
        preferenceId,
        checkoutID,
      }),
    },
  },
  withSession({ new: true, runValidators: true }, session)
);

const markPaymentApplied = ({
  paymentID,
  userID,
  pendingRegistrationID,
  preferenceId,
  checkoutID,
  session,
}) => PaymentTransaction.findOneAndUpdate(
  { paymentID, entitlementStatus: { $ne: "applied" } },
  {
    $set: compactTransactionFields({
      entitlementStatus: "applied",
      entitlementReason: null,
      entitlementAppliedAt: new Date(),
      userID,
      pendingRegistrationID,
      preferenceId,
      checkoutID,
    }),
  },
  withSession({ new: true, runValidators: true }, session)
);

const markPaymentNotApplied = ({
  paymentID,
  reason,
  userID,
  pendingRegistrationID,
  preferenceId,
  checkoutID,
  session,
}) => PaymentTransaction.findOneAndUpdate(
  {
    paymentID,
    entitlementStatus: { $ne: "applied" },
  },
  {
    $set: compactTransactionFields({
      entitlementStatus: "not_applied",
      entitlementReason: reason,
      userID,
      pendingRegistrationID,
      preferenceId,
      checkoutID,
    }),
  },
  withSession({ new: true, runValidators: true }, session)
);

const amountsMatch = (actual, expected) => (
  Number.isFinite(Number(actual))
  && Number.isFinite(Number(expected))
  && Math.round(Number(actual) * 100) === Math.round(Number(expected) * 100)
);

const validateCheckoutSnapshot = ({
  checkout,
  operation,
  associatedID,
  planId,
  months,
  amount,
  currency,
}) => {
  if (!checkout) return "checkout_not_found";
  if (checkout.operation !== operation) return "checkout_operation_mismatch";

  const checkoutAssociation = operation === "registration"
    ? checkout.pendingRegistrationID
    : checkout.userID;
  if (!checkoutAssociation || String(checkoutAssociation) !== String(associatedID)) {
    return "checkout_association_mismatch";
  }
  if (checkout.planId !== planId) return "checkout_plan_mismatch";
  if (Number(checkout.months) !== Number(months)) return "checkout_months_mismatch";
  if (!amountsMatch(amount, checkout.expectedAmount)) return "checkout_amount_mismatch";
  if (String(currency || "").toUpperCase() !== String(checkout.currency || "").toUpperCase()) {
    return "checkout_currency_mismatch";
  }
  return null;
};

const linkPendingRegistration = (paymentID, pending) => {
  if (!pending?._id) return null;
  return PaymentTransaction.findOneAndUpdate(
    { paymentID },
    {
      $set: compactTransactionFields({
        pendingRegistrationID: pending._id,
        preferenceId: toNullableString(pending.preferenceId) || undefined,
      }),
    },
    { runValidators: true }
  );
};

const applyExistingUserEntitlement = async ({
  paymentID,
  associatedID,
  mappedPlan,
  months,
  approvedAt,
  checkoutID,
}) => mongoose.connection.transaction(async (session) => {
  // Este write serializa entregas concurrentes del mismo paymentID dentro de
  // la transacción. Si otra entrega ya lo aplicó, no vuelve a tocar User.
  const lockedTransaction = await PaymentTransaction.findOneAndUpdate(
    { paymentID, entitlementStatus: { $ne: "applied" } },
    { $set: { entitlementAttemptedAt: new Date() } },
    withSession({ new: true, runValidators: true }, session)
  );
  if (!lockedTransaction) {
    return { appliedNow: false, alreadyApplied: true };
  }

  let userQuery = User.findById(associatedID);
  if (session) userQuery = userQuery.session(session);
  const previousUser = await userQuery.select("subscription subscriptionExpiresAt");
  if (!previousUser) {
    await markPaymentNotApplied({
      paymentID,
      reason: "user_not_found",
      userID: associatedID,
      checkoutID,
      session,
    });
    return { appliedNow: false, reason: "user_not_found" };
  }

  const currentExpiry = toNullableDate(previousUser.subscriptionExpiresAt);
  const effectiveCurrentPlan = getEffectivePlan(
    previousUser.subscription,
    currentExpiry
  );
  const currentRank = PLAN_ORDER.indexOf(effectiveCurrentPlan);
  const targetRank = PLAN_ORDER.indexOf(mappedPlan);

  if (currentRank > 0 && !currentExpiry) {
    await markPaymentNotApplied({
      paymentID,
      reason: "legacy_open_ended_entitlement",
      userID: previousUser._id || associatedID,
      checkoutID,
      session,
    });
    return {
      appliedNow: false,
      reason: "legacy_open_ended_entitlement",
      previousPlan: effectiveCurrentPlan,
    };
  }

  // Un checkout pudo quedar abierto antes de otro upgrade. El cobro se
  // conserva para conciliación, pero jamás baja el nivel ya vigente.
  if (targetRank < currentRank) {
    await markPaymentNotApplied({
      paymentID,
      reason: "stale_checkout_would_downgrade",
      userID: previousUser._id || associatedID,
      checkoutID,
      session,
    });
    return {
      appliedNow: false,
      reason: "stale_checkout_would_downgrade",
      previousPlan: effectiveCurrentPlan,
    };
  }

  const capturedExpiry = toNullableDate(
    lockedTransaction.subscriptionExpiresAtAfter
  );
  const futureCurrentExpiry = currentExpiry && currentExpiry > new Date()
    ? currentExpiry
    : null;
  let subscriptionExpiresAt;
  if (capturedExpiry) {
    // Recuperación de una aplicación inconclusa de una versión anterior.
    // Nunca suma otra vez los meses del mismo paymentID.
    subscriptionExpiresAt = futureCurrentExpiry
      && futureCurrentExpiry > capturedExpiry
      ? futureCurrentExpiry
      : capturedExpiry;
  } else if (targetRank === currentRank) {
    subscriptionExpiresAt = addCalendarMonths(
      futureCurrentExpiry || approvedAt,
      months
    );
  } else {
    const purchasedExpiry = addCalendarMonths(approvedAt, months);
    subscriptionExpiresAt = futureCurrentExpiry
      && futureCurrentExpiry > purchasedExpiry
      ? futureCurrentExpiry
      : purchasedExpiry;
  }

  const preparedEntitlement = await preparePaymentEntitlement({
    paymentID,
    subscriptionExpiresAtBefore: currentExpiry,
    subscriptionExpiresAtAfter: subscriptionExpiresAt,
    planId: mappedPlan,
    months,
    userID: previousUser._id || associatedID,
    checkoutID,
    session,
  });
  const durableExpiry = toNullableDate(
    preparedEntitlement?.subscriptionExpiresAtAfter
      || lockedTransaction.subscriptionExpiresAtAfter
  ) || subscriptionExpiresAt;

  const updatedUser = await User.findByIdAndUpdate(
    associatedID,
    {
      subscription: mappedPlan,
      subscriptionExpiresAt: durableExpiry,
    },
    withSession({ new: true, runValidators: true }, session)
  );
  if (!updatedUser) {
    throw new Error("El usuario desapareció durante la acreditación del pago");
  }

  const appliedTransaction = await markPaymentApplied({
    paymentID,
    userID: previousUser._id || associatedID,
    checkoutID,
    session,
  });
  if (!appliedTransaction) {
    throw new Error("No se pudo finalizar la aplicación durable del pago");
  }

  return {
    appliedNow: true,
    previousPlan: effectiveCurrentPlan,
    isRenewal: targetRank === currentRank,
    subscriptionExpiresAt: durableExpiry,
  };
});

// ──────────────────────────────────────────────
// Verifica que el webhook realmente venga de MercadoPago, no de cualquiera
// que le pegue al endpoint. MP manda un header "x-signature" con
// "ts=<timestamp>,v1=<hash>", donde hash = HMAC-SHA256(manifest, secret) y
// el secret es la "Clave secreta" que configurás en tu panel de MP
// (Tus integraciones → la app → Webhooks, pestaña Modo productivo).
// Algoritmo documentado acá:
// https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks#editor_2
//
// Loguea (a nivel error) por qué falló una validación, sin nunca loguear
// el secret en sí, para poder diagnosticar sin adivinar.
// ──────────────────────────────────────────────
const verifyMpSignature = (req) => {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("Webhook MP: MP_WEBHOOK_SECRET no configurado");
    return false;
  }

  const xSignature = req.headers["x-signature"];
  const xRequestId = req.headers["x-request-id"];
  const dataId = req.query["data.id"] || req.query.id;
  if (!xSignature || !xRequestId || !dataId) {
    console.error("Webhook MP: faltan datos para validar firma", {
      hasSignature: Boolean(xSignature),
      hasRequestId: Boolean(xRequestId),
      dataId,
      query: req.query,
    });
    return false;
  }

  let ts, hash;
  xSignature.split(",").forEach((part) => {
    const [key, value] = part.split("=");
    if (key?.trim() === "ts") ts = value?.trim();
    if (key?.trim() === "v1") hash = value?.trim();
  });
  if (!ts || !hash) return false;

    const requestIdCandidates = [xRequestId];

  // Envoy puede reemplazar el nibble de versión 4 por 9, a o b
  // para guardar el estado del tracing.
  if (typeof xRequestId === "string") {
    const envoyRequestIdMatch = xRequestId.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-)[9ab]([0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
    );

    if (envoyRequestIdMatch) {
      requestIdCandidates.push(
        `${envoyRequestIdMatch[1]}4${envoyRequestIdMatch[2]}`
      );
    }
  }

  const receivedHash = Buffer.from(hash);

  const verificationAttempts = requestIdCandidates.map(
    (requestIdCandidate) => {
      const manifest =
        `id:${dataId.toLowerCase()};` +
        `request-id:${requestIdCandidate};` +
        `ts:${ts};`;

      const expectedHash = crypto
        .createHmac("sha256", secret)
        .update(manifest)
        .digest("hex");

      const expectedHashBuffer = Buffer.from(expectedHash);

      return {
        manifest,
        expectedHash,
        matches:
          receivedHash.length === expectedHashBuffer.length &&
          crypto.timingSafeEqual(receivedHash, expectedHashBuffer),
      };
    }
  );

  const matches = verificationAttempts.some(
    (attempt) => attempt.matches
  );
  const primaryAttempt = verificationAttempts[0];

  if (!matches) {
    console.error("Webhook MP: firma no coincide", {
      manifest: primaryAttempt.manifest,
      hashRecibido: hash,
      hashEsperado: primaryAttempt.expectedHash,
      envoyFallbackAttempted: requestIdCandidates.length > 1,
      secretLength: secret.length,
    });
  }

  return matches;
};

// @desc    Consultar si el webhook ya completó un alta paga
// @route   POST /api/payments/registro/estado
// @access  Public, protegido por un token aleatorio de un solo registro
const getRegistrationStatus = async (req, res) => {
  try {
    const { registrationToken } = req.body;
    if (
      typeof registrationToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(registrationToken)
    ) {
      return res.status(400).json({ message: "Token de registro inválido" });
    }

    const activationTokenHash = crypto
      .createHash("sha256")
      .update(registrationToken)
      .digest("hex");
    const pending = await PendingRegistration.findOne({
      activationTokenHash,
      expiresAt: { $gt: new Date() },
    })
      .select("status userID paymentStatus paymentStatusDetail");

    if (!pending) {
      return res.status(404).json({ message: "Registro no encontrado o vencido" });
    }

    if (pending.status !== "completed") {
      return res.json({
        status: pending.status,
        paymentStatus: pending.paymentStatus,
        paymentStatusDetail: pending.paymentStatusDetail,
      });
    }

    const user = await User.findById(pending.userID)
      .select("username admin slug subscription subscriptionExpiresAt active");
    if (!user) {
      throw new Error("El registro figura completo pero no tiene un usuario asociado");
    }
    if (!user.active) {
      return res.status(403).json({ message: "Cuenta desactivada" });
    }

    res.json({
      status: "completed",
      auth: {
        _id: user._id,
        username: user.username,
        admin: user.admin,
        slug: user.slug,
        subscription: getEffectivePlan(user.subscription, user.subscriptionExpiresAt),
        subscriptionExpiresAt: user.subscriptionExpiresAt,
        token: generateAuthToken(user._id),
      },
    });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// Procesa un pago de Mercado Pago de punta a punta: lo trae de la API,
// registra la transacción, valida el checkout y aplica el alta o el
// upgrade correspondiente.
//
// Es idempotente — llamarla más de una vez con el mismo paymentId no
// duplica nada, gracias a los guards de entitlementStatus en
// PaymentTransaction — así que la puede llamar tanto el webhook
// (mpWebhook, abajo) como un job de reconciliación quc revisa
// registros/pagos trabados cuando el webhook nunca llegó.
//
// No recibe ni usa "res": si algo falla, tira la excepción y que la
// llame quien la llame decida qué hacer con el error.
// ──────────────────────────────────────────────
const processPaymentEvent = async (paymentId) => {
  const payment = new Payment(client);
  const paymentData = await payment.get({ id: paymentId });

  const externalRef = paymentData.external_reference;
  const planId = paymentData.metadata?.plan_id;
  const rawCheckoutID = toNullableString(paymentData.metadata?.checkout_id);
  const checkoutID = rawCheckoutID && mongoose.isValidObjectId(rawCheckoutID)
    ? rawCheckoutID
    : null;
  const mappedPlan = PLAN_MAP[planId];
  const isRegistration = paymentData.metadata?.type === "registration";
  const operation = getPaymentOperation(paymentData);
  const normalizedExternalRef = toNullableString(externalRef);
  const associatedID = mongoose.isValidObjectId(normalizedExternalRef)
    ? normalizedExternalRef
    : null;
  const transactionAssociation = associatedID
    ? operation === "registration"
      ? { pendingRegistrationID: associatedID }
      : operation === "upgrade" || operation === "renewal"
        ? { userID: associatedID }
        : {}
    : {};
  const paymentUpdatedAtCandidate = new Date(
    paymentData.date_last_updated || Date.now()
  );
  const paymentSnapshot = {
    paymentID: String(paymentData.id || paymentId),
    paymentStatus: paymentData.status,
    paymentStatusDetail: paymentData.status_detail || null,
    paymentUpdatedAt: Number.isNaN(paymentUpdatedAtCandidate.getTime())
      ? new Date()
      : paymentUpdatedAtCandidate,
  };

  // Se registra antes de cualquier validación o efecto sobre el plan. Así
  // también quedan auditados pagos pendientes, rechazados o con metadata
  // inválida. El upsert hace que cada reintento actualice el mismo pago.
  const paymentTransaction = await PaymentTransaction.findOneAndUpdate(
    { paymentID: paymentSnapshot.paymentID },
    {
      $set: {
        merchantOrderID: toNullableString(paymentData.order?.id),
        externalReference: normalizedExternalRef,
        operation,
        planId: toNullableString(planId),
        months: toNullableNumber(paymentData.metadata?.months),
        amount: toNullableNumber(paymentData.transaction_amount),
        refundedAmount: toNullableNumber(paymentData.transaction_amount_refunded),
        currency: toNullableString(paymentData.currency_id),
        status: toNullableString(paymentData.status),
        statusDetail: toNullableString(paymentData.status_detail),
        liveMode: typeof paymentData.live_mode === "boolean"
          ? paymentData.live_mode
          : null,
        paymentCreatedAt: toNullableDate(paymentData.date_created),
        paymentApprovedAt: toNullableDate(paymentData.date_approved),
        paymentUpdatedAt: toNullableDate(paymentData.date_last_updated),
        lastWebhookAt: new Date(),
        ...compactTransactionFields({ checkoutID: checkoutID || undefined }),
      },
      $setOnInsert: transactionAssociation,
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );
  if (!paymentTransaction) {
    throw new Error("No se pudo persistir la transacción de pago");
  }

  const expectedLiveMode = getExpectedPaymentLiveMode();
  if (paymentData.live_mode !== expectedLiveMode) {
    console.error("Webhook MP: el pago no pertenece al ambiente configurado", {
      paymentID: paymentSnapshot.paymentID,
      expectedLiveMode,
      receivedLiveMode: paymentData.live_mode,
    });
    await markPaymentNotApplied({
      paymentID: paymentSnapshot.paymentID,
      reason: "payment_environment_mismatch",
      ...transactionAssociation,
      checkoutID: checkoutID || undefined,
    });
    return;
  }

  // Una entrega repetida siempre refresca el estado financiero, pero un
  // beneficio ya aplicado no vuelve a tocar User ni duplica el evento CRM.
  if (paymentTransaction?.entitlementStatus === "applied") {
    return;
  }

  if (paymentData.status !== "approved") {
    if (!normalizedExternalRef || !associatedID) {
      await markPaymentNotApplied({
        paymentID: paymentSnapshot.paymentID,
        reason: normalizedExternalRef
          ? "invalid_external_reference"
          : "missing_external_reference",
      });
      return;
    }

    let pendingRegistration = null;
    if (isRegistration) {
      // Solo actualizamos altas todavía pendientes: una notificación
      // rechazada que llegue tarde nunca debe pisar un pago ya completado.
      pendingRegistration = await PendingRegistration.findOneAndUpdate(
        { _id: associatedID, status: "pending" },
        { $set: paymentSnapshot },
        { new: true }
      );
      await linkPendingRegistration(paymentSnapshot.paymentID, pendingRegistration);
    }
    await markPaymentNotApplied({
      paymentID: paymentSnapshot.paymentID,
      reason: "payment_not_approved",
      userID: operation === "upgrade" || operation === "renewal"
        ? associatedID || undefined
        : undefined,
      pendingRegistrationID: pendingRegistration?._id
        || (isRegistration ? associatedID || undefined : undefined),
      preferenceId: toNullableString(pendingRegistration?.preferenceId) || undefined,
    });
    return;
  }

  if (!normalizedExternalRef || !associatedID || !mappedPlan) {
    console.error("Webhook MP: falta external_reference o plan_id inválido", {
      externalRef,
      planId,
    });
    await markPaymentNotApplied({
      paymentID: paymentSnapshot.paymentID,
      reason: !normalizedExternalRef
        ? "missing_external_reference"
        : !associatedID
          ? "invalid_external_reference"
          : "invalid_plan",
      userID: operation === "upgrade" || operation === "renewal"
        ? associatedID || undefined
        : undefined,
      pendingRegistrationID: isRegistration
        ? associatedID || undefined
        : undefined,
    });
    return;
  }

  if (operation === "unknown") {
    await markPaymentNotApplied({
      paymentID: paymentSnapshot.paymentID,
      reason: "invalid_operation",
      userID: associatedID || undefined,
      checkoutID: checkoutID || undefined,
    });
    return;
  }

  let checkout = null;
  let checkoutValidation = "legacy";
  let checkoutValidationReason = "checkout_id_missing_legacy";
  if (rawCheckoutID) {
    if (!checkoutID) {
      checkoutValidation = "failed";
      checkoutValidationReason = "invalid_checkout_id";
    } else {
      checkout = await PaymentCheckout.findById(checkoutID);
      checkoutValidationReason = validateCheckoutSnapshot({
        checkout,
        operation,
        associatedID,
        planId,
        months: paymentData.metadata?.months,
        amount: paymentData.transaction_amount,
        currency: paymentData.currency_id,
      });
      checkoutValidation = checkoutValidationReason ? "failed" : "strict";
    }
  }

  await PaymentTransaction.findOneAndUpdate(
    { paymentID: paymentSnapshot.paymentID },
    {
      $set: {
        checkoutValidation,
        checkoutValidationReason,
        ...compactTransactionFields({
          checkoutID: checkout?._id || checkoutID || undefined,
          preferenceId: toNullableString(checkout?.preferenceId) || undefined,
        }),
      },
    },
    { new: true, runValidators: true }
  );

  if (checkoutValidation === "failed") {
    await markPaymentNotApplied({
      paymentID: paymentSnapshot.paymentID,
      reason: checkoutValidationReason,
      userID: operation === "upgrade" || operation === "renewal"
        ? associatedID
        : undefined,
      pendingRegistrationID: operation === "registration"
        ? associatedID
        : undefined,
      checkoutID: checkout?._id || checkoutID || undefined,
      preferenceId: toNullableString(checkout?.preferenceId) || undefined,
    });
    return;
  }

  if (checkout?._id) {
    await PaymentCheckout.findByIdAndUpdate(checkout._id, {
      $set: { status: "payment_received", failureReason: null },
    });
  }

  const approvedAt = toNullableDate(paymentData.date_approved) || new Date();

  // ── Flujo REGISTRO ──
  if (isRegistration) {
    const pending = await PendingRegistration.findById(associatedID)
      .select("+password +passwordCiphertext +passwordIV +passwordAuthTag");
    if (!pending) {
      await markPaymentNotApplied({
        paymentID: paymentSnapshot.paymentID,
        reason: "pending_registration_not_found",
        pendingRegistrationID: associatedID || undefined,
      });
      return;
    }

    const pendingAssociation = {
      pendingRegistrationID: pending._id,
      preferenceId: toNullableString(checkout?.preferenceId)
        || toNullableString(pending.preferenceId)
        || undefined,
      checkoutID: checkout?._id || checkoutID || undefined,
    };

    if (pending.status === "failed") {
      await markPaymentNotApplied({
        paymentID: paymentSnapshot.paymentID,
        reason: "registration_failed",
        ...pendingAssociation,
      });
      return;
    }

    if (pending.status === "completed") {
      if (
        pending.paymentID
        && String(pending.paymentID) !== paymentSnapshot.paymentID
      ) {
        await markPaymentNotApplied({
          paymentID: paymentSnapshot.paymentID,
          reason: "registration_completed_by_other_payment",
          ...pendingAssociation,
        });
        return;
      }

      if (!pending.userID) {
        await markPaymentNotApplied({
          paymentID: paymentSnapshot.paymentID,
          reason: "completed_registration_without_user",
          ...pendingAssociation,
        });
        return;
      }

      const completedUser = await User.findById(pending.userID)
        .select("subscription subscriptionExpiresAt");
      if (!completedUser) {
        await markPaymentNotApplied({
          paymentID: paymentSnapshot.paymentID,
          reason: "completed_registration_user_not_found",
          ...pendingAssociation,
        });
        return;
      }

      const capturedCompletedMonths = Number(paymentTransaction?.appliedMonths);
      const completedMonths = [1, 3, 6, 12].includes(capturedCompletedMonths)
        ? capturedCompletedMonths
        : [1, 3, 6, 12].includes(Number(pending.months))
          ? Number(pending.months)
          : 1;
      const calculatedCompletedExpiry = addCalendarMonths(
        approvedAt,
        completedMonths
      );
      const completedExpiry = toNullableDate(
        paymentTransaction?.subscriptionExpiresAtAfter
      ) || calculatedCompletedExpiry;
      await preparePaymentEntitlement({
        paymentID: paymentSnapshot.paymentID,
        subscriptionExpiresAtBefore: null,
        subscriptionExpiresAtAfter: completedExpiry,
        planId: mappedPlan,
        months: completedMonths,
        userID: completedUser._id || pending.userID,
        ...pendingAssociation,
      });
      const newlyApplied = await markPaymentApplied({
        paymentID: paymentSnapshot.paymentID,
        userID: completedUser._id || pending.userID,
        ...pendingAssociation,
      });
      if (newlyApplied) {
        await logCrmEvent(
          completedUser._id || pending.userID,
          `Alta por pago MP — plan ${mappedPlan} × ${completedMonths} mes(es), vigente hasta ${completedExpiry.toISOString()}`
        );
      }
      return;
    }

    const metadataMonths = Number(paymentData.metadata?.months);
    const paidMonths = [1, 3, 6, 12].includes(metadataMonths)
      ? metadataMonths
      : pending.months;
    const subscriptionExpiresAt = addCalendarMonths(approvedAt, paidMonths);

    const pendingPassword = decryptPendingPassword(pending);

    // Evitar duplicados si MP reintenta el webhook
    const alreadyExists = await User.findOne({ username: pending.username })
      .select("+password");
    if (alreadyExists) {
      const belongsToThisRegistration = await alreadyExists.matchPassword(
        pendingPassword
      );
      if (!belongsToThisRegistration) {
        const failedPending = await PendingRegistration.findByIdAndUpdate(
          pending._id,
          {
            $set: {
              status: "failed",
              userID: null,
              completedAt: null,
              expiresAt: PendingRegistration.getTerminalExpiration(),
              ...paymentSnapshot,
            },
            $unset: {
              password: 1,
              passwordCiphertext: 1,
              passwordIV: 1,
              passwordAuthTag: 1,
            },
          },
          { new: true }
        );
        if (!failedPending) {
          throw new Error("El registro pendiente desapareció durante la acreditación");
        }
        await markPaymentNotApplied({
          paymentID: paymentSnapshot.paymentID,
          reason: "registration_username_conflict",
          ...pendingAssociation,
        });
        return;
      }

      const preparedEntitlement = await preparePaymentEntitlement({
        paymentID: paymentSnapshot.paymentID,
        subscriptionExpiresAtBefore:
          alreadyExists.subscriptionExpiresAt || null,
        subscriptionExpiresAtAfter: subscriptionExpiresAt,
        planId: mappedPlan,
        months: paidMonths,
        userID: alreadyExists._id,
        ...pendingAssociation,
      });
      const durableEntitlement = preparedEntitlement
        || (paymentTransaction.subscriptionExpiresAtAfter !== undefined
          ? paymentTransaction
          : null);
      const recoveredExpiry = toNullableDate(
        durableEntitlement?.subscriptionExpiresAtAfter
      );
      if (!recoveredExpiry) {
        throw new Error("No se pudo recuperar el vencimiento durable del alta");
      }
      const recoveredPlan = durableEntitlement?.appliedPlanId || mappedPlan;
      const storedRecoveredMonths = Number(
        durableEntitlement?.appliedMonths
      );
      const recoveredMonths = [1, 3, 6, 12].includes(storedRecoveredMonths)
        ? storedRecoveredMonths
        : paidMonths;
      const reconciledEntitlement = reconcileRegistrationEntitlement({
        currentPlan: alreadyExists.subscription,
        currentExpiresAt: alreadyExists.subscriptionExpiresAt,
        purchasedPlan: recoveredPlan,
        purchasedExpiresAt: recoveredExpiry,
      });
      const reconciledUser = await User.findByIdAndUpdate(
        alreadyExists._id,
        { $set: reconciledEntitlement },
        { new: true, runValidators: true }
      );
      if (!reconciledUser) {
        throw new Error("El usuario desapareció durante la acreditación del alta");
      }

      const completedPending = await PendingRegistration.findByIdAndUpdate(
        pending._id,
        {
          $set: {
            status: "completed",
            userID: alreadyExists._id,
            completedAt: new Date(),
            expiresAt: PendingRegistration.getTerminalExpiration(),
            ...paymentSnapshot,
          },
          $unset: {
            password: 1,
            passwordCiphertext: 1,
            passwordIV: 1,
            passwordAuthTag: 1,
          },
        },
        { new: true }
      );
      if (!completedPending) {
        throw new Error("El registro pendiente desapareció durante la acreditación");
      }

      const newlyApplied = await markPaymentApplied({
        paymentID: paymentSnapshot.paymentID,
        userID: alreadyExists._id,
        ...pendingAssociation,
      });
      if (newlyApplied) {
        await logCrmEvent(
          alreadyExists._id,
          `Alta por pago MP — plan ${mappedPlan} × ${recoveredMonths} mes(es), vigente hasta ${recoveredExpiry.toISOString()}`
        );
      }
      return;
    }

    const preparedEntitlement = await preparePaymentEntitlement({
      paymentID: paymentSnapshot.paymentID,
      subscriptionExpiresAtBefore: null,
      subscriptionExpiresAtAfter: subscriptionExpiresAt,
      planId: mappedPlan,
      months: paidMonths,
      ...pendingAssociation,
    });
    const entitlementExpiresAt = toNullableDate(
      preparedEntitlement?.subscriptionExpiresAtAfter
        || paymentTransaction?.subscriptionExpiresAtAfter
    ) || subscriptionExpiresAt;
    const storedMonths = Number(
      preparedEntitlement?.appliedMonths
        || paymentTransaction?.appliedMonths
    );
    const entitlementMonths = [1, 3, 6, 12].includes(storedMonths)
      ? storedMonths
      : paidMonths;

    const user = await createUserWithUniqueSlug({
      username: pending.username,
      password: pendingPassword, // pre-save de User la hashea
      contactInfo: pending.contactInfo,
      acceptedTerms: true,
      acceptedTermsAt: new Date(),
      acceptedTermsVersion: process.env.ACCEPTED_TERMS_VERSION,
      subscription: mappedPlan,
      subscriptionExpiresAt: entitlementExpiresAt,
      sellerID: pending.sellerID || null,
    });

    const completedPending = await PendingRegistration.findByIdAndUpdate(
      pending._id,
      {
        $set: {
          status: "completed",
          userID: user._id,
          planId: mappedPlan,
          months: entitlementMonths,
          completedAt: new Date(),
          expiresAt: PendingRegistration.getTerminalExpiration(),
          ...paymentSnapshot,
        },
        $unset: {
          password: 1,
          passwordCiphertext: 1,
          passwordIV: 1,
          passwordAuthTag: 1,
        },
      },
      { new: true }
    );
    if (!completedPending) {
      throw new Error("El registro pendiente desapareció durante la acreditación");
    }
    const newlyApplied = await markPaymentApplied({
      paymentID: paymentSnapshot.paymentID,
      userID: user._id,
      ...pendingAssociation,
    });
    if (newlyApplied) {
      await logCrmEvent(
        user._id,
        `Alta por pago MP — plan ${mappedPlan} × ${entitlementMonths} mes(es)${pending.sellerID ? " · ref. vendedor" : ""}, vigente hasta ${entitlementExpiresAt.toISOString()}`
      );
    }

    return;
  }

  // ── Flujo UPGRADE (usuario ya existente) ──
  const rawUpgradeMonths = paymentData.metadata?.months;
  const metadataMonths = rawUpgradeMonths === undefined
    ? 1 // Preferencias de upgrade creadas antes de incorporar el selector.
    : Number(rawUpgradeMonths);
  if (![1, 3, 6, 12].includes(metadataMonths)) {
    console.error("Webhook MP: duración de upgrade inválida", {
      externalRef,
      planId,
      months: paymentData.metadata?.months,
    });
    await markPaymentNotApplied({
      paymentID: paymentSnapshot.paymentID,
      reason: "invalid_months",
      userID: associatedID || undefined,
    });
    return;
  }

  const entitlementResult = await applyExistingUserEntitlement({
    paymentID: paymentSnapshot.paymentID,
    associatedID,
    mappedPlan,
    months: metadataMonths,
    approvedAt,
    checkoutID: checkout?._id || checkoutID || undefined,
  });
  if (entitlementResult.appliedNow) {
    await logCrmEvent(
      associatedID,
      `Pago MP aprobado — ${entitlementResult.isRenewal ? `renovación ${mappedPlan}` : `plan ${entitlementResult.previousPlan} → ${mappedPlan}`} × ${metadataMonths} mes(es), vigente hasta ${entitlementResult.subscriptionExpiresAt.toISOString()}`
    );
  }
};

// @desc    Recibe la notificación de MercadoPago y confirma el pago
// @route   POST /api/payments/webhook
// @access  Public (lo llama MercadoPago, no el frontend)
const mpWebhook = async (req, res) => {
  try {
    const topic = req.query.type || req.query.topic;

    // merchant_order no trae "data.id" y MP no lo firma con ese esquema,
    // así que ni intentamos validar firma para ese topic.
    if (topic !== "payment") {
      return res.sendStatus(200);
    }

    if (!verifyMpSignature(req)) {
      console.error("Webhook MP: firma inválida");
      return res.sendStatus(401);
    }

    const paymentId = req.query["data.id"] || req.query.id || req.body?.data?.id;
    if (!paymentId) {
      return res.sendStatus(200);
    }

    await processPaymentEvent(paymentId);
    res.sendStatus(200);
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = { getRegistrationStatus, mpWebhook, processPaymentEvent };
