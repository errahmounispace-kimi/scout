import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { artifactDir, getDb } from "../db";
import {
  artifactContentType,
  ArtifactValidationError,
  createArtifact,
  updateArtifact,
} from "../agent/bindings";
import type { Artifact, Mission } from "../types";

const KINDS = ["mindmap", "explainer", "brief", "roadmap", "quiz"];

// Mounted at /api/artifacts
export const artifacts = new Hono();

artifacts.get("/:id", (c) => {
  const db = getDb();
  const a = db.query("SELECT * FROM artifacts WHERE id = ?").get(c.req.param("id")) as Artifact | null;
  if (!a) return c.json({ error: "artifact not found" }, 404);
  return c.json(a);
});

artifacts.get("/:id/body", (c) => {
  const db = getDb();
  const a = db.query("SELECT * FROM artifacts WHERE id = ?").get(c.req.param("id")) as Artifact | null;
  if (!a) return c.json({ error: "artifact not found" }, 404);
  let body: string;
  try {
    body = readFileSync(join(artifactDir(), a.body_ref), "utf8");
  } catch {
    return c.json({ error: "artifact body missing" }, 404);
  }
  return new Response(body, {
    headers: {
      "content-type": `${artifactContentType(a.kind)}; charset=utf-8`,
      "x-content-type-options": "nosniff",
    },
  });
});

artifacts.patch("/:id", async (c) => {
  const db = getDb();
  const a = db.query("SELECT * FROM artifacts WHERE id = ?").get(c.req.param("id")) as Artifact | null;
  if (!a) return c.json({ error: "artifact not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { title, body: newBody } = body as Record<string, unknown>;
  if (title !== undefined && (typeof title !== "string" || !title)) return c.json({ error: "invalid title" }, 400);
  try {
    const updated = updateArtifact(db, a, { title: title as string | undefined, body: newBody });
    return c.json(updated);
  } catch (e) {
    if (e instanceof ArtifactValidationError) return c.json({ error: e.message }, 422);
    throw e;
  }
});

// Mounted at /api/missions — POST /api/missions/:id/artifacts
export const missionArtifacts = new Hono();

missionArtifacts.post("/:id/artifacts", async (c) => {
  const db = getDb();
  const missionId = c.req.param("id");
  const m = db.query("SELECT * FROM missions WHERE id = ?").get(missionId) as Mission | null;
  if (!m) return c.json({ error: "mission not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { kind, title, body: artifactBody } = body as Record<string, unknown>;
  if (!kind || typeof kind !== "string" || !KINDS.includes(kind)) {
    return c.json({ error: `kind must be one of ${KINDS.join(", ")}` }, 400);
  }
  if (!title || typeof title !== "string") return c.json({ error: "title is required" }, 400);
  if (artifactBody === undefined) return c.json({ error: "body is required" }, 400);
  try {
    const a = createArtifact(db, {
      missionId,
      kind,
      title,
      body: artifactBody,
      createdBy: "user",
    });
    return c.json(a, 201);
  } catch (e) {
    if (e instanceof ArtifactValidationError) return c.json({ error: e.message }, 422);
    throw e;
  }
});
