const normalizeOffer = ({ price, offerPrice, offerRange }) => {
  const normalizedOfferPrice = offerPrice === "" || offerPrice == null
    ? null
    : Number(offerPrice);
  const rawFrom = offerRange?.from;
  const rawTo = offerRange?.to;
  const hasFrom = rawFrom !== "" && rawFrom != null;
  const hasTo = rawTo !== "" && rawTo != null;

  if (normalizedOfferPrice !== null && (!Number.isFinite(normalizedOfferPrice) || normalizedOfferPrice <= 0)) {
    return { error: "El precio de oferta debe ser un número positivo." };
  }
  if (normalizedOfferPrice !== null && price != null && normalizedOfferPrice >= Number(price)) {
    return { error: "El precio de oferta debe ser menor al precio original." };
  }
  if (hasFrom !== hasTo) {
    return { error: "La oferta programada necesita fecha de inicio y de fin." };
  }
  if ((hasFrom || hasTo) && normalizedOfferPrice === null) {
    return { error: "Ingresá un precio de oferta antes de programarla." };
  }

  const from = hasFrom ? new Date(rawFrom) : null;
  const to = hasTo ? new Date(rawTo) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    return { error: "Las fechas de la oferta no son válidas." };
  }
  if (from && to && from >= to) {
    return { error: "El fin de la oferta debe ser posterior al inicio." };
  }

  return {
    offerPrice: normalizedOfferPrice,
    offerRange: { from, to },
    isScheduled: Boolean(from && to),
  };
};

const isOfferActive = ({ price, offerPrice, offerRange }, now = new Date()) => {
  if (offerPrice == null || price == null || Number(offerPrice) >= Number(price)) return false;
  const from = offerRange?.from ? new Date(offerRange.from) : null;
  const to = offerRange?.to ? new Date(offerRange.to) : null;
  if (!from && !to) return true;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return false;
  return now >= from && now <= to;
};

module.exports = { isOfferActive, normalizeOffer };
