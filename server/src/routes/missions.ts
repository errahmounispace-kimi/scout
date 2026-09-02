import { Hono } from "hono";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { artifactDir, getDb, indexEntity, now, unindexEntity } from "../db";
import { ulid } from "../ulid";
import type { Artifact, Bookmark, Mission } from "../types";

const MISSION_TYPES = ["research", "discovery", "learning", "ideation"];
const MISSION_STATUSES = ["active", "paused", "archived"];

export const missions = new Hono();

missions.get("/", (c) => {
  const db = getDb();
  const status = c.req.query("status");
  let rows: Mission[];
  if (status) {
    if (!MISSION_STATUSES.includes(status)) return c.json({ error: "invalid status" }, 400);
    rows = db.query("SELECT * FROM missions WHERE status = ? ORDER BY created_at DESC").all(status) as Mission[];
  } else {
    rows = db.query("SELECT * FROM missions ORDER BY created_at DESC").all() as Mission[];
  }
  return c.json(rows);
});

missions.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { title, type, goal } = body as Record<string, unknown>;
  if (!title || typeof title !== "string") return c.json({ error: "title is required" }, 400);
  if (!type || typeof type !== "string" || !MISSION_TYPES.includes(type)) {
    return c.json({ error: `type must be one of ${MISSION_TYPES.join(", ")}` }, 400);
  }
  const db = getDb();
  const id = ulid();
  const ts = now();
  db.query(
    "INSERT INTO missions(id, title, type, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)"
  ).run(id, title, type, typeof goal === "string" ? goal : "", ts, ts);
  db.query("INSERT INTO chat_threads(id, mission_id, created_at) VALUES (?, ?, ?)").run(ulid(), id, ts);
  indexEntity(db, "mission", id, title, typeof goal === "string" ? goal : "");
  const m = db.query("SELECT * FROM missions WHERE id = ?").get(id) as Mission;
  return c.json(m, 201);
});

missions.get("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const m = db.query("SELECT * FROM missions WHERE id = ?").get(id) as Mission | null;
  if (!m) return c.json({ error: "mission not found" }, 404);
  const bookmarks = db
    .query(
      `SELECT b.* FROM bookmarks b JOIN mission_bookmarks mb ON mb.bookmark_id = b.id
       WHERE mb.mission_id = ? ORDER BY b.created_at DESC`
    )
    .all(id) as Bookmark[];
  const artifacts = db
    .query("SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at DESC")
    .all(id) as Artifact[];
  const thread = db.query("SELECT id FROM chat_threads WHERE mission_id = ?").get(id) as { id: string } | null;
  return c.json({ ...m, bookmarks, artifacts, thread_id: thread?.id ?? null });
});

missions.patch("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const m = db.query("SELECT * FROM missions WHERE id = ?").get(id) as Mission | null;
  if (!m) return c.json({ error: "mission not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { title, goal, status } = body as Record<string, unknown>;
  if (title !== undefined && (typeof title !== "string" || !title)) return c.json({ error: "invalid title" }, 400);
  if (goal !== undefined && typeof goal !== "string") return c.json({ error: "invalid goal" }, 400);
  if (status !== undefined && (typeof status !== "string" || !MISSION_STATUSES.includes(status))) {
    return c.json({ error: `status must be one of ${MISSION_STATUSES.join(", ")}` }, 400);
  }
  const nt = (title as string | undefined) ?? m.title;
  const ng = (goal as string | undefined) ?? m.goal;
  const ns = (status as string | undefined) ?? m.status;
  db.query("UPDATE missions SET title = ?, goal = ?, status = ?, updated_at = ? WHERE id = ?").run(
    nt, ng, ns, now(), id
  );
  indexEntity(db, "mission", id, nt, ng);
  return c.json(db.query("SELECT * FROM missions WHERE id = ?").get(id) as Mission);
});

missions.delete("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const m = db.query("SELECT * FROM missions WHERE id = ?").get(id) as Mission | null;
  if (!m) return c.json({ error: "mission not found" }, 404);
  // hard delete cascade (artifacts & chat have no ON DELETE CASCADE in schema)
  const arts = db.query("SELECT * FROM artifacts WHERE mission_id = ?").all(id) as Artifact[];
  for (const a of arts) {
    unindexEntity(db, "artifact", a.id);
    try { rmSync(join(artifactDir(), a.body_ref)); } catch { /* best effort */ }
  }
  // Null opportunity back-references to this mission and its artifacts before deleting them.
  db.query("UPDATE opportunities SET origin_mission_id = NULL WHERE origin_mission_id = ?").run(id);
  for (const a of arts) {
    db.query("UPDATE opportunities SET origin_artifact_id = NULL WHERE origin_artifact_id = ?").run(a.id);
  }
  db.query("DELETE FROM artifacts WHERE mission_id = ?").run(id);
  const threads = db.query("SELECT id FROM chat_threads WHERE mission_id = ?").all(id) as { id: string }[];
  for (const t of threads) db.query("DELETE FROM chat_messages WHERE thread_id = ?").run(t.id);
  db.query("DELETE FROM chat_threads WHERE mission_id = ?").run(id);
  db.query("DELETE FROM mission_bookmarks WHERE mission_id = ?").run(id);
  db.query("DELETE FROM missions WHERE id = ?").run(id);
  unindexEntity(db, "mission", id);
  return c.body(null, 204);
});
