const { buenosAiresDateStr } = require("./dates");

// Ventanas de días completos; el conteo de hoy se devuelve por separado.
const buildStatsPeriod = (windowDays, createdAt, now = Date.now()) => {
  const dayAt = (offset) => buenosAiresDateStr(new Date(now - offset * 86_400_000));
  const dates = Array.from({ length: windowDays }, (_, i) => dayAt(windowDays - i));
  const previousDates = Array.from({ length: windowDays }, (_, i) => dayAt(windowDays * 2 - i));
  const created = createdAt == null ? null : new Date(createdAt);
  const observedFrom = created && Number.isFinite(created.getTime()) ? buenosAiresDateStr(created) : null;
  return {
    dates, previousDates,
    windowDays,
    todayDate: dayAt(0),
    periodStart: dates[0], periodEnd: dates.at(-1),
    previousStart: previousDates[0], previousEnd: previousDates.at(-1),
    observedFrom,
    // El día del alta también puede ser parcial.
    comparisonAvailable: observedFrom !== null && observedFrom < previousDates[0],
  };
};

module.exports = { buildStatsPeriod };
