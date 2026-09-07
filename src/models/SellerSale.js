const mongoose = require("mongoose");

// Snapshot inmutable de una venta atribuida a un vendedor, tomado en el
// momento en que el pago se aplica (mismo instante en que PaymentTransaction
// pasa a entitlementStatus "applied"). sellerID se copia del User/Pending-
// Registration en ese momento a propósito: si más adelante se reasigna el
// vendedor del cliente, las ventas ya generadas no deben "migrar" de
// vendedor con él. La comisión no se calcula ni se guarda acá — eso se
// resuelve en tiempo real desde el panel del vendedor.
const sellerSaleSchema = new mongoose.Schema(
  {
    // Clave natural del pago en MercadoPago (igual que PaymentTransaction).
    // unique + upsert por este campo evitan duplicar la venta si el webhook
    // reintenta la entrega.
    paymentID: { type: String, required: true, unique: true, trim: true },
    userID: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sellerID: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true },
    plan: { type: String, enum: ["basic", "pro"], required: true },
    amount: { type: Number, required: true, min: 0 },
    months: { type: Number, enum: [1, 3, 6, 12], required: true },
    subscriptionDate: { type: Date, required: true },
  },
  { timestamps: true }
);

sellerSaleSchema.index({ sellerID: 1, subscriptionDate: -1 });

module.exports = mongoose.model("SellerSale", sellerSaleSchema);
