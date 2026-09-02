// Cross-browser shim: prefer `browser` (Firefox), fall back to `chrome` (Chrome).
// Both expose promise-based APIs for everything we use (chrome MV3 supports promises).

declare const browser: any;
declare const chrome: any;

export const api: any =
  typeof browser !== "undefined" && browser?.runtime?.id
    ? browser
    : typeof chrome !== "undefined"
      ? chrome
      : undefined;

export const DEFAULT_SERVER_URL = "http://localhost:3000";

export async function getServerUrl(): Promise<string> {
  const res = await api.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL });
  return (res.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}

export interface BookmarkPayload {
  url: string;
  title?: string;
  note?: string;
  tags?: string[];
  list?: string;
  mission_ids?: string[];
}

export interface QueuedItem extends BookmarkPayload {
  queuedAt: string;
}

export async function getQueue(): Promise<QueuedItem[]> {
  const res = await api.storage.local.get({ pendingQueue: [] });
  return res.pendingQueue as QueuedItem[];
}

export async function setQueue(q: QueuedItem[]): Promise<void> {
  await api.storage.local.set({ pendingQueue: q });
}

export async function enqueue(item: QueuedItem): Promise<number> {
  const q = await getQueue();
  q.push(item);
  await setQueue(q);
  return q.length;
}

export async function updateBadge(count: number): Promise<void> {
  try {
    await api.action?.setBadgeText({ text: count > 0 ? String(count) : "" });
    await api.action?.setBadgeBackgroundColor({ color: "#f59e0b" });
  } catch {
    /* badge unsupported — ignore */
  }
}
