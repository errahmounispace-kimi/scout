import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "./ulid";

const SCHEMA = new URL("./schema.sql", import.meta.url);

let db: Database | null = null;

export function defaultDbPath(): string {
  return process.env.DB_PATH || "./data/scout.db";
}

export function artifactDir(): string {
  const dir = process.env.ARTIFACT_DIR || "./data/artifacts";
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Open (or re-open) the database and run migrations. Re-initializable for tests. */
export function initDb(path?: string): Database {
  if (db) db.close(false);
  const p = path || defaultDbPath();
  if (p !== ":memory:") mkdirSync(dirname(resolve(p)), { recursive: true });
  db = new Database(p, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function getDb(): Database {
  if (!db) initDb();
  return db!;
}

function migrate(d: Database): void {
  const ddl = readFileSync(fileURLToPath(SCHEMA), "utf8");
  d.exec(ddl);
  // Defensive migration for existing DBs created before chat_messages.client_id.
  const chatCols = d.query("PRAGMA table_info(chat_messages)").all() as { name: string }[];
  if (!chatCols.some((c) => c.name === "client_id")) {
    d.exec("ALTER TABLE chat_messages ADD COLUMN client_id TEXT");
  }
  // seed default list
  const row = d.query("SELECT id FROM lists WHERE name = 'inbox'").get();
  if (!row) {
    d.query("INSERT INTO lists(id, name) VALUES (?, ?)").run(ulid(), "inbox");
  }
}

export function now(): string {
  return new Date().toISOString();
}

// ---- FTS5 search_index maintenance (explicit calls on writes) ----

export function indexEntity(
  d: Database,
  kind: "mission" | "opportunity" | "artifact" | "bookmark",
  entityId: string,
  title: string,
  body: string
): void {
  d.query("DELETE FROM search_index WHERE kind = ? AND entity_id = ?").run(kind, entityId);
  d.query(
    "INSERT INTO search_index(kind, entity_id, title, body) VALUES (?, ?, ?, ?)"
  ).run(kind, entityId, title, body);
}

export function unindexEntity(d: Database, kind: string, entityId: string): void {
  d.query("DELETE FROM search_index WHERE kind = ? AND entity_id = ?").run(kind, entityId);
}

// ---- URL canonicalization ----

const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^igshid$/i,
  /^ref_?$/i,
  /^_ga$/i,
];

export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.protocol = u.protocol.toLowerCase();
    u.host = u.host.toLowerCase();
    const params = [...u.searchParams.entries()].filter(
      ([k]) => !TRACKING_PARAMS.some((re) => re.test(k))
    );
    params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = "";
    for (const [k, v] of params) u.searchParams.append(k, v);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}
