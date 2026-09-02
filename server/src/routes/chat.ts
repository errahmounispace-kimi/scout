import { Hono } from "hono";
import { getDb, now } from "../db";
import { ulid } from "../ulid";
import { AgentUnavailableError, getRuntime } from "../agent/runtime";
import { createArtifact } from "../agent/bindings";
import type { Artifact, Bookmark, ChatMessage, Mission } from "../types";

// Mounted at /api/missions — /api/missions/:id/chat
export const chat = new Hono();

function getMissionAndThread(db: ReturnType<typeof getDb>, missionId: string) {
  const m = db.query("SELECT * FROM missions WHERE id = ?").get(missionId) as Mission | null;
  if (!m) return { m: null, thread: null };
  const thread = db
    .query("SELECT id FROM chat_threads WHERE mission_id = ?")
    .get(missionId) as { id: string } | null;
  return { m, thread };
}

chat.get("/:id/chat", (c) => {
  const db = getDb();
  const { m, thread } = getMissionAndThread(db, c.req.param("id"));
  if (!m) return c.json({ error: "mission not found" }, 404);
  if (!thread) return c.json({ error: "chat thread not found" }, 404);
  const messages = db
    .query("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY at ASC")
    .all(thread.id) as ChatMessage[];
  return c.json({ thread_id: thread.id, messages });
});

chat.post("/:id/chat", async (c) => {
  const db = getDb();
  const { m, thread } = getMissionAndThread(db, c.req.param("id"));
  if (!m) return c.json({ error: "mission not found" }, 404);
  if (!thread) return c.json({ error: "chat thread not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { content, client_id } = body as Record<string, unknown>;
  if (!content || typeof content !== "string") return c.json({ error: "content is required" }, 400);
  const clientId =
    typeof client_id === "string" && client_id.trim() ? client_id.trim() : null;

  // Persist user message first — user messages are never lost.
  // Idempotency: a retry re-POSTs the same client_id + content; if the thread's most
  // recent user message already matches, skip re-persisting and just run the agent turn.
  let alreadyPersisted = false;
  if (clientId) {
    const lastUser = db
      .query(
        "SELECT content, client_id FROM chat_messages WHERE thread_id = ? AND role = 'user' ORDER BY at DESC, id DESC LIMIT 1"
      )
      .get(thread.id) as { content: string; client_id: string | null } | null;
    alreadyPersisted = !!lastUser && lastUser.client_id === clientId && lastUser.content === content;
  }
  if (!alreadyPersisted) {
    db.query(
      "INSERT INTO chat_messages(id, thread_id, role, content, client_id, artifact_ids, at) VALUES (?, ?, 'user', ?, ?, '[]', ?)"
    ).run(ulid(), thread.id, content, clientId, now());
  }

  const runtime = getRuntime();
  try {
    let sessionId = m.agent_session_id;
    if (!sessionId) {
      sessionId = await runtime.startMissionSession(m);
      db.query("UPDATE missions SET agent_session_id = ?, updated_at = ? WHERE id = ?").run(
        sessionId, now(), m.id
      );
    }
    const bookmarkTitles = (
      db
        .query(
          "SELECT b.title FROM bookmarks b JOIN mission_bookmarks mb ON mb.bookmark_id = b.id WHERE mb.mission_id = ?"
        )
        .all(m.id) as { title: string }[]
    ).map((r) => r.title);
    const artifactTitles = (
      db.query("SELECT title FROM artifacts WHERE mission_id = ?").all(m.id) as { title: string }[]
    ).map((r) => r.title);
    const history = (
      db
        .query("SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY at ASC LIMIT 50")
        .all(thread.id) as { role: string; content: string }[]
    );
    const result = await runtime.runTurn(
      sessionId,
      { mission: m, bookmarkTitles, artifactTitles, history },
      content
    );

    const newArtifacts: Artifact[] = [];
    for (const spec of result.newArtifacts ?? []) {
      try {
        newArtifacts.push(
          createArtifact(db, {
            missionId: m.id,
            kind: spec.kind,
            title: spec.title,
            body: spec.body,
            createdBy: "agent",
          })
        );
      } catch {
        // malformed agent artifact output: skip, don't fail the turn
      }
    }
    const msgId = ulid();
    db.query(
      "INSERT INTO chat_messages(id, thread_id, role, content, artifact_ids, at) VALUES (?, ?, 'assistant', ?, ?, ?)"
    ).run(msgId, thread.id, result.reply, JSON.stringify(newArtifacts.map((a) => a.id)), now());
    const message = db.query("SELECT * FROM chat_messages WHERE id = ?").get(msgId) as ChatMessage;
    return c.json({ message, artifacts: newArtifacts });
  } catch (e) {
    if (e instanceof AgentUnavailableError) {
      return c.json({ error: "agent_unavailable" }, 503);
    }
    throw e;
  }
});
