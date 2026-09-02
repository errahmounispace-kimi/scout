# Scout — SPEC (Single Source of Truth)

Solo, agent-first mission & opportunity OS. MVP scope (v1.0 Must-Haves): missions, opportunities pipeline, per-mission agent chat (OpenCode), artifacts (mind map, HTML explainer, brief), browser-extension bookmark capture, bookmark library with agent triage, FTS5 search.

Reference PRD: `/mnt/agents/output/Scout-PRD.md` (acceptance criteria there are binding).

## Monorepo layout

```
scout/
  SPEC.md  README.md  .gitignore
  server/      # Bun + Hono backend (TypeScript)
    package.json  tsconfig.json
    src/
      index.ts        # entry: serves API + static web/dist
      db.ts           # bun:sqlite init + migrations
      schema.sql      # DDL (source of truth for DB)
      ulid.ts         # id helper
      routes/         # missions.ts opportunities.ts bookmarks.ts artifacts.ts chat.ts search.ts
      agent/
        runtime.ts    # AgentRuntime interface + factory
        mock.ts       # MockAgentRuntime (dev/tests, no API key needed)
        opencode.ts   # OpenCodeRuntime (talks to `opencode serve` HTTP API)
        bindings.ts   # tool functions agents can call
        triage.ts     # librarian triage logic
    test/             # bun test
  web/         # React 18 + TS + Vite + Tailwind SPA
  extension/   # Manifest V3 (Chrome + Firefox), plain TS built with bun build
```

## Backend (Bun + Hono + bun:sqlite)

- Runtime: Bun ≥1.4. Server: Hono. DB: `bun:sqlite` (WAL mode). No ORM — parameterized SQL only.
- IDs: ULID strings. Timestamps: ISO 8601 UTC.
- Env: `PORT` (default 3000), `DB_PATH` (default `./data/scout.db`), `AGENT_RUNTIME` (`mock`|`opencode`, default `mock`), `OPENCODE_URL` (default `http://localhost:4096`), `ARTIFACT_DIR` (default `./data/artifacts`).
- Production: `server/src/index.ts` serves `web/dist` statically with SPA fallback; CORS enabled for extension (allow all origins on `/api/bookmarks` POST/OPTIONS only).
- Errors: JSON `{ error: string }` with correct 4xx/5xx. Validation per schema below.

### DB schema (schema.sql — implement exactly)

```sql
CREATE TABLE IF NOT EXISTS missions(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('research','discovery','learning','ideation')),
  goal TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
  agent_session_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opportunities(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('client_need','market_signal','discovery','idea')),
  stage TEXT NOT NULL DEFAULT 'signal' CHECK(stage IN ('signal','validated','scoped','active','parked','archived')),
  notes TEXT DEFAULT '',
  origin_mission_id TEXT REFERENCES missions(id),
  origin_artifact_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stage_events(
  id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  from_stage TEXT, to_stage TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts(
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  kind TEXT NOT NULL CHECK(kind IN ('mindmap','explainer','brief','roadmap','quiz')),
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('draft','ready','broken')),
  body_ref TEXT NOT NULL,            -- relative path under ARTIFACT_DIR
  created_by TEXT NOT NULL DEFAULT 'agent' CHECK(created_by IN ('agent','user')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookmarks(
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  canonical_url TEXT,               -- normalized: lowercase host, strip tracking params & trailing slash
  title TEXT NOT NULL,
  note TEXT DEFAULT '',
  captured_via TEXT NOT NULL DEFAULT 'extension' CHECK(captured_via IN ('extension','agent','manual')),
  triage_status TEXT NOT NULL DEFAULT 'pending' CHECK(triage_status IN ('pending','suggested','confirmed','skipped')),
  triage_suggestions TEXT,          -- JSON: {tags:[], list:string, mission_ids:[]} once suggested
  created_at TEXT NOT NULL,
  UNIQUE(canonical_url)
);
CREATE TABLE IF NOT EXISTS tags(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS bookmark_tags(bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','agent')),
  PRIMARY KEY(bookmark_id, tag_id));
CREATE TABLE IF NOT EXISTS lists(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS list_items(list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE, PRIMARY KEY(list_id, bookmark_id));
CREATE TABLE IF NOT EXISTS mission_bookmarks(mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  linked_by TEXT NOT NULL DEFAULT 'user' CHECK(linked_by IN ('user','agent')), PRIMARY KEY(mission_id, bookmark_id));
CREATE TABLE IF NOT EXISTS chat_threads(id TEXT PRIMARY KEY, mission_id TEXT UNIQUE NOT NULL REFERENCES missions(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL,
  client_id TEXT,  -- client-generated idempotency key for user messages (nullable)
  artifact_ids TEXT DEFAULT '[]', at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(kind, entity_id, title, body);
-- search_index.kind IN ('mission','opportunity','artifact','bookmark'); keep updated on writes (insert/update/delete triggers or explicit calls).
```

