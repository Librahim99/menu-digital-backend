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

test("rechaza períodos incompletos o invertidos", () => {
  assert.match(normalizeOffer({
    price: 1000,
    offerPrice: 800,
    offerRange: { from: "2026-08-20T12:00:00-03:00", to: null },
  }).error, /inicio y de fin/);

  assert.match(normalizeOffer({
    price: 1000,
    offerPrice: 800,
    offerRange: {
      from: "2026-08-20T15:00:00-03:00",
      to: "2026-08-20T12:00:00-03:00",
    },
  }).error, /posterior/);
});

test("el precio de oferta debe ser menor al original", () => {
  assert.match(normalizeOffer({ price: 1000, offerPrice: 1000, offerRange: {} }).error, /menor/);
});
