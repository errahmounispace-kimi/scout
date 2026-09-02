import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { canonicalizeUrl, getDb, indexEntity, now, unindexEntity } from "../db";
import { ulid } from "../ulid";
import { enqueueTriage } from "../agent/triage";
import type { Bookmark } from "../types";

export const bookmarks = new Hono();

const TRIAGE_STATUSES = ["pending", "suggested", "confirmed", "skipped"];

function tagId(db: Database, name: string): string {
  const n = name.trim();
  const row = db.query("SELECT id FROM tags WHERE name = ?").get(n) as { id: string } | null;
  if (row) return row.id;
  const id = ulid();
  db.query("INSERT INTO tags(id, name) VALUES (?, ?)").run(id, n);
  return id;
}

function listId(db: Database, name: string): string {
  const n = name.trim();
  const row = db.query("SELECT id FROM lists WHERE name = ?").get(n) as { id: string } | null;
  if (row) return row.id;
  const id = ulid();
  db.query("INSERT INTO lists(id, name) VALUES (?, ?)").run(id, n);
  return id;
}

function addTags(db: Database, bookmarkId: string, tags: string[], source: "user" | "agent" = "user") {
  for (const t of tags) {
    if (!t || typeof t !== "string" || !t.trim()) continue;
    db.query(
      "INSERT OR IGNORE INTO bookmark_tags(bookmark_id, tag_id, source) VALUES (?, ?, ?)"
    ).run(bookmarkId, tagId(db, t), source);
  }
}

function addLists(db: Database, bookmarkId: string, listNames: string[]) {
  for (const l of listNames) {
    if (!l || typeof l !== "string" || !l.trim()) continue;
    db.query("INSERT OR IGNORE INTO list_items(list_id, bookmark_id) VALUES (?, ?)").run(
      listId(db, l),
      bookmarkId
    );
  }
}

function addMissions(db: Database, bookmarkId: string, missionIds: string[], linkedBy: "user" | "agent" = "user") {
  for (const m of missionIds) {
    if (!m || typeof m !== "string") continue;
    const exists = db.query("SELECT id FROM missions WHERE id = ?").get(m);
    if (!exists) continue;
    db.query(
      "INSERT OR IGNORE INTO mission_bookmarks(mission_id, bookmark_id, linked_by) VALUES (?, ?, ?)"
    ).run(m, bookmarkId, linkedBy);
  }
}

function setTags(db: Database, bookmarkId: string, tags: string[], source: "user" | "agent" = "user") {
  db.query("DELETE FROM bookmark_tags WHERE bookmark_id = ?").run(bookmarkId);
  addTags(db, bookmarkId, tags, source);
}

function setLists(db: Database, bookmarkId: string, listNames: string[]) {
  db.query("DELETE FROM list_items WHERE bookmark_id = ?").run(bookmarkId);
  addLists(db, bookmarkId, listNames);
}

function setMissions(db: Database, bookmarkId: string, missionIds: string[], linkedBy: "user" | "agent" = "user") {
  db.query("DELETE FROM mission_bookmarks WHERE bookmark_id = ?").run(bookmarkId);
  addMissions(db, bookmarkId, missionIds, linkedBy);
}

export function decorateBookmark(db: Database, b: Bookmark) {
  const tags = (
    db
      .query(
        "SELECT t.name FROM tags t JOIN bookmark_tags bt ON bt.tag_id = t.id WHERE bt.bookmark_id = ? ORDER BY t.name"
      )
      .all(b.id) as { name: string }[]
  ).map((r) => r.name);
  const lists = (
    db
      .query(
        "SELECT l.name FROM lists l JOIN list_items li ON li.list_id = l.id WHERE li.bookmark_id = ? ORDER BY l.name"
      )
      .all(b.id) as { name: string }[]
  ).map((r) => r.name);
  const mission_ids = (
    db.query("SELECT mission_id FROM mission_bookmarks WHERE bookmark_id = ?").all(b.id) as {
      mission_id: string;
    }[]
  ).map((r) => r.mission_id);
  return { ...b, tags, lists, mission_ids };
}

