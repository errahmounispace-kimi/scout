# Scout server

Bun + Hono + bun:sqlite backend for Scout.

## Run

```sh
bun install
bun run dev      # API on :3000 (hot reload)
bun test
```

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `DB_PATH` | `./data/scout.db` | |
| `AGENT_RUNTIME` | `mock` | `mock` or `opencode` |
| `OPENCODE_URL` | `http://localhost:4096` | |
| `ARTIFACT_DIR` | `./data/artifacts` | |

## OpenCode runtime

Start `opencode serve` (HTTP, default :4096), then run the server with
`AGENT_RUNTIME=opencode`. One OpenCode session is created per mission and
stored in `missions.agent_session_id`.

The agent tool bindings (`saveBookmark`, `linkBookmarkToMission`,
`createArtifact`, `suggestTags`, `promoteToOpportunity` — see
`src/agent/bindings.ts`) are exposed to OpenCode via a thin MCP-style tool
server. OpenCode config (`opencode.json` in the repo root) references it:

```json
{
  "mcp": {
    "scout": {
      "type": "local",
      "command": ["bun", "run", "server/src/agent/mcp-server.ts"]
    }
  }
}
```

If OpenCode is unreachable, `POST /api/missions/:id/chat` returns
`503 {"error":"agent_unavailable"}`; user messages are persisted before the
agent call and are never lost.
