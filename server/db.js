import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "data", "painel.sqlite");
mkdirSync(dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pos REAL
  );
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT,
    list_id TEXT,
    due TEXT,
    closed INTEGER NOT NULL DEFAULT 0,
    client TEXT,
    created_at TEXT,
    list_entered_at TEXT,
    description TEXT
  );
  CREATE TABLE IF NOT EXISTS deck_reads (
    url TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS card_members (
    card_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    added_at TEXT,
    PRIMARY KEY (card_id, member_id)
  );
  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    card_id TEXT,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stays (
    card_id TEXT NOT NULL,
    list_name TEXT NOT NULL,
    entered_at TEXT NOT NULL,
    left_at TEXT,
    PRIMARY KEY (card_id, list_name, entered_at)
  );
`);

export function metaGet(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function metaSet(key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

const cardColumns = db.prepare("PRAGMA table_info(cards)").all().map((column) => column.name);
if (!cardColumns.includes("description")) {
  db.exec("ALTER TABLE cards ADD COLUMN description TEXT");
}

export function cardCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM cards").get().n;
}
