// Background service worker: toolbar click → inject content script; retry pending queue.

import {
  api,
  getServerUrl,
  getQueue,
  setQueue,
  enqueue,
  updateBadge,
  type BookmarkPayload,
} from "./api";

const ALARM_NAME = "scout-retry-queue";

async function postBookmark(serverUrl: string, payload: BookmarkPayload): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/bookmarks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function retryQueue(): Promise<void> {
  const queue = await getQueue();
  if (queue.length === 0) {
    await updateBadge(0);
    return;
  }
  const serverUrl = await getServerUrl();
  const remaining = [];
  for (const item of queue) {
    const { queuedAt, ...payload } = item;
    const ok = await postBookmark(serverUrl, payload);
    if (!ok) remaining.push(item);
  }
  await setQueue(remaining);
  await updateBadge(remaining.length);
}

// Toolbar click → inject the content script and open the capture modal.
api.action.onClicked.addListener(async (tab: any) => {
  if (!tab?.id) return;
  try {
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch {
    // Page may not allow scripting (chrome://, store pages) — nothing we can do.
    return;
  }
  try {
    await api.tabs.sendMessage(tab.id, { type: "scout:open" });
  } catch {
    /* ignore */
  }
});

// Read-only API proxy for the content script (page-context fetches are CORS-blocked;
// the background service worker has host_permissions). Only GET /api/* paths allowed.
async function apiFetch(path: string): Promise<{ ok: boolean; data?: unknown; status?: number }> {
  if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("..")) {
    return { ok: false, status: 400 };
  }
  try {
    const serverUrl = await getServerUrl();
    const res = await fetch(`${serverUrl}${path}`);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function handleSave(payload: BookmarkPayload): Promise<{ ok: boolean; queued?: boolean }> {
  const serverUrl = await getServerUrl();
  const ok = await postBookmark(serverUrl, payload);
  if (ok) return { ok: true };
  const count = await enqueue({ ...payload, queuedAt: new Date().toISOString() });
  await updateBadge(count);
  return { ok: false, queued: true };
}

// Messages from the content script. Listeners return Promises — this works in both
// Chrome MV3 and Firefox (sendResponse + `return true` is Firefox-incompatible).
api.runtime.onMessage.addListener((msg: any) => {
  if (msg?.type === "scout:save") return handleSave(msg.payload);
  if (msg?.type === "scout:getServerUrl") {
    return getServerUrl().then((serverUrl) => ({ serverUrl }));
  }
  if (msg?.type === "scout:fetch") return apiFetch(msg.path);
  return undefined;
});

// Retry queue every 60s and on browser start.
api.alarms?.onAlarm.addListener((alarm: any) => {
  if (alarm.name === ALARM_NAME) retryQueue();
});
api.runtime.onStartup?.addListener(() => retryQueue());
api.runtime.onInstalled.addListener(() => {
  api.alarms?.create(ALARM_NAME, { periodInMinutes: 1 });
  retryQueue();
});
// Service workers can be restarted at any time — ensure the alarm exists.
api.alarms?.create(ALARM_NAME, { periodInMinutes: 1 });
// Reflect the persisted pending queue in the badge (it survives SW restarts).
getQueue()
  .then((q) => updateBadge(q.length))
  .catch(() => {});
