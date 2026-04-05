/**
 * db.js — SQLite database setup using Node.js built-in node:sqlite
 * Available in Node 22.5+ (no npm package / no native compilation needed).
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'leads.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    niche            TEXT,
    email            TEXT,
    phone            TEXT,
    status           TEXT    NOT NULL DEFAULT 'active',
    lead_limit       INTEGER NOT NULL DEFAULT 50,
    outreach_enabled INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS keyword_packs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    phrase      TEXT    NOT NULL,
    intent      TEXT    NOT NULL DEFAULT 'WARM'
  );

  CREATE TABLE IF NOT EXISTS sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    source_name TEXT    NOT NULL,
    source_type TEXT    NOT NULL DEFAULT 'website',
    source_url  TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    max_leads   INTEGER NOT NULL DEFAULT 25,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    keyword     TEXT,
    content     TEXT,
    source      TEXT,
    intent      TEXT    NOT NULL DEFAULT 'COLD',
    status      TEXT    NOT NULL DEFAULT 'new',
    assigned_to TEXT,
    ai_reply    TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Safe migrations for existing databases
const migrations = [
  "ALTER TABLE clients ADD COLUMN lead_limit INTEGER NOT NULL DEFAULT 50",
  "ALTER TABLE clients ADD COLUMN outreach_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE sources ADD COLUMN max_leads INTEGER NOT NULL DEFAULT 25",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

console.log('[DB] SQLite ready →', DB_PATH);

module.exports = db;