bookmarks.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { url, title, note, tags, list, mission_ids, captured_via } = body as Record<string, unknown>;
  if (!url || typeof url !== "string") return c.json({ error: "url is required" }, 400);
  try {
    new URL(url);
  } catch {
    return c.json({ error: "invalid url" }, 400);
  }
  const db = getDb();
  const canonical = canonicalizeUrl(url);
  const existing = db
    .query("SELECT * FROM bookmarks WHERE canonical_url = ?")
    .get(canonical) as Bookmark | null;
  if (existing) {
    // Duplicate: merge note (keep newest); tag/list/mission links are additive —
    // re-capturing a page must never wipe existing links.
    if (typeof note === "string" && note) {
      db.query("UPDATE bookmarks SET note = ? WHERE id = ?").run(note, existing.id);
    }
    if (Array.isArray(tags)) addTags(db, existing.id, tags as string[]);
    if (typeof list === "string" && list.trim()) addLists(db, existing.id, [list]);
    if (Array.isArray(mission_ids)) addMissions(db, existing.id, mission_ids as string[]);
    const merged = db.query("SELECT * FROM bookmarks WHERE id = ?").get(existing.id) as Bookmark;
    indexEntity(db, "bookmark", merged.id, merged.title, `${merged.url} ${merged.note}`);
    return c.json({ duplicate: true, bookmark: decorateBookmark(db, merged) }, 200);
  }

  const id = ulid();
  const ts = now();
  const via =
    captured_via === "agent" || captured_via === "manual" || captured_via === "extension"
      ? captured_via
      : "extension";
  db.query(
    `INSERT INTO bookmarks(id, url, canonical_url, title, note, captured_via, triage_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(id, url, canonical, typeof title === "string" && title ? title : url, typeof note === "string" ? note : "", via, ts);
  if (Array.isArray(tags)) setTags(db, id, tags as string[]);
  setLists(db, id, [typeof list === "string" && list.trim() ? list : "inbox"]);
  if (Array.isArray(mission_ids)) setMissions(db, id, mission_ids as string[]);
  const b = db.query("SELECT * FROM bookmarks WHERE id = ?").get(id) as Bookmark;
  indexEntity(db, "bookmark", id, b.title, `${b.url} ${b.note}`);
  enqueueTriage(db, id);
  return c.json(decorateBookmark(db, b), 201);
});

bookmarks.get("/", (c) => {
  const db = getDb();
  const { list, tag, triage_status, q } = c.req.query() as Record<string, string | undefined>;
  let rows = db.query("SELECT * FROM bookmarks ORDER BY created_at DESC").all() as Bookmark[];
  if (triage_status) {
    if (!TRIAGE_STATUSES.includes(triage_status)) return c.json({ error: "invalid triage_status" }, 400);
    rows = rows.filter((b) => b.triage_status === triage_status);
  }
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter(
      (b) => b.title.toLowerCase().includes(needle) || b.url.toLowerCase().includes(needle) || b.note.toLowerCase().includes(needle)
    );
  }
  let decorated = rows.map((b) => decorateBookmark(db, b));
  if (list) decorated = decorated.filter((b) => b.lists.includes(list));
  if (tag) decorated = decorated.filter((b) => b.tags.includes(tag));
  return c.json(decorated);
});

bookmarks.patch("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const b = db.query("SELECT * FROM bookmarks WHERE id = ?").get(id) as Bookmark | null;
  if (!b) return c.json({ error: "bookmark not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { title, note, tags, list, mission_ids, triage_status } = body as Record<string, unknown>;
  if (title !== undefined && (typeof title !== "string" || !title)) return c.json({ error: "invalid title" }, 400);
  if (note !== undefined && typeof note !== "string") return c.json({ error: "invalid note" }, 400);
  if (tags !== undefined && !Array.isArray(tags)) return c.json({ error: "tags must be an array" }, 400);
  if (list !== undefined && typeof list !== "string") return c.json({ error: "list must be a string" }, 400);
  if (mission_ids !== undefined && !Array.isArray(mission_ids)) return c.json({ error: "mission_ids must be an array" }, 400);
  if (triage_status !== undefined && (typeof triage_status !== "string" || !TRIAGE_STATUSES.includes(triage_status))) {
    return c.json({ error: `triage_status must be one of ${TRIAGE_STATUSES.join(", ")}` }, 400);
  }

  const edited =
    title !== undefined || note !== undefined || tags !== undefined ||
    list !== undefined || mission_ids !== undefined;
  let newStatus = b.triage_status;
  if (triage_status !== undefined) newStatus = triage_status as Bookmark["triage_status"];
  else if (edited && b.triage_status === "suggested") newStatus = "confirmed";

  db.query("UPDATE bookmarks SET title = ?, note = ?, triage_status = ? WHERE id = ?").run(
    (title as string | undefined) ?? b.title,
    (note as string | undefined) ?? b.note,
    newStatus,
    id
  );
  if (Array.isArray(tags)) setTags(db, id, tags as string[]);
  if (typeof list === "string") setLists(db, id, list.trim() ? [list] : []);
  if (Array.isArray(mission_ids)) setMissions(db, id, mission_ids as string[]);
  const updated = db.query("SELECT * FROM bookmarks WHERE id = ?").get(id) as Bookmark;
  indexEntity(db, "bookmark", id, updated.title, `${updated.url} ${updated.note}`);
  return c.json(decorateBookmark(db, updated));
});

bookmarks.delete("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const b = db.query("SELECT id FROM bookmarks WHERE id = ?").get(id);
  if (!b) return c.json({ error: "bookmark not found" }, 404);
  db.query("DELETE FROM bookmark_tags WHERE bookmark_id = ?").run(id);
  db.query("DELETE FROM list_items WHERE bookmark_id = ?").run(id);
  db.query("DELETE FROM mission_bookmarks WHERE bookmark_id = ?").run(id);
  db.query("DELETE FROM bookmarks WHERE id = ?").run(id);
  unindexEntity(db, "bookmark", id);
  return c.body(null, 204);
});

// Tags & lists with counts
export const taxonomies = new Hono();

taxonomies.get("/tags", (c) => {
  const db = getDb();
  const rows = db
    .query(
      `SELECT t.name AS name, COUNT(bt.bookmark_id) AS count
       FROM tags t LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
       GROUP BY t.id ORDER BY t.name`
    )
    .all();
  return c.json(rows);
});

taxonomies.get("/lists", (c) => {
  const db = getDb();
  const rows = db
    .query(
      `SELECT l.name AS name, COUNT(li.bookmark_id) AS count
       FROM lists l LEFT JOIN list_items li ON li.list_id = l.id
       GROUP BY l.id ORDER BY l.name`
    )
    .all();
  return c.json(rows);
});
