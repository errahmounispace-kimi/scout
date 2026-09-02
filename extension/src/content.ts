// Content script: Shadow DOM capture modal, isolated from page CSS.

import { api, type BookmarkPayload } from "./api";

declare const document: any;
declare const window: any;

interface Mission {
  id: string;
  title: string;
}

let host: HTMLElement | null = null;

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .overlay {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0,0,0,.55); display: flex; align-items: flex-start; justify-content: center;
    padding-top: 12vh;
  }
  .modal {
    width: 420px; max-width: 92vw; background: #18181b; color: #e4e4e7;
    border: 1px solid #27272a; border-radius: 12px; padding: 18px;
    box-shadow: 0 20px 60px rgba(0,0,0,.6);
  }
  h2 { margin: 0 0 14px; font-size: 15px; font-weight: 600; color: #f4f4f5; letter-spacing: .2px; }
  label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #a1a1aa; margin: 10px 0 4px; }
  input, textarea, select {
    width: 100%; background: #27272a; color: #e4e4e7; border: 1px solid #3f3f46;
    border-radius: 6px; padding: 8px 10px; font-size: 13px; outline: none;
  }
  input:focus, textarea:focus, select:focus { border-color: #f59e0b; }
  textarea { resize: vertical; min-height: 56px; }
  .missions { max-height: 110px; overflow-y: auto; background: #27272a; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; }
  .missions label { display: flex; align-items: center; gap: 8px; text-transform: none; letter-spacing: 0; font-size: 13px; color: #e4e4e7; margin: 0; padding: 4px 2px; cursor: pointer; }
  .missions input { width: auto; }
  .row { display: flex; gap: 10px; margin-top: 16px; justify-content: flex-end; align-items: center; }
  button { border: none; border-radius: 6px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
  .save { background: #f59e0b; color: #18181b; font-weight: 600; }
  .save:hover { background: #fbbf24; }
  .cancel { background: transparent; color: #a1a1aa; }
  .cancel:hover { color: #e4e4e7; }
  .hint { font-size: 11px; color: #71717a; margin-right: auto; }
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: #27272a; color: #f4f4f5; border: 1px solid #f59e0b; border-radius: 8px;
    padding: 10px 18px; font-size: 13px; box-shadow: 0 8px 30px rgba(0,0,0,.5);
    z-index: 2147483647;
  }
  .tagwrap { position: relative; }
  .ac {
    position: absolute; top: 100%; left: 0; right: 0; background: #27272a;
    border: 1px solid #3f3f46; border-radius: 6px; margin-top: 2px; max-height: 120px;
    overflow-y: auto; display: none; z-index: 1;
  }
  .ac div { padding: 6px 10px; font-size: 13px; cursor: pointer; }
  .ac div:hover, .ac div.sel { background: #3f3f46; }
`;

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function showToast(shadow: ShadowRoot, msg: string): void {
  const t = el("div", { class: "toast" }, msg);
  shadow.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// All API reads go through the background service worker (page-context fetches are
// CORS-blocked). Messaging is promise-based: await the Promise returned by sendMessage
// (works in both Chrome MV3 and Firefox).
async function fetchJSON(path: string): Promise<any> {
  const r = await api.runtime.sendMessage({ type: "scout:fetch", path });
  if (!r?.ok) throw new Error(String(r?.status ?? "fetch failed"));
  return r.data;
}

function close(): void {
  host?.remove();
  host = null;
}

async function openModal(): Promise<void> {
  if (host) return; // already open
  host = el("div");
  host.id = "scout-capture-host";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = el("style");
  style.textContent = CSS;
  shadow.appendChild(style);

  const overlay = el("div", { class: "overlay" });
  const modal = el("div", { class: "modal" });
  overlay.appendChild(modal);
  shadow.appendChild(overlay);
  document.documentElement.appendChild(host);

  modal.appendChild(el("h2", {}, "Save to Scout"));

  // Title
  modal.appendChild(el("label", { for: "scout-title" }, "Title"));
  const title = el("input", { id: "scout-title", type: "text" }) as HTMLInputElement;
  title.value = document.title || "";
  modal.appendChild(title);

  // Note
  modal.appendChild(el("label", { for: "scout-note" }, "Note"));
  const note = el("textarea", { id: "scout-note" }) as HTMLTextAreaElement;
  modal.appendChild(note);

  // Tags (comma input + autocomplete)
  modal.appendChild(el("label", { for: "scout-tags" }, "Tags (comma separated)"));
  const tagwrap = el("div", { class: "tagwrap" });
  const tags = el("input", { id: "scout-tags", type: "text", placeholder: "research, ai, ...", autocomplete: "off" }) as HTMLInputElement;
  const ac = el("div", { class: "ac" });
  tagwrap.appendChild(tags);
  tagwrap.appendChild(ac);
  modal.appendChild(tagwrap);

  // List (datalist)
  modal.appendChild(el("label", { for: "scout-list" }, "List"));
  const list = el("input", { id: "scout-list", type: "text", list: "scout-lists", value: "inbox" }) as HTMLInputElement;
  const datalist = el("datalist", { id: "scout-lists" });
  modal.appendChild(list);
  modal.appendChild(datalist);

  // Missions multi-select
  modal.appendChild(el("label", {}, "Missions"));
  const missionsBox = el("div", { class: "missions" });
  missionsBox.textContent = "Loading…";
  modal.appendChild(missionsBox);

  // Buttons
  const row = el("div", { class: "row" });
  row.appendChild(el("span", { class: "hint" }, "Enter = save with defaults"));
  const cancelBtn = el("button", { class: "cancel" }, "Cancel");
  const saveBtn = el("button", { class: "save" }, "Save");
  row.appendChild(cancelBtn);
  row.appendChild(saveBtn);
  modal.appendChild(row);

  // Fetch server data (tags / lists / missions) via the background proxy — tolerate failure.
  let knownTags: string[] = [];
  try {
    const raw = await fetchJSON("/api/tags");
    knownTags = (Array.isArray(raw) ? raw : []).map((t: any) => (typeof t === "string" ? t : t.name));
  } catch { /* offline */ }
  try {
    const raw = await fetchJSON("/api/lists");
    const names = (Array.isArray(raw) ? raw : []).map((l: any) => (typeof l === "string" ? l : l.name));
    datalist.replaceChildren(...names.map((n: string) => el("option", { value: n })));
  } catch { /* offline */ }
  try {
    const missions: Mission[] = await fetchJSON("/api/missions?status=active");
    missionsBox.textContent = "";
    if (missions.length === 0) missionsBox.textContent = "No active missions";
    for (const m of missions) {
      const l = el("label");
      const cb = el("input", { type: "checkbox", value: m.id });
      l.appendChild(cb);
      l.appendChild(document.createTextNode(m.title));
      missionsBox.appendChild(l);
    }
  } catch {
    missionsBox.textContent = "Unavailable (offline)";
  }

  // Tag autocomplete on the last comma-separated token.
  let acIndex = -1;
  function currentToken(): { start: number; value: string } {
    const v = tags.value;
    const pos = tags.selectionStart ?? v.length;
    const start = v.lastIndexOf(",", pos - 1) + 1;
    return { start, value: v.slice(start, pos).trim() };
  }
  function renderAC(): void {
    const { value } = currentToken();
    ac.innerHTML = "";
    acIndex = -1;
    if (!value) { ac.style.display = "none"; return; }
    const matches = knownTags.filter((t) => t.toLowerCase().startsWith(value.toLowerCase()) && t.toLowerCase() !== value.toLowerCase()).slice(0, 8);
    if (!matches.length) { ac.style.display = "none"; return; }
    for (const m of matches) {
      const d = el("div", {}, m);
      d.addEventListener("mousedown", (e: Event) => {
        e.preventDefault();
        applyTag(m);
      });
      ac.appendChild(d);
    }
    ac.style.display = "block";
  }
  function applyTag(name: string): void {
    const { start } = currentToken();
    const v = tags.value;
    const pos = tags.selectionStart ?? v.length;
    const before = v.slice(0, start);
    const after = v.slice(pos);
    const needsComma = after.trim().length > 0 && !after.trimStart().startsWith(",");
    tags.value = before + name + (needsComma ? ", " + after.trimStart() : after.startsWith(",") ? after : after ? after : "");
    if (!after.trim()) tags.value = before + name;
    tags.focus();
    renderAC();
  }
  tags.addEventListener("input", renderAC);
  tags.addEventListener("blur", () => setTimeout(() => { ac.style.display = "none"; }, 150));

  function payload(): BookmarkPayload {
    const tagList = tags.value.split(",").map((t) => t.trim()).filter(Boolean);
    const missionIds = Array.from(missionsBox.querySelectorAll('input[type="checkbox"]:checked')).map(
      (c: any) => c.value as string,
    );
    return {
      url: window.location.href,
      title: title.value.trim() || document.title || window.location.href,
      note: note.value.trim(),
      ...(tagList.length ? { tags: tagList } : {}),
      ...(list.value.trim() ? { list: list.value.trim() } : {}),
      ...(missionIds.length ? { mission_ids: missionIds } : {}),
    };
  }

  let saving = false;
  async function save(): Promise<void> {
    if (saving) return;
    saving = true;
    saveBtn.textContent = "Saving…";
    try {
      const r = await api.runtime.sendMessage({ type: "scout:save", payload: payload() });
      if (r?.ok) {
        showToast(shadow, "Saved");
        setTimeout(close, 600);
      } else {
        showToast(shadow, "Queued — will retry");
        setTimeout(close, 1200);
      }
    } catch {
      showToast(shadow, "Queued — will retry");
      setTimeout(close, 1200);
    }
  }

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e: Event) => { if (e.target === overlay) close(); });

  modal.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") { close(); return; }
    if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
      if (document.activeElement === tags && ac.style.display === "block" && acIndex >= 0) {
        const opts = ac.querySelectorAll("div");
        (opts[acIndex] as HTMLElement | undefined)?.dispatchEvent(new MouseEvent("mousedown"));
        return;
      }
      e.preventDefault();
      save();
    }
    if (document.activeElement === tags && ac.style.display === "block") {
      const opts = ac.querySelectorAll("div");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        acIndex = e.key === "ArrowDown" ? Math.min(acIndex + 1, opts.length - 1) : Math.max(acIndex - 1, 0);
        opts.forEach((o, i) => (o as HTMLElement).classList.toggle("sel", i === acIndex));
      }
    }
  });

  title.focus();
  title.select();
}

api.runtime.onMessage.addListener((msg: any) => {
  if (msg?.type === "scout:open") openModal();
});