Default list seeded on first run: `inbox`.

### REST API (all under `/api`, JSON)

Missions:
- `GET /api/missions?status=active` → `Mission[]`
- `POST /api/missions` `{title, type, goal?}` → 201 Mission. Also creates its chat_thread.
- `GET /api/missions/:id` → Mission + `bookmarks: Bookmark[]` + `artifacts: Artifact[]` + `thread_id`
- `PATCH /api/missions/:id` (title/goal/status) → Mission
- `DELETE /api/missions/:id` → 204 (hard delete cascade)

Opportunities:
- `GET /api/opportunities` → Opportunity[] (each with latest stage)
- `POST /api/opportunities` `{title, source, notes?, origin_mission_id?, origin_artifact_id?}` → 201; writes initial stage_event (from_stage null).
- `PATCH /api/opportunities/:id` `{title?, notes?, stage?}` → Opportunity; on stage change writes stage_event.
- `DELETE /api/opportunities/:id` → 204
- `POST /api/opportunities/promote` `{mission_id, artifact_id?, title, notes?}` → 201 Opportunity with source='discovery', stage='signal', origin refs set.

Bookmarks:
- `POST /api/bookmarks` `{url, title?, note?, tags?: string[], list?: string, mission_ids?: string[]}` → 201 Bookmark (+tags/list created if missing, links applied). Duplicate canonical_url → 200 `{duplicate:true, bookmark}` merged note (keep newest). After insert: enqueue triage (async, sets triage_status='suggested' + triage_suggestions).
- `GET /api/bookmarks?list=&tag=&triage_status=&q=` → Bookmark[] with tags[], lists[], mission_ids[]
- `PATCH /api/bookmarks/:id` `{title?, note?, tags?, list?, mission_ids?, triage_status?}` → Bookmark (triage_status='confirmed' when user edits after suggestions)
- `DELETE /api/bookmarks/:id` → 204
- `GET /api/tags` / `GET /api/lists` → string names with counts

Artifacts:
- `GET /api/artifacts/:id` → Artifact meta; `GET /api/artifacts/:id/body` → raw body (mindmap/brief: `application/json` or `text/markdown`; explainer: `text/html`)
- `POST /api/missions/:id/artifacts` `{kind, title, body}` → validates body against kind schema, writes versioned file to ARTIFACT_DIR, 201 Artifact; invalid → 422 `{error}` and a row with status='broken' is NOT written (validate before insert).
- `PATCH /api/artifacts/:id` `{title?, body?}` → new version (version+1, new file).

Artifact body schemas (validate with zod):
- mindmap: `{nodes:[{id:string,label:string,note?:string}],edges:[{from:string,to:string,label?:string}]}`
- brief: markdown string
- explainer: HTML string (must start with `<!DOCTYPE html` or `<html`, case-insensitive)

Chat:
- `GET /api/missions/:id/chat` → `{thread_id, messages: ChatMessage[]}`
- `POST /api/missions/:id/chat` `{content, client_id?}` → persists user message, runs agent turn, returns `{message: ChatMessage(assistant), artifacts?: Artifact[]}`. Synchronous request/response (no streaming in MVP). Idempotent on retry: if the thread's most recent user message already has the same `client_id` and `content`, the user message is not re-persisted — only the agent turn runs.
- Agent context: system prompt includes mission title/type/goal + titles of linked bookmarks/artifacts.

Search:
- `GET /api/search?q=` → `{missions:[], opportunities:[], artifacts:[], bookmarks:[]}` via FTS5, each item `{id, title, snippet}`.

### Agent layer

```ts
// agent/runtime.ts
export interface AgentTurnResult { reply: string; newArtifacts?: {kind:string;title:string;body:string}[]; }
export interface AgentRuntime {
  startMissionSession(mission: Mission): Promise<string>;   // returns session id
  runTurn(sessionId: string, missionContext: MissionContext, userMessage: string): Promise<AgentTurnResult>;
  triageBookmark(b: Bookmark, missions: Mission[]): Promise<{tags:string[]; list:string; mission_ids:string[]}>;
}
export function getRuntime(): AgentRuntime; // per AGENT_RUNTIME env
```

