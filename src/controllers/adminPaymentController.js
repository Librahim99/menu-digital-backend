const mongoose = require("mongoose");
const PaymentTransaction = require("../models/PaymentTransaction");
const PendingRegistration = require("../models/PendingRegistration");
const User = require("../models/User");
const { handleError } = require("../utils/handleError");

const ENTITLEMENT_STATUSES = ["pending", "not_applied", "applied"];
const OPERATIONS = ["registration", "upgrade", "renewal", "unknown"];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isPopulated = (value, identifyingField) => (
  value && typeof value === "object" && identifyingField in value
);
const toId = (value) => (value ? String(value) : null);

const paymentToDTO = (payment) => {
  const user = isPopulated(payment.userID, "username") ? payment.userID : null;
  const pending = isPopulated(payment.pendingRegistrationID, "username")
    ? payment.pendingRegistrationID
    : null;
  const checkout = isPopulated(payment.checkoutID, "status") ? payment.checkoutID : null;

  return {
    id: toId(payment._id),
    paymentID: payment.paymentID,
    preferenceId: payment.preferenceId || null,
    operation: payment.operation,
    planId: payment.planId || null,
    months: payment.months ?? null,
    amount: payment.amount ?? null,
    refundedAmount: payment.refundedAmount ?? null,
    currency: payment.currency || null,
    status: payment.status || null,
    statusDetail: payment.statusDetail || null,
    liveMode: payment.liveMode ?? null,
    paymentCreatedAt: payment.paymentCreatedAt || null,
    paymentApprovedAt: payment.paymentApprovedAt || null,
    paymentUpdatedAt: payment.paymentUpdatedAt || null,
    lastWebhookAt: payment.lastWebhookAt,
    entitlementStatus: payment.entitlementStatus,
    entitlementReason: payment.entitlementReason || null,
    entitlementAppliedAt: payment.entitlementAppliedAt || null,
    checkoutValidation: payment.checkoutValidation,
    checkoutValidationReason: payment.checkoutValidationReason || null,
    appliedPlanId: payment.appliedPlanId || null,
    appliedMonths: payment.appliedMonths ?? null,
    subscriptionExpiresAtAfter: payment.subscriptionExpiresAtAfter || null,
    createdAt: payment.createdAt,
    checkout: payment.checkoutID
      ? {
          id: toId(checkout?._id || payment.checkoutID),
          status: checkout?.status || null,
        }
      : null,
    customer: user || pending
      ? {
          id: toId(user?._id || pending?.userID),
          username: user?.username || pending?.username || "",
          businessName:
            user?.contactInfo?.businessName
            || pending?.contactInfo?.businessName
            || "",
          slug: user?.slug || "",
        }
      : null,
  };
};

const getSummary = async (baseFilter) => {
  const pendingStatuses = ["pending", "in_process", "in_mediation", "authorized"];
  const failedStatuses = ["rejected", "cancelled"];
  const refundedStatuses = ["refunded", "charged_back"];
  const attentionFilter = {
    ...baseFilter,
    $or: [
      { status: "approved", entitlementStatus: { $ne: "applied" } },
      { checkoutValidation: "failed" },
    ],
  };

  const [
    total,
    approved,
    pending,
    failed,
    refunded,
    applied,
    attention,
    amountRows,
  ] = await Promise.all([
    PaymentTransaction.countDocuments(baseFilter),
    PaymentTransaction.countDocuments({ ...baseFilter, status: "approved" }),
    PaymentTransaction.countDocuments({ ...baseFilter, status: { $in: pendingStatuses } }),
    PaymentTransaction.countDocuments({ ...baseFilter, status: { $in: failedStatuses } }),
    PaymentTransaction.countDocuments({ ...baseFilter, status: { $in: refundedStatuses } }),
    PaymentTransaction.countDocuments({ ...baseFilter, entitlementStatus: "applied" }),
    PaymentTransaction.countDocuments(attentionFilter),
    PaymentTransaction.aggregate([
      { $match: { ...baseFilter, status: "approved", entitlementStatus: "applied" } },
      { $group: { _id: null, amount: { $sum: { $ifNull: ["$amount", 0] } } } },
    ]),
  ]);

  return {
    total,
    approved,
    pending,
    failed,
    refunded,
    applied,
    attention,
    appliedAmount: amountRows[0]?.amount || 0,
    currency: "ARS",
  };
};

