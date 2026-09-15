const User = require("../models/User");
const SellerSale = require("../models/SellerSale");

// El influencer cobra 15% fijo, y solo sobre la primera compra aprobada de
// cada lead — igual que un seller normal, la comisión nunca se guarda en la
// base de datos: se recalcula siempre a partir de SellerSale.amount.
const INFLUENCER_RATE = 0.15;
const round2 = value => Math.round(value * 100) / 100;

function netInfluencerCommission(sale) {
  if (["refunded", "charged_back"].includes(sale.paymentStatus)) return 0;
  const refund = Math.min(sale.amount, Math.max(0, sale.refundedAmount || 0));
  return round2(Math.max(0, sale.amount - refund) * INFLUENCER_RATE);
}

async function getInfluencerOverview(seller) {
  const [users, sales] = await Promise.all([
    User.find({ sellerID: seller._id, influencerReferral: true, admin: false })
      .select("username slug contactInfo.businessName createdAt").sort({ createdAt: -1 }).lean(),
    SellerSale.find({ sellerID: seller._id })
      .select("userID subscriptionDate amount refundedAmount paymentStatus")
      .sort({ subscriptionDate: 1, _id: 1 }).lean(),
  ]);
  // Solo la primera venta (cronológicamente) de cada lead genera comisión;
  // renovaciones posteriores no cuentan, sin importar cómo termine esa primera venta.
  const conversions = new Map();
  for (const sale of sales) {
    const key = String(sale.userID);
    if (conversions.has(key)) continue;
    conversions.set(key, {
      convertedAt: sale.subscriptionDate,
      commission: netInfluencerCommission(sale),
    });
  }
  return {
    profile: { name: seller.name, code: seller.code },
    commissionRate: INFLUENCER_RATE,
    totals: {
      leads: users.length,
      conversions: conversions.size,
      commission: round2([...conversions.values()].reduce((total, row) => total + row.commission, 0)),
    },
    leads: users.map(user => {
      const conversion = conversions.get(String(user._id));
      return {
        _id: user._id,
        businessName: user.contactInfo?.businessName || "",
        username: user.username,
        slug: user.slug || "",
        createdAt: user.createdAt,
        status: conversion ? "converted" : "pending",
        convertedAt: conversion?.convertedAt || null,
        commission: conversion?.commission || 0,
      };
    }),
  };
}

module.exports = { getInfluencerOverview, netInfluencerCommission, INFLUENCER_RATE };
