const User = require("../models/User");
const SellerSale = require("../models/SellerSale");

const round2 = value => Math.round(value * 100) / 100;

function netInfluencerCommission(sale) {
  const gross = sale.influencerCommissionAmount || 0;
  if (!gross || ["refunded", "charged_back"].includes(sale.paymentStatus)) return 0;
  const refund = Math.min(sale.amount, Math.max(0, sale.refundedAmount || 0));
  return round2(Math.max(0, gross - refund * sale.influencerRate));
}

async function getInfluencerOverview(seller) {
  const [users, sales] = await Promise.all([
    User.find({ sellerID: seller._id, influencerReferral: true, admin: false })
      .select("username slug contactInfo.businessName createdAt").sort({ createdAt: -1 }).lean(),
    SellerSale.find({ influencerID: seller._id })
      .select("userID subscriptionDate amount influencerRate influencerCommissionAmount refundedAmount paymentStatus")
      .sort({ subscriptionDate: 1, _id: 1 }).lean(),
  ]);
  const conversions = new Map();
  for (const sale of sales) {
    const key = String(sale.userID);
    const previous = conversions.get(key);
    conversions.set(key, {
      convertedAt: previous?.convertedAt || sale.subscriptionDate,
      commission: round2((previous?.commission || 0) + netInfluencerCommission(sale)),
    });
  }
  return {
    profile: { name: seller.name, code: seller.code },
    commissionRate: 0.15,
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

module.exports = { getInfluencerOverview, netInfluencerCommission };
