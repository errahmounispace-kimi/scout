import { Hono } from "hono";
import { getDb, indexEntity, now, unindexEntity } from "../db";
import { ulid } from "../ulid";
import { promoteToOpportunity } from "../agent/bindings";
import type { Opportunity } from "../types";

const SOURCES = ["client_need", "market_signal", "discovery", "idea"];
const STAGES = ["signal", "validated", "scoped", "active", "parked", "archived"];

export const opportunities = new Hono();

opportunities.get("/", (c) => {
  const db = getDb();
  const rows = db.query("SELECT * FROM opportunities ORDER BY created_at DESC").all() as Opportunity[];
  return c.json(rows);
});

// POST /api/opportunities/promote must be registered before /:id routes.
opportunities.post("/promote", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { mission_id, artifact_id, title, notes } = body as Record<string, unknown>;
  if (!mission_id || typeof mission_id !== "string") return c.json({ error: "mission_id is required" }, 400);
  if (!title || typeof title !== "string") return c.json({ error: "title is required" }, 400);
  const db = getDb();
  const mission = db.query("SELECT id FROM missions WHERE id = ?").get(mission_id);
  if (!mission) return c.json({ error: "mission not found" }, 404);
  if (artifact_id !== undefined && artifact_id !== null) {
    if (typeof artifact_id !== "string") return c.json({ error: "invalid artifact_id" }, 400);
    const art = db.query("SELECT id FROM artifacts WHERE id = ?").get(artifact_id);
    if (!art) return c.json({ error: "artifact not found" }, 404);
  }
  const opp = promoteToOpportunity(db, {
    missionId: mission_id,
    artifactId: (artifact_id as string | undefined) ?? undefined,
    title,
    notes: typeof notes === "string" ? notes : "",
  });
  return c.json(opp, 201);
});

opportunities.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { title, source, notes, origin_mission_id, origin_artifact_id } = body as Record<string, unknown>;
  if (!title || typeof title !== "string") return c.json({ error: "title is required" }, 400);
  if (!source || typeof source !== "string" || !SOURCES.includes(source)) {
    return c.json({ error: `source must be one of ${SOURCES.join(", ")}` }, 400);
  }
  const db = getDb();
  if (origin_mission_id) {
    const m = db.query("SELECT id FROM missions WHERE id = ?").get(String(origin_mission_id));
    if (!m) return c.json({ error: "origin mission not found" }, 404);
  }
  const id = ulid();
  const ts = now();
  db.query(
    `INSERT INTO opportunities(id, title, source, stage, notes, origin_mission_id, origin_artifact_id, created_at, updated_at)
     VALUES (?, ?, ?, 'signal', ?, ?, ?, ?, ?)`
  ).run(
    id,
    title,
    source,
    typeof notes === "string" ? notes : "",
    origin_mission_id ? String(origin_mission_id) : null,
    origin_artifact_id ? String(origin_artifact_id) : null,
    ts,
    ts
  );
  db.query(
    "INSERT INTO stage_events(id, opportunity_id, from_stage, to_stage, at) VALUES (?, ?, NULL, 'signal', ?)"
  ).run(ulid(), id, ts);
  indexEntity(db, "opportunity", id, title, typeof notes === "string" ? notes : "");
  return c.json(db.query("SELECT * FROM opportunities WHERE id = ?").get(id) as Opportunity, 201);
});

opportunities.get("/:id/stage_events", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const o = db.query("SELECT id FROM opportunities WHERE id = ?").get(id);
  if (!o) return c.json({ error: "opportunity not found" }, 404);
  const events = db
    .query("SELECT * FROM stage_events WHERE opportunity_id = ? ORDER BY at ASC")
    .all(id);
  return c.json(events);
});

opportunities.patch("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const o = db.query("SELECT * FROM opportunities WHERE id = ?").get(id) as Opportunity | null;
  if (!o) return c.json({ error: "opportunity not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { title, notes, stage } = body as Record<string, unknown>;
  if (title !== undefined && (typeof title !== "string" || !title)) return c.json({ error: "invalid title" }, 400);
  if (notes !== undefined && typeof notes !== "string") return c.json({ error: "invalid notes" }, 400);
  if (stage !== undefined && (typeof stage !== "string" || !STAGES.includes(stage))) {
    return c.json({ error: `stage must be one of ${STAGES.join(", ")}` }, 400);
  }
  const nt = (title as string | undefined) ?? o.title;
  const nn = (notes as string | undefined) ?? o.notes;
  const ns = (stage as string | undefined) ?? o.stage;
  const ts = now();
  db.query("UPDATE opportunities SET title = ?, notes = ?, stage = ?, updated_at = ? WHERE id = ?").run(
    nt, nn, ns, ts, id
  );
  if (ns !== o.stage) {
    db.query(
      "INSERT INTO stage_events(id, opportunity_id, from_stage, to_stage, at) VALUES (?, ?, ?, ?, ?)"
    ).run(ulid(), id, o.stage, ns, ts);
  }
  indexEntity(db, "opportunity", id, nt, nn);
  return c.json(db.query("SELECT * FROM opportunities WHERE id = ?").get(id) as Opportunity);
});

opportunities.delete("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const o = db.query("SELECT id FROM opportunities WHERE id = ?").get(id);
  if (!o) return c.json({ error: "opportunity not found" }, 404);
  db.query("DELETE FROM stage_events WHERE opportunity_id = ?").run(id);
  db.query("DELETE FROM opportunities WHERE id = ?").run(id);
  unindexEntity(db, "opportunity", id);
  return c.body(null, 204);
});
