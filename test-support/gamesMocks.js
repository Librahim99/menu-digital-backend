"use strict";

// Datos de mentira para probar los juegos sin MongoDB: el local, su carta y su
// configuración guardada. Usa queryMock (aplica filtros y proyecciones de
// verdad) para los modelos que el módulo consulta, y un Map en memoria para
// GameSettings, que es lo único que el módulo escribe.

const mongoose = require("mongoose");
const Plan = require("../src/models/Plan");
const User = require("../src/models/User");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const GameSettings = require("../src/models/GameSettings");
const { INITIAL_PLANS } = require("../src/services/planCatalog");
const { mockQuery } = require("./queryMock");

const oid = () => new mongoose.Types.ObjectId();

const venueUser = (fields = {}) => new User({
  _id: oid(),
  username: `local-${Math.random().toString(36).slice(2, 8)}`,
  password: "no-debe-leerse-123",
  slug: "bar-de-prueba",
  active: true,
  subscription: "pro",
  subscriptionExpiresAt: new Date("2099-01-01T00:00:00Z"),
  ...fields,
});

/**
 * Carta chica y variada: dos categorías sueltas y una dentro de una sección.
 * @returns {{ menus, items, ids }} documentos lean + ids por nombre
 */
const sampleMenu = (userID) => {
  const section = { _id: oid(), userID, title: "Bebidas", section: true, sectionID: null, hidden: false, order: 3 };
  const pizzas = { _id: oid(), userID, title: "Pizzas", section: false, sectionID: null, hidden: false, order: 1 };
  const postres = { _id: oid(), userID, title: "Postres", section: false, sectionID: null, hidden: false, order: 2 };
  const cervezas = { _id: oid(), userID, title: "Cervezas", section: false, sectionID: section._id, hidden: false, order: 1 };
  const item = (menuID, title, price, extra = {}) => ({
    _id: oid(), menuID, title, price, offerPrice: null, description: "", options: {}, available: true, hidden: false, order: 0, ...extra,
  });
  const items = [
    item(pizzas._id, "Muzzarella", 9000, { description: "Salsa de tomate, queso y aceitunas verdes", order: 1 }),
    item(pizzas._id, "Napolitana", 10500, { description: "Con rodajas de tomate fresco y ajo", order: 2 }),
    item(pizzas._id, "Fugazzeta", 11000, { order: 3 }),
    item(postres._id, "Flan", 3000, { description: "Casero, con dulce de leche o crema", order: 1 }),
    item(postres._id, "Helado", null, { options: { "1 bocha": 2000, "2 bochas": 3500 }, order: 2 }),
    item(cervezas._id, "Rubia", 2500, { order: 1 }),
    item(cervezas._id, "Negra", 2800, { order: 2 }),
  ];
  return {
    menus: [section, pizzas, postres, cervezas],
    items,
    ids: {
      categories: { pizzas: String(pizzas._id), postres: String(postres._id), cervezas: String(cervezas._id) },
      items: Object.fromEntries(items.map((entry) => [entry.title, String(entry._id)])),
    },
  };
};

/**
 * Instala los mocks de Mongo para un test.
 * @param {object} t
 * @param {{ users: Array, menus: Array, items: Array }} data
 * @returns {{ store: Map<string, object> }} configuración guardada por userID
 */
const mockGamesDb = (t, { users = [], menus = [], items = [] }) => {
  const store = new Map();
  t.mock.method(Plan, "findOne", async ({ name }) => new Plan(INITIAL_PLANS.find((plan) => plan.name === name)));
  mockQuery(t, User, "findOne", users);
  mockQuery(t, Menu, "find", menus, { hydrate: false });
  mockQuery(t, Item, "find", items, { hydrate: false });
  mockQuery(t, GameSettings, "findOne", (filter) => store.get(String(filter.userID)) ?? null, { hydrate: false });
  t.mock.method(GameSettings, "findOneAndUpdate", async (filter, update) => {
    const doc = { userID: filter.userID, config: JSON.parse(JSON.stringify(update.$set.config)) };
    store.set(String(filter.userID), doc);
    return doc;
  });
  return { store };
};

module.exports = { oid, venueUser, sampleMenu, mockGamesDb };
