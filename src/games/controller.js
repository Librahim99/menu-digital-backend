// Juegos para comensales: lo que consulta la carta pública y lo que configura
// el dueño desde su panel.

const { route } = require("./errors");
const settingsService = require("./settingsService");
const { findVenueBySlug, loadCatalog, hidesPrices } = require("./catalog");
const { LIMITS } = require("./constants");

// Sin juegos: la carta sigue como siempre.
const NO_GAMES = { enabled: false, venueOnly: false, games: [] };

// Juegos habilitados del local, con lo justo para jugar. Nunca da error por
// un local que no existe o no tiene la función: devuelve "sin juegos".
const getPublic = route(async (req, res) => {
  const venue = await findVenueBySlug(req.params.slug);
  if (!venue) return res.json(NO_GAMES);
  const settings = await settingsService.getSettings(venue._id);
  // Sin ninguno encendido no hace falta ir a buscar la carta.
  if (!Object.values(settings.games).some((game) => game.enabled)) return res.json(NO_GAMES);
  const { products } = await loadCatalog(venue);
  res.json(settingsService.toPublic(settings, { products, hidePrices: hidesPrices(venue) }));
});

// Lo que necesita la pantalla de configuración: la configuración actual y la
// carta del local para elegir qué productos y categorías participan.
const settingsPayload = async (user, settings) => {
  const { categories, products } = await loadCatalog(user);
  return {
    settings,
    catalog: {
      categories,
      products: products.map(({ id, title, categoryId, available }) => ({ id, title, categoryId, available })),
    },
    limits: LIMITS,
  };
};

const getSettings = route(async (req, res) => {
  res.json(await settingsPayload(req.user, await settingsService.getSettings(req.user._id)));
});

const updateSettings = route(async (req, res) => {
  res.json(await settingsPayload(req.user, await settingsService.updateSettings(req.user._id, req.body)));
});

module.exports = { getPublic, getSettings, updateSettings };
