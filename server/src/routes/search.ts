import { Hono } from "hono";
import { getDb } from "../db";

export const search = new Hono();

search.get("/", (c) => {
  const q = (c.req.query("q") || "").trim();
  const grouped = { missions: [], opportunities: [], artifacts: [], bookmarks: [] } as Record<
    string,
    { id: string; title: string; snippet: string }[]
  >;
  if (!q) return c.json(grouped);
  const db = getDb();
  // Escape double-quotes in FTS5 query; quote the whole phrase as OR of tokens.
  const tokens = q.replace(/"/g, " ").split(/\s+/).filter(Boolean);
  if (!tokens.length) return c.json(grouped);
  const match = tokens.map((t) => `"${t}"`).join(" OR ");
  let rows: { kind: string; entity_id: string; title: string; snippet: string }[];
  try {
    rows = db
      .query(
        `SELECT kind, entity_id, title, snippet(search_index, 3, '[', ']', '…', 12) AS snippet
         FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT 100`
      )
      .all(match) as typeof rows;
  } catch {
    return c.json(grouped);
  }
  const keyFor: Record<string, string> = {
    mission: "missions",
    opportunity: "opportunities",
    artifact: "artifacts",
    bookmark: "bookmarks",
  };
  for (const r of rows) {
    const key = keyFor[r.kind];
    if (key) grouped[key].push({ id: r.entity_id, title: r.title, snippet: r.snippet });
  }
  return c.json(grouped);
});
