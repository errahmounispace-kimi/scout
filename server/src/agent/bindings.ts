import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { artifactDir, canonicalizeUrl, indexEntity, now } from "../db";
import { ulid } from "../ulid";
import type { Artifact, Bookmark, Mission, Opportunity } from "../types";
import type { Database } from "bun:sqlite";

// ---- Artifact body schemas (per SPEC) ----

export const mindmapSchema = z.object({
  nodes: z.array(
    z.object({ id: z.string(), label: z.string(), note: z.string().optional() })
  ),
  edges: z.array(
    z.object({ from: z.string(), to: z.string(), label: z.string().optional() })
  ),
});

const briefSchema = z.string(); // markdown
const explainerSchema = z
  .string()
  .refine(
    (s) => /^\s*<!doctype html/i.test(s) || /^\s*<html[\s>]/i.test(s),
    "explainer body must start with <!DOCTYPE html or <html"
  );

export class ArtifactValidationError extends Error {
  issues: string;
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
    this.issues = message;
  }
}

/** Validate an artifact body for its kind; returns the string to store. */
export function validateArtifactBody(kind: string, body: unknown): string {
  switch (kind) {
    case "mindmap": {
      const r = mindmapSchema.safeParse(
        typeof body === "string" ? tryJson(body) : body
      );
      if (!r.success) throw new ArtifactValidationError(r.error.issues.map((i) => i.message).join("; "));
      return JSON.stringify(r.data);
    }
    case "brief": {
      const r = briefSchema.safeParse(body);
      if (!r.success) throw new ArtifactValidationError("brief body must be a markdown string");
      return r.data;
    }
    case "explainer": {
      const r = explainerSchema.safeParse(body);
      if (!r.success) throw new ArtifactValidationError(r.error.issues.map((i) => i.message).join("; "));
      return r.data;
    }
    case "roadmap":
    case "quiz": {
      // SPEC defines no zod schema for these kinds; accept string or JSON object.
      if (typeof body === "string") return body;
      if (body && typeof body === "object") return JSON.stringify(body);
      throw new ArtifactValidationError(`${kind} body must be a string or object`);
    }
    default:
      throw new ArtifactValidationError(`unknown artifact kind: ${kind}`);
  }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function artifactExt(kind: string): string {
  switch (kind) {
    case "mindmap":
      return ".json";
    case "explainer":
      return ".html";
    case "brief":
      return ".md";
    default:
      return ".json";
  }
}

export function artifactContentType(kind: string): string {
  switch (kind) {
    case "mindmap":
      return "application/json";
    case "brief":
      return "text/markdown";
    case "explainer":
      return "text/html";
    default:
      return "application/json";
  }
}

// ---- Bindings: server-side functions agents (and routes) can call ----

export function createArtifact(
  db: Database,
  input: {
    missionId: string;
    kind: string;
    title: string;
    body: unknown;
    createdBy?: "agent" | "user";
  }
): Artifact {
  if (!input.title || typeof input.title !== "string") {
    throw new ArtifactValidationError("artifact title is required");
  }
  const stored = validateArtifactBody(input.kind, input.body); // validate BEFORE insert
  const id = ulid();
  const ref = `${id}-v1${artifactExt(input.kind)}`;
  writeFileSync(join(artifactDir(), ref), stored, "utf8");
  const ts = now();
  db.query(
    `INSERT INTO artifacts(id, mission_id, kind, title, version, status, body_ref, created_by, created_at)
     VALUES (?, ?, ?, ?, 1, 'ready', ?, ?, ?)`
  ).run(id, input.missionId, input.kind, input.title, ref, input.createdBy || "agent", ts);
  indexEntity(db, "artifact", id, input.title, stored);
  return db.query("SELECT * FROM artifacts WHERE id = ?").get(id) as Artifact;
}

export function updateArtifact(
  db: Database,
  artifact: Artifact,
  input: { title?: string; body?: unknown }
): Artifact {
  const title = input.title ?? artifact.title;
  let version = artifact.version;
  let stored: string | null = null;
  if (input.body !== undefined) {
    stored = validateArtifactBody(artifact.kind, input.body);
    version = artifact.version + 1;
  }
  const ref =
    stored !== null
      ? `${artifact.id}-v${version}${artifactExt(artifact.kind)}`
      : artifact.body_ref;
  if (stored !== null) writeFileSync(join(artifactDir(), ref), stored, "utf8");
  db.query(
    "UPDATE artifacts SET title = ?, version = ?, body_ref = ? WHERE id = ?"
  ).run(title, version, ref, artifact.id);
  // Re-index FTS whenever the title OR the body changed (title-only renames must stay searchable).
  if (stored !== null || title !== artifact.title) {
    let bodyText = stored;
    if (bodyText === null) {
      try {
        bodyText = readFileSync(join(artifactDir(), ref), "utf8");
      } catch {
        bodyText = "";
      }
    }
    indexEntity(db, "artifact", artifact.id, title, bodyText);
  }
  return db.query("SELECT * FROM artifacts WHERE id = ?").get(artifact.id) as Artifact;
}

export function saveBookmark(
  db: Database,
  input: {
    url: string;
    title?: string;
    note?: string;
    capturedVia?: "extension" | "agent" | "manual";
    missionId?: string;
  }
): Bookmark {
  const id = ulid();
  const ts = now();
  const canonical = canonicalizeUrl(input.url);
  db.query(
    `INSERT INTO bookmarks(id, url, canonical_url, title, note, captured_via, triage_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    input.url,
    canonical,
    input.title || input.url,
    input.note || "",
    input.capturedVia || "agent",
    ts
  );
  indexEntity(db, "bookmark", id, input.title || input.url, `${input.url} ${input.note || ""}`);
  if (input.missionId) linkBookmarkToMission(db, input.missionId, id, "agent");
  return db.query("SELECT * FROM bookmarks WHERE id = ?").get(id) as Bookmark;
}

export function linkBookmarkToMission(
  db: Database,
  missionId: string,
  bookmarkId: string,
  linkedBy: "user" | "agent" = "agent"
): void {
  db.query(
    `INSERT OR IGNORE INTO mission_bookmarks(mission_id, bookmark_id, linked_by) VALUES (?, ?, ?)`
  ).run(missionId, bookmarkId, linkedBy);
}

export function suggestTags(db: Database, bookmarkId: string): string[] {
  const b = db.query("SELECT * FROM bookmarks WHERE id = ?").get(bookmarkId) as Bookmark | null;
  if (!b) return [];
  let host = "";
  try {
    host = new URL(b.url).host.toLowerCase();
  } catch {
    /* ignore */
  }
  return [...new Set(
    `${host} ${b.title}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !["www", "com", "org", "net", "io", "the", "and"].includes(w))
  )].slice(0, 4);
}

export function promoteToOpportunity(
  db: Database,
  input: { missionId: string; artifactId?: string; title: string; notes?: string }
): Opportunity {
  const id = ulid();
  const ts = now();
  db.query(
    `INSERT INTO opportunities(id, title, source, stage, notes, origin_mission_id, origin_artifact_id, created_at, updated_at)
     VALUES (?, ?, 'discovery', 'signal', ?, ?, ?, ?, ?)`
  ).run(id, input.title, input.notes || "", input.missionId, input.artifactId || null, ts, ts);
  db.query(
    "INSERT INTO stage_events(id, opportunity_id, from_stage, to_stage, at) VALUES (?, ?, NULL, 'signal', ?)"
  ).run(ulid(), id, ts);
  indexEntity(db, "opportunity", id, input.title, input.notes || "");
  return db.query("SELECT * FROM opportunities WHERE id = ?").get(id) as Opportunity;
}
