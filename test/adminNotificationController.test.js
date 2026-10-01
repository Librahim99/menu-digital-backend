const test = require("node:test");
const assert = require("node:assert/strict");
const AdminNotification = require("../src/models/AdminNotification");
const User = require("../src/models/User");
const AdminPushToken = require("../src/models/AdminPushToken");
const {
  listNotifications,
  openNotification,
  updateNotification,
  deleteNotification,
  bulkUpdateNotifications,
  markEventRead,
} = require("../src/controllers/adminNotificationController");
const { notifyAdmins } = require("../src/services/adminPushService");

const ADMIN_ID = "64f000000000000000000001";
const NOTIF_ID = "64f000000000000000000101";

function response() {
  return {
    statusCode: 200,
    body: null,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

const lean = (value) => ({ lean: async () => value });

const notificationDoc = (overrides = {}) => ({
  _id: NOTIF_ID,
  eventID: "evt-1",
  type: "payment",
  title: "💰 Pago aprobado",
  body: "cliente · pro",
  url: "/admin/payments",
  readAt: null,
  archivedAt: null,
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
  ...overrides,
});

test("listNotifications filtra por el admin logueado, bandeja y estado", async (t) => {
  let findFilter;
  let skipped;
  let limited;
  const countFilters = [];

  t.mock.method(AdminNotification, "find", (filter) => {
    findFilter = filter;
    return {
      sort() { return this; },
      skip(value) { skipped = value; return this; },
      limit(value) { limited = value; return this; },
      lean: async () => [notificationDoc()],
    };
  });
  t.mock.method(AdminNotification, "countDocuments", async (filter) => {
    countFilters.push(filter);
    return 41;
  });

  const res = response();
  await listNotifications({
    user: { _id: ADMIN_ID },
    query: { box: "inbox", status: "unread", page: "3", limit: "20" },
  }, res);

  assert.deepEqual(findFilter, { userID: ADMIN_ID, archivedAt: null, readAt: null });
  assert.equal(skipped, 40);
  assert.equal(limited, 20);
  assert.equal(res.body.notifications[0].id, NOTIF_ID);
  assert.equal(res.body.notifications[0].read, false);
  assert.equal(res.body.pagination.page, 3);
  assert.ok(countFilters.every((filter) => filter.userID === ADMIN_ID));
});

test("listNotifications muestra las archivadas y topea el limit", async (t) => {
  let findFilter;
  let limited;
  t.mock.method(AdminNotification, "find", (filter) => {
    findFilter = filter;
    return {
      sort() { return this; },
      skip() { return this; },
      limit(value) { limited = value; return this; },
      lean: async () => [],
    };
  });
  t.mock.method(AdminNotification, "countDocuments", async () => 0);

  const res = response();
  await listNotifications({ user: { _id: ADMIN_ID }, query: { box: "archived", limit: "5000" } }, res);

  assert.deepEqual(findFilter, { userID: ADMIN_ID, archivedAt: { $ne: null } });
  assert.equal(limited, 100);
});

test("openNotification la marca como leída solo dentro de las del admin", async (t) => {
  let filter;
  let update;
  t.mock.method(AdminNotification, "findOneAndUpdate", (query, value) => {
    filter = query;
    update = value;
    return lean(notificationDoc({ readAt: new Date() }));
  });

  const res = response();
  await openNotification({ user: { _id: ADMIN_ID }, params: { id: NOTIF_ID } }, res);

  assert.deepEqual(filter, { _id: NOTIF_ID, userID: ADMIN_ID });
  // Pipeline: conserva el readAt original si ya estaba leída.
  assert.deepEqual(update, [{ $set: { readAt: { $ifNull: ["$readAt", "$$NOW"] } } }]);
  assert.equal(res.body.read, true);
});

test("openNotification responde 404 con un ID inválido o ajeno", async (t) => {
  t.mock.method(AdminNotification, "findOneAndUpdate", () => lean(null));

  const invalid = response();
  await openNotification({ user: { _id: ADMIN_ID }, params: { id: "nope" } }, invalid);
  assert.equal(invalid.statusCode, 404);

  const foreign = response();
  await openNotification({ user: { _id: ADMIN_ID }, params: { id: NOTIF_ID } }, foreign);
  assert.equal(foreign.statusCode, 404);
});

test("updateNotification marca no leída y archiva", async (t) => {
  let update;
  t.mock.method(AdminNotification, "findOneAndUpdate", (query, value) => {
    update = value;
    return lean(notificationDoc({ archivedAt: new Date() }));
  });

  const res = response();
  await updateNotification({
    user: { _id: ADMIN_ID },
    params: { id: NOTIF_ID },
    body: { read: false, archived: true },
  }, res);

  assert.equal(update.$set.readAt, null);
  assert.ok(update.$set.archivedAt instanceof Date);
  assert.equal(res.body.archived, true);
});

test("updateNotification rechaza bodies sin cambios o con tipos raros", async (t) => {
  t.mock.method(AdminNotification, "findOneAndUpdate", () => {
    throw new Error("No debe actualizar");
  });

  for (const body of [{}, { read: "true" }, { archived: 1 }]) {
    const res = response();
    await updateNotification({ user: { _id: ADMIN_ID }, params: { id: NOTIF_ID }, body }, res);
    assert.equal(res.statusCode, 400);
  }
});

test("deleteNotification solo borra la copia del admin logueado", async (t) => {
  let filter;
  t.mock.method(AdminNotification, "deleteOne", async (query) => {
    filter = query;
    return { deletedCount: 1 };
  });

  const res = response();
  await deleteNotification({ user: { _id: ADMIN_ID }, params: { id: NOTIF_ID } }, res);

  assert.deepEqual(filter, { _id: NOTIF_ID, userID: ADMIN_ID });
  assert.equal(res.statusCode, 204);
  assert.ok(res.ended);
});

test("bulkUpdateNotifications archiva la selección y devuelve el contador", async (t) => {
  let filter;
  let update;
  t.mock.method(AdminNotification, "updateMany", async (query, value) => {
    filter = query;
    update = value;
    return { modifiedCount: 2 };
  });
  t.mock.method(AdminNotification, "countDocuments", async () => 4);

  const res = response();
  await bulkUpdateNotifications({
    user: { _id: ADMIN_ID },
    body: { ids: [NOTIF_ID, "64f000000000000000000102"], action: "archive" },
  }, res);

  assert.deepEqual(filter, { _id: { $in: [NOTIF_ID, "64f000000000000000000102"] }, userID: ADMIN_ID });
  assert.ok(update.$set.archivedAt instanceof Date);
  assert.deepEqual(res.body, { affected: 2, unreadCount: 4 });
});

test("bulkUpdateNotifications valida acción e IDs", async (t) => {
  t.mock.method(AdminNotification, "updateMany", async () => {
    throw new Error("No debe actualizar");
  });

  const cases = [
    { ids: [NOTIF_ID], action: "explode" },
    { ids: [], action: "read" },
    { ids: ["no-es-id"], action: "read" },
    { ids: [{ $gt: "" }], action: "delete" },
  ];
  for (const body of cases) {
    const res = response();
    await bulkUpdateNotifications({ user: { _id: ADMIN_ID }, body }, res);
    assert.equal(res.statusCode, 400);
  }
});

test("markEventRead marca la copia del admin que tocó la push", async (t) => {
  let filter;
  t.mock.method(AdminNotification, "updateOne", async (query) => {
    filter = query;
    return { modifiedCount: 1 };
  });
  t.mock.method(AdminNotification, "countDocuments", async () => 0);

  const res = response();
  await markEventRead({ user: { _id: ADMIN_ID }, params: { eventID: "evt-1" } }, res);

  assert.deepEqual(filter, { eventID: "evt-1", userID: ADMIN_ID, readAt: null });
  assert.deepEqual(res.body, { unreadCount: 0 });
});

test("notifyAdmins guarda una copia por admin aunque no haya Firebase", async (t) => {
  const previous = process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  t.after(() => {
    if (previous !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT = previous;
  });

  const admins = ["64f000000000000000000001", "64f000000000000000000002"];
  let inserted;
  t.mock.method(User, "find", () => ({ distinct: async () => admins }));
  t.mock.method(AdminNotification, "insertMany", async (docs) => {
    inserted = docs;
    return docs;
  });
  t.mock.method(AdminPushToken, "find", () => {
    throw new Error("Sin Firebase no debe buscar tokens");
  });
  t.mock.method(console, "warn", () => {});

  await notifyAdmins({ title: "🆕 Nuevo registro", body: "x", url: "/admin", type: "registration" });

  assert.equal(inserted.length, 2);
  assert.deepEqual(inserted.map((doc) => doc.userID), admins);
  assert.ok(inserted.every((doc) => doc.type === "registration" && doc.url === "/admin"));
  // Mismo eventID para todas las copias de un aviso.
  assert.equal(new Set(inserted.map((doc) => doc.eventID)).size, 1);
});
