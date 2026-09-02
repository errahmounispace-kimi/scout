import type { Bookmark, Mission } from "../types";
import {
  AgentUnavailableError,
  type AgentRuntime,
  type AgentTurnResult,
  type MissionContext,
  type TriageSuggestion,
} from "./runtime";

/**
 * OpenCodeRuntime — talks to an `opencode serve` HTTP server
 * (OPENCODE_URL, default http://localhost:4096).
 *
 * One OpenCode session per mission (persisted in missions.agent_session_id
 * by the chat route). Any connectivity/HTTP failure raises
 * AgentUnavailableError so routes can return 503 {error:"agent_unavailable"}.
 */
export class OpenCodeRuntime implements AgentRuntime {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.OPENCODE_URL || "http://localhost:4096").replace(/\/$/, "");
  }

  private async request(path: string, init?: RequestInit): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers || {}) },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: any) {
      throw new AgentUnavailableError(`agent_unavailable: ${e?.message || "unreachable"}`);
    }
    if (!res.ok) throw new AgentUnavailableError(`agent_unavailable: HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  async startMissionSession(mission: Mission): Promise<string> {
    const data = await this.request("/session", {
      method: "POST",
      body: JSON.stringify({ title: `Scout mission: ${mission.title}` }),
    });
    const id = data?.id || data?.session?.id;
    if (!id) throw new AgentUnavailableError("agent_unavailable: no session id");
    return String(id);
  }

  async runTurn(
    sessionId: string,
    ctx: MissionContext,
    userMessage: string
  ): Promise<AgentTurnResult> {
    const system =
      `You are Scout's mission agent. Mission: "${ctx.mission.title}" ` +
      `(type: ${ctx.mission.type}). Goal: ${ctx.mission.goal || "(none)"}.\n` +
      `Linked bookmarks: ${ctx.bookmarkTitles.join("; ") || "none"}.\n` +
      `Artifacts: ${ctx.artifactTitles.join("; ") || "none"}.`;
    const data = await this.request(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({
        system,
        parts: [{ type: "text", text: userMessage }],
      }),
    });
    const parts: any[] = data?.parts || data?.message?.parts || [];
    const reply =
      parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n") ||
      (typeof data?.content === "string" ? data.content : "");
    if (!reply) throw new AgentUnavailableError("agent_unavailable: empty reply");
    return { reply };
  }

  async triageBookmark(b: Bookmark, missions: Mission[]): Promise<TriageSuggestion> {
    const prompt =
      `Suggest JSON {tags:string[], list:string, mission_ids:string[]} for this bookmark.\n` +
      `URL: ${b.url}\nTitle: ${b.title}\nNote: ${b.note}\n` +
      `Missions: ${missions.map((m) => `${m.id}:${m.title}`).join(", ") || "none"}\n` +
      `Rules: list should be "inbox" unless clearly otherwise; at most 3 mission_ids; reply with JSON only.`;
    const data = await this.request("/session", {
      method: "POST",
      body: JSON.stringify({ title: "Scout triage" }),
    });
    const sid = data?.id || data?.session?.id;
    if (!sid) throw new AgentUnavailableError("agent_unavailable: no session id");
    const res = await this.request(`/session/${sid}/message`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
    });
    const parts: any[] = res?.parts || res?.message?.parts || [];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { tags: [], list: "inbox", mission_ids: [] };
    try {
      const parsed = JSON.parse(m[0]);
      return {
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        list: typeof parsed.list === "string" ? parsed.list : "inbox",
        mission_ids: Array.isArray(parsed.mission_ids)
          ? parsed.mission_ids.map(String).slice(0, 3)
          : [],
      };
    } catch {
      return { tags: [], list: "inbox", mission_ids: [] };
    }
  }
}
