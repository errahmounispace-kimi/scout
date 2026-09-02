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
