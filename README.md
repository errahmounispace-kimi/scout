# Scout

**A solo, agent-first mission & opportunity operating system.**

Scout helps one person run parallel intellectual pursuits — research, discovery, learning, ideation — and evaluate opportunities arising from client/market needs or from your own ideas. Unlike passive "second brain" tools, everything in Scout is active: every mission has a persistent OpenCode agent partner that researches with you, generates artifacts (mind maps, HTML explainers, briefs), and triages your internet scouting.

See [SPEC.md](SPEC.md) for the architecture contract and the full PRD (`Scout-PRD.md` in docs or project history) for user stories and acceptance criteria.

## What's in the box (MVP v1.0)

| Module | Path | Stack |
|--------|------|-------|
| Backend API + agent runtime | `server/` | Bun ≥ 1.4, Hono, `bun:sqlite` (WAL + FTS5) |
| Web app | `web/` | React 18, TypeScript, Vite, Tailwind |
| Bookmark capture extension | `extension/` | Manifest V3 (Chrome + Firefox), Shadow DOM modal, offline queue |

Core flows:

- **Missions** — research / discovery / learning / ideation workspaces, each with a persistent agent chat thread.
- **Opportunity pipeline** — signal → validated → scoped → active / parked / archived, with stage history and one-click **promote idea → opportunity** from any mission.
- **Artifacts** — agents emit versioned mind maps (markmap), markdown briefs, and sandboxed HTML explainers; the app renders them.
- **Scout log** — one-click extension capture with an edit modal (tags, lists, mission links), then an agent librarian auto-suggests tags and mission links for each bookmark.
- **Global search** — FTS5 across missions, opportunities, artifacts, and bookmarks.

## Quick start

Prerequisites: [Bun](https://bun.sh) ≥ 1.4.

```bash
# backend
cd server && bun install

# frontend (build once; server serves web/dist in production)
cd ../web && bun install && bun run build

# run
cd ../server && bun run src/index.ts     # http://localhost:3000
```

Development mode: run the server (`bun run dev` / `bun --watch src/index.ts`) and `cd web && bun run dev` — Vite dev server proxies `/api` to :3000.

### Extension

```bash
cd extension && bun install && bun run build
```

Then load `extension/dist/` as an unpacked extension (Chrome: `chrome://extensions` → Developer mode → Load unpacked; Firefox: `about:debugging` → Load Temporary Add-on → pick `dist/manifest.json`). Set the server URL on the extension options page (default `http://localhost:3000`).

Click the toolbar button on any page → edit title/note/tags/list/missions in the modal → Save. Offline? The capture is queued locally and retried every 60 s.

## Agent runtime

Scout talks to agents through an `AgentRuntime` interface (`server/src/agent/runtime.ts`):

- **`mock`** (default) — deterministic local agent for development and tests; no API key needed. Ask it to "make a mind map", "write an explainer", or "write a brief" and it emits valid artifacts.
- **`opencode`** — connects to an [OpenCode](https://opencode.ai) server (`opencode serve`), one session per mission. Configure:

```bash
export AGENT_RUNTIME=opencode
export OPENCODE_URL=http://localhost:4096
```

Agent **bindings** (save bookmark, link to mission, create artifact, promote to opportunity, suggest tags) are server-side functions in `server/src/agent/bindings.ts`; see `server/README.md` for exposing them to OpenCode as tools. Rivet agentOS deployment (one durable VM per mission) is the intended production host for the OpenCode runtime.

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/scout.db` | SQLite database |
| `ARTIFACT_DIR` | `./data/artifacts` | Versioned artifact bodies |
| `AGENT_RUNTIME` | `mock` | `mock` \| `opencode` |
| `OPENCODE_URL` | `http://localhost:4096` | OpenCode server |

## Tests

```bash
cd server && bun test     # 10 tests: CRUD, stage history, duplicate merge, triage, chat, FTS search, bindings
```

## Roadmap

- v1.1: research-sprint durable workflow, deeper search, polish
- v1.2: learning paths/roadmaps + quizzes, scheduled re-scouting (cron "what's new" digests)

Solo by design: no multi-user, no mobile apps, no Notion/Obsidian sync.
