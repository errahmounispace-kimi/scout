import type { Database } from "bun:sqlite";
import type { Bookmark, Mission } from "../types";
import { getRuntime } from "./runtime";

/**
 * Run librarian triage for a bookmark asynchronously.
 * Success: triage_status='suggested' + triage_suggestions JSON.
 * Failure: status stays 'pending', never crashes the caller.
 */
export function enqueueTriage(db: Database, bookmarkId: string): void {
  const p = (async () => {
    try {
      const b = db.query("SELECT * FROM bookmarks WHERE id = ?").get(bookmarkId) as Bookmark | null;
      if (!b || b.triage_status !== "pending") return;
      const missions = db
        .query("SELECT * FROM missions WHERE status = 'active'")
        .all() as Mission[];
      const suggestion = await getRuntime().triageBookmark(b, missions);
      db.query(
        "UPDATE bookmarks SET triage_status = 'suggested', triage_suggestions = ? WHERE id = ?"
      ).run(JSON.stringify(suggestion), bookmarkId);
    } catch {
      // leave triage_status = 'pending'
    }
  })();
  // Keep a handle so unhandled rejections can't occur and tests can flush microtasks.
  void p.catch(() => {});
}

/** Await one macrotask — helper for tests waiting on triage. */
export function flushTriage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
