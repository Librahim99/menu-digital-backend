const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const MIGRATIONS = path.join(__dirname, "..", "src", "orders", "db", "migrations");
const FILE = "004_pagos_mercado_pago.sql";

// Sin SQL lo comentado: los encabezados mencionan cosas como "no se borra".
const readSql = () =>
  fs.readFileSync(path.join(MIGRATIONS, FILE), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

test("la migración 004 existe y sigue a la 003 en el orden de ejecución", () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes(FILE));
  assert.ok(files.indexOf(FILE) > files.indexOf("003_comandas.sql"));
});

test("la migración 004 es solo aditiva", () => {
  const sql = readSql();
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bDROP\s+COLUMN\b/i);
  assert.doesNotMatch(sql, /\bRENAME\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+orders\b/i);
});

test("toda tabla y columna nueva es idempotente (IF NOT EXISTS)", () => {
  const sql = readSql();
  const creates = sql.match(/CREATE\s+TABLE\b[^(]*/gi) || [];
  assert.ok(creates.length >= 5);
  for (const stmt of creates) assert.match(stmt, /IF\s+NOT\s+EXISTS/i, stmt);
  const alters = sql.match(/ALTER\s+TABLE\s+orders\s+ADD\s+COLUMN\b[^;]*/gi) || [];
  assert.ok(alters.length >= 2);
  for (const stmt of alters) assert.match(stmt, /IF\s+NOT\s+EXISTS/i, stmt);
});

test("el pago va separado del estado del pedido y no toca los estados existentes", () => {
  const sql = readSql();
  assert.match(sql, /payment_status[\s\S]*NOT_REQUIRED[\s\S]*PENDING[\s\S]*APPROVED[\s\S]*REJECTED[\s\S]*REFUNDED[\s\S]*PARTIALLY_REFUNDED/);
  assert.doesNotMatch(sql, /orders_status_check/i);
});

test("la migración 004 protege contra pagos duplicados y cruces entre negocios", () => {
  const sql = readSql();
  assert.match(sql, /order_online_payments_mp_payment_uniq[\s\S]*?\(mp_payment_id\)/);
  assert.match(sql, /order_mp_connections_one_active_per_owner/);
  assert.match(sql, /order_mp_connections_one_active_per_mp_user/);
  assert.match(sql, /idempotency_key\s+uuid\s+NOT NULL UNIQUE/i);
  assert.match(sql, /event_key\s+text\s+NOT NULL UNIQUE/i);
});

test("los tokens se guardan cifrados y los históricos no se pueden borrar", () => {
  const sql = readSql();
  assert.match(sql, /access_token_enc/);
  assert.doesNotMatch(sql, /\baccess_token\s+text\b/i);
  assert.match(sql, /order_mp_connections', 'order_online_payments', 'order_refunds/);
  assert.match(sql, /orders_prevent_delete\(\)/);
});
