const SellerSale = require("../models/SellerSale");

// El sellerID que comisiona por una venta es siempre el mismo sellerID que
// tiene el User en ese momento (el vendedor normal, o el vendedor influencer
// cuando el lead vino referido) — assignedSeller es solo el responsable de
// seguimiento en el CRM y nunca participa de la atribución de una venta.
const attributionForUser = (user) => ({ sellerID: user?.sellerID || null });

const createSaleSnapshot = ({ attribution, plan, months, amount, subscriptionDate }) => {
  if (!attribution?.sellerID) return undefined;
  return {
    sellerID: attribution.sellerID,
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

module.exports = { attributionForUser, createSaleSnapshot, recordSaleFromTransaction };
