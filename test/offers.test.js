const test = require("node:test");
const assert = require("node:assert/strict");
const { isOfferActive, normalizeOffer } = require("../src/utils/offers");

test("una oferta sin período queda activa manualmente", () => {
  assert.equal(isOfferActive({ price: 1000, offerPrice: 800, offerRange: {} }), true);
});

test("una oferta programada solo queda activa dentro del período", () => {
  const offer = {
    price: 1000,
    offerPrice: 800,
    offerRange: {
      from: new Date("2026-08-20T12:00:00-03:00"),
      to: new Date("2026-08-20T15:00:00-03:00"),
    },
  };

  assert.equal(isOfferActive(offer, new Date("2026-08-20T14:00:00-03:00")), true);
  assert.equal(isOfferActive(offer, new Date("2026-08-20T16:00:00-03:00")), false);
});

test("acepta un rango de fechas abierto de un solo extremo", () => {
  const desde = { price: 1000, ...normalizeOffer({
    price: 1000,
    offerPrice: 800,
    offerRange: { from: "2026-08-20", to: null },
  }) };

  assert.equal(desde.error, undefined);
  assert.equal(desde.isScheduled, true);
  // "Desde el 20" arranca a las 00:00 de Buenos Aires.
  assert.equal(desde.offerRange.from.toISOString(), "2026-08-20T03:00:00.000Z");
  assert.equal(desde.offerRange.to, null);

  assert.equal(isOfferActive(desde, new Date("2026-08-19T23:00:00-03:00")), false);
  assert.equal(isOfferActive(desde, new Date("2026-09-30T12:00:00-03:00")), true);
});

test("el rango de fechas por día incluye el día de fin completo", () => {
  const hasta = { price: 1000, ...normalizeOffer({
    price: 1000,
    offerPrice: 800,
    offerRange: { from: null, to: "2026-08-20" },
  }) };

  assert.equal(isOfferActive(hasta, new Date("2026-08-20T23:30:00-03:00")), true);
  assert.equal(isOfferActive(hasta, new Date("2026-08-21T00:30:00-03:00")), false);
});

test("rechaza un rango de fechas invertido", () => {
  assert.match(normalizeOffer({
    price: 1000,
    offerPrice: 800,
    offerRange: {
      from: "2026-08-20T15:00:00-03:00",
      to: "2026-08-20T12:00:00-03:00",
    },
  }).error, /posterior/);
});

test("el horario semanal acota la oferta dentro del rango de fechas", () => {
  const offer = { price: 1000, ...normalizeOffer({
    price: 1000,
    offerPrice: 800,
    offerRange: { from: "2026-08-17", to: "2026-08-23" },
    offerSchedule: {
      enabled: true,
      mon: [{ from: "18:00", to: "20:00" }],
      tue: [{ from: "18:00", to: "20:00" }],
    },
  }) };

  assert.equal(offer.error, undefined);
  assert.equal(offer.isScheduled, true);
  // Lunes 17 a las 19:00 de Buenos Aires: dentro de las fechas y del horario.
  assert.equal(isOfferActive(offer, new Date("2026-08-17T19:00:00-03:00")), true);
  // Mismo día, fuera del horario.
  assert.equal(isOfferActive(offer, new Date("2026-08-17T21:00:00-03:00")), false);
  // Miércoles: día apagado.
  assert.equal(isOfferActive(offer, new Date("2026-08-19T19:00:00-03:00")), false);
  // Lunes siguiente: fuera del rango de fechas.
  assert.equal(isOfferActive(offer, new Date("2026-08-24T19:00:00-03:00")), false);
});

test("un horario semanal sin precio de oferta es un error", () => {
  assert.match(normalizeOffer({
    price: 1000,
    offerPrice: null,
    offerRange: {},
    offerSchedule: { enabled: true, mon: [{ from: "18:00", to: "20:00" }] },
  }).error, /precio de oferta antes de programarla/);
});

test("el precio de oferta debe ser menor al original", () => {
  assert.match(normalizeOffer({ price: 1000, offerPrice: 1000, offerRange: {} }).error, /menor/);
});
