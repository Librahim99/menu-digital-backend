const Seller = require("../models/Seller");
const LeadAssignmentState = require("../models/LeadAssignmentState");

async function nextLeadSeller() {
  const sellers = await Seller.find({ active: true, receivesLeads: true, influencer: { $ne: true } })
    .select("_id").sort({ _id: 1 }).lean();
  if (!sellers.length) return null;

  const reserveTurn = () => LeadAssignmentState.findOneAndUpdate(
    { _id: "influencer-leads" },
    { $inc: { sequence: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: false },
  );
  let turn;
  try {
    turn = await reserveTurn();
  } catch (error) {
    // Dos instancias pueden intentar crear el contador inicial a la vez.
    if (error.code !== 11000) throw error;
    turn = await reserveTurn();
  }
  return sellers[(turn.sequence - 1) % sellers.length]._id;
}

module.exports = { nextLeadSeller };