// @desc    Listado y resumen de pagos persistidos para operación/conciliación.
// @route   GET /api/admin/payments
// @access  Admin, solo lectura
const listPayments = async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const entitlement = typeof req.query.entitlement === "string"
      ? req.query.entitlement.trim()
      : "";
    const operation = typeof req.query.operation === "string"
      ? req.query.operation.trim()
      : "";
    const userID = typeof req.query.userID === "string" ? req.query.userID.trim() : "";
    const search = typeof req.query.search === "string"
      ? req.query.search.trim().slice(0, 80)
      : "";

    if (status && status !== "all" && !/^[a-z0-9_]{1,40}$/.test(status)) {
      return res.status(400).json({ message: "Estado de pago inválido" });
    }
    if (entitlement && entitlement !== "all" && !ENTITLEMENT_STATUSES.includes(entitlement)) {
      return res.status(400).json({ message: "Estado de acreditación inválido" });
    }
    if (operation && operation !== "all" && !OPERATIONS.includes(operation)) {
      return res.status(400).json({ message: "Operación inválida" });
    }
    if (userID) {
      if (!mongoose.Types.ObjectId.isValid(userID)) {
        return res.status(400).json({ message: "ID de cliente inválido" });
      }
      const clientExists = await User.exists({ _id: userID, admin: false });
      if (!clientExists) return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const filter = {};
    if (userID) filter.userID = userID;
    if (status && status !== "all") filter.status = status;
    if (entitlement && entitlement !== "all") filter.entitlementStatus = entitlement;
    if (operation && operation !== "all") filter.operation = operation;

    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      const [users, pendingRegistrations] = await Promise.all([
        User.find({
          admin: false,
          $or: [
            { username: pattern },
            { slug: pattern },
            { "contactInfo.businessName": pattern },
          ],
        }).select("_id").limit(50),
        PendingRegistration.find({
          $or: [
            { username: pattern },
            { "contactInfo.businessName": pattern },
          ],
        }).select("_id").limit(50),
      ]);
      filter.$or = [
        { paymentID: pattern },
        { preferenceId: pattern },
        { userID: { $in: users.map((user) => user._id) } },
        { pendingRegistrationID: { $in: pendingRegistrations.map((pending) => pending._id) } },
      ];
    }

    // Mongoose castea filtros de find/count, pero no valores dentro de una
    // aggregation; convertimos explícitamente para que el importe por cliente
    // no quede siempre en cero.
    const summaryFilter = userID
      ? { userID: new mongoose.Types.ObjectId(userID) }
      : {};
    const [total, payments, summary] = await Promise.all([
      PaymentTransaction.countDocuments(filter),
      PaymentTransaction.find(filter)
        .select(
          "paymentID checkoutID preferenceId userID pendingRegistrationID operation planId months " +
          "amount refundedAmount currency status statusDetail liveMode paymentCreatedAt paymentApprovedAt " +
          "paymentUpdatedAt lastWebhookAt entitlementStatus entitlementReason entitlementAppliedAt " +
          "checkoutValidation checkoutValidationReason appliedPlanId appliedMonths " +
          "subscriptionExpiresAtAfter createdAt"
        )
        .populate("userID", "username slug contactInfo.businessName")
        .populate("pendingRegistrationID", "username contactInfo.businessName userID")
        .populate("checkoutID", "status")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      getSummary(summaryFilter),
    ]);

    res.json({
      payments: payments.map(paymentToDTO),
      summary,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = { listPayments, paymentToDTO };
