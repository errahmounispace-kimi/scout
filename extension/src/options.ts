// Options page: configure Scout server URL.

import { api, DEFAULT_SERVER_URL } from "./api";

declare const document: any;

const input = document.getElementById("serverUrl") as HTMLInputElement;
const status = document.getElementById("status") as HTMLElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;

async function load(): Promise<void> {
  const res = await api.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL });
  input.value = res.serverUrl;
}

saveBtn.addEventListener("click", async () => {
  const url = input.value.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
  await api.storage.sync.set({ serverUrl: url });
  input.value = url;
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
});

load();