- `mock.ts`: deterministic fake for dev/tests. `runTurn` replies with a canned summary; if user message contains "mind map" it returns a mindmap artifact; "explainer" → explainer artifact; "brief" → brief. `triageBookmark` suggests tags derived from URL host keywords, list 'inbox', up to 3 missions matched by title-keyword overlap.
- `opencode.ts`: talks to OpenCode server (`opencode serve`, HTTP, default :4096). One OpenCode session per mission (stored in missions.agent_session_id). Bindings (below) are exposed via a thin MCP-style tool server the OpenCode config references; document exact config in server/README. If OpenCode unreachable → 503 `{error:"agent_unavailable"}` from chat route; user messages are never lost (persisted before agent call).
- `bindings.ts` implements server-side functions (used by both runtimes): `saveBookmark`, `linkBookmarkToMission`, `createArtifact`, `suggestTags`, `promoteToOpportunity`. These are plain TS functions over the same DB — unit-test them directly.
- Triage: after bookmark insert, `triage.ts` calls runtime.triageBookmark, writes suggestions JSON, sets status 'suggested'. Failures → status stays 'pending', no crash.

### Backend tests (bun test, all must pass)
- CRUD round trips for missions, opportunities (incl. stage_event history), bookmarks (incl. duplicate merge, tags/lists creation), artifacts (incl. 422 on bad mindmap body).
- Chat with mock runtime: send message → assistant reply persisted; "mind map" message creates artifact + search_index row.
- Triage: insert bookmark → wait triage → triage_status='suggested' with suggestions JSON.
- Search: seed data → FTS query returns grouped results.
- Use temp DB_PATH per test run.

## Frontend (web/)

React 18 + TS + Vite + Tailwind CSS. `vite.config.ts` dev proxy `/api` → `http://localhost:3000`. Build to `web/dist`.

Design: dark, low-saturation (zinc/stone neutrals + one warm amber accent), generous whitespace, clean hierarchy. No blue-purple gradients.

Routes (react-router):
- `/` Missions board: cards grouped by status, "New mission" modal (type select, title, goal).
- `/missions/:id` Workspace: 3-pane layout — left: linked bookmarks & artifacts list; center: chat thread (user/assistant bubbles, markdown rendering for assistant); right (or tabs): artifact viewer.
- `/opportunities` Kanban board, columns = stages (signal, validated, scoped, active, parked, archived); drag-and-drop to change stage (PATCH); card shows source badge; "New opportunity" modal; per-mission "Promote to opportunity" button on artifact/mission detail.
- `/bookmarks` Library: inbox-style list, filter by list/tag/triage_status, detail side panel showing triage suggestions with accept (applies tags/list/mission links via PATCH) / edit / reject (triage_status='skipped').
- `/search` Global search page, grouped results.

Artifact renderers:
- mindmap: render with `markmap-view` (auto-layout, read-only) from `{nodes,edges}` — convert tree; fallback: simple indented tree if graph invalid → show "broken" state with repair hint.
- brief: markdown renderer (marked + sanitize).
- explainer: `<iframe sandbox="allow-scripts" src="/api/artifacts/:id/body">` — never inject HTML inline.

Chat: on send, POST chat, append assistant reply; show inline cards for returned artifacts linking to viewer. Handle 503 agent_unavailable with visible error + retry; user message stays in thread.

Keep components small, typed API client (`web/src/api.ts`) mirroring the REST contract above. No backend code in web/.

## Extension (extension/)

Manifest V3, TypeScript, built with `bun build` to `extension/dist/`. Chrome + Firefox compatible (use `browser`/`chrome` namespace shim via `webextension-polyfill` or manual guard).

- `manifest.json`: action (toolbar button), permissions: `activeTab`, `scripting`, `storage`; host_permissions: `<all_urls>`; background service worker; options page for server URL (default `http://localhost:3000`).
- Flow: click toolbar button → background injects content script → Shadow DOM modal overlays page, prefilled title (document.title) + URL → fields: title, note, tags (comma input with existing-tag autocomplete via GET /api/tags), list (datalist via GET /api/lists), mission multi-select (GET /api/missions?status=active) → Save → POST /api/bookmarks → toast "Saved" → close. Enter key = save with defaults (AC-F005-02).
- Offline: if fetch fails, queue payload in storage.local (`pendingQueue`) and show "Queued — will retry"; background retries queue every 60s and on browser start (AC-F005-03).
- Keep UI minimal dark, matching web app aesthetic. No frameworks in the modal — vanilla TS + Shadow DOM.

## Integration contract
- Web and extension ONLY talk to the REST API defined here — no direct DB, no invented endpoints. Any endpoint need not listed here must be added to SPEC first (report back to orchestrator).
- Server must serve `web/dist` when built; `bun run dev` in server runs API-only on :3000.
- Root README: prerequisites (Bun ≥1.4, optional OpenCode), setup (`bun install` in server & web, build web, run), dev mode, extension load instructions, agent runtime config (mock vs opencode).
