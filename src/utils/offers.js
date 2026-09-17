const {
  getEmptySchedule,
  isScheduleAvailableAt,
  isWithinDateRange,
  validateAvailabilitySchedule,
  validateDateRange,
} = require("./itemAvailability");

// La oferta programada comparte el horario semanal con la disponibilidad
// (mismos días + rangos horarios); su rango de fechas opcional vive en
// offerRange, que ya existía cuando la oferta solo era un período.
const getEmptyOfferSchedule = () => {
  const schedule = getEmptySchedule();
  delete schedule.dateRange;
  return schedule;
};

const normalizeOffer = ({ price, offerPrice, offerRange, offerSchedule }) => {
  const normalizedOfferPrice = offerPrice === "" || offerPrice == null
    ? null
    : Number(offerPrice);

  if (normalizedOfferPrice !== null && (!Number.isFinite(normalizedOfferPrice) || normalizedOfferPrice <= 0)) {
    return { error: "El precio de oferta debe ser un número positivo." };
  }
  if (normalizedOfferPrice !== null && price != null && normalizedOfferPrice >= Number(price)) {
    return { error: "El precio de oferta debe ser menor al precio original." };
  }

  const { dateRange, error: dateError } = validateDateRange(offerRange);
  if (dateError) return { error: dateError };

  let normalizedSchedule = getEmptyOfferSchedule();
  if (offerSchedule !== undefined && offerSchedule !== null) {
    const validation = validateAvailabilitySchedule(offerSchedule, { withDateRange: false });
    if (validation.error) return { error: validation.error };
    normalizedSchedule = validation.schedule;
  }

  const hasDateRange = Boolean(dateRange.from || dateRange.to);
  const isScheduled = hasDateRange || normalizedSchedule.enabled;
  if (isScheduled && normalizedOfferPrice === null) {
    return { error: "Ingresá un precio de oferta antes de programarla." };
  }

  return {
    offerPrice: normalizedOfferPrice,
    offerRange: dateRange,
    offerSchedule: normalizedSchedule,
    isScheduled,
  };
};

const isOfferActive = ({ price, offerPrice, offerRange, offerSchedule }, now = new Date()) => {
  if (offerPrice == null || price == null || Number(offerPrice) >= Number(price)) return false;
  if (!isWithinDateRange(offerRange, now)) return false;
  // Sin horario semanal activo la oferta rige todo el día dentro del rango.
  return isScheduleAvailableAt(offerSchedule, now);
};

module.exports = { getEmptyOfferSchedule, isOfferActive, normalizeOffer };
