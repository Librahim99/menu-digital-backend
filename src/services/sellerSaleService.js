const SellerSale = require("../models/SellerSale");

const INFLUENCER_RATE = 0.15;
const roundMoney = (amount) => Math.round(amount * 100) / 100;

// El origen del lead se congela al registrarlo; cambiar el rol de Seller no
// debe convertir clientes históricos en referidos de influencers.
const attributionForUser = (user) => user?.influencerReferral === true
  ? { sellerID: user.assignedSeller || null, influencerID: user.sellerID || null, influencerRate: INFLUENCER_RATE }
  : { sellerID: user?.sellerID || null, influencerID: null, influencerRate: 0 };

const createSaleSnapshot = ({ attribution, plan, months, amount, subscriptionDate, firstInfluencerPurchase = false }) => {
  if (!attribution?.sellerID && !attribution?.influencerID) return undefined;
  const influencerRate = attribution.influencerID ? attribution.influencerRate : 0;
  return {
    sellerID: attribution.sellerID || null,
    influencerID: attribution.influencerID || null,
    influencerRate,
    influencerCommissionAmount: firstInfluencerPurchase ? roundMoney(amount * influencerRate) : 0,
    plan,
    months,
    amount,
    subscriptionDate,
  };
};

// La transacción conserva el snapshot antes de quedar aplicada. Si este
// efecto secundario falla, el siguiente webhook puede reconstruirlo sin
// volver a modificar la suscripción ni consultar atribución mutable.
const recordSaleFromTransaction = async (transaction) => {
  const snapshot = transaction?.saleAttribution;
  if (!snapshot || !transaction.userID || transaction.entitlementStatus !== "applied") return;
  const frozen = typeof snapshot.toObject === "function" ? snapshot.toObject() : snapshot;
  await SellerSale.findOneAndUpdate(
    { paymentID: transaction.paymentID },
    {
      $setOnInsert: { userID: transaction.userID, ...frozen },
      $set: {
        refundedAmount: Math.max(0, Number(transaction.refundedAmount) || 0),
        paymentStatus: transaction.status || "approved",
      },
    },
    { upsert: true, setDefaultsOnInsert: true, runValidators: true },
  );
};

module.exports = { INFLUENCER_RATE, attributionForUser, createSaleSnapshot, recordSaleFromTransaction };
