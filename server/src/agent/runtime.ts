import type { Bookmark, Mission } from "../types";

export interface AgentTurnResult {
  reply: string;
  newArtifacts?: { kind: string; title: string; body: string }[];
}

export interface MissionContext {
  mission: Mission;
  bookmarkTitles: string[];
  artifactTitles: string[];
  history: { role: string; content: string }[];
}

export interface TriageSuggestion {
  tags: string[];
  list: string;
  mission_ids: string[];
}

export interface AgentRuntime {
  startMissionSession(mission: Mission): Promise<string>; // returns session id
  runTurn(
    sessionId: string,
    missionContext: MissionContext,
    userMessage: string
  ): Promise<AgentTurnResult>;
  triageBookmark(b: Bookmark, missions: Mission[]): Promise<TriageSuggestion>;
}

/** Error thrown when the configured agent runtime cannot be reached. */
export class AgentUnavailableError extends Error {
  constructor(message = "agent_unavailable") {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

// Module-level singleton cache (keyed by runtime kind so env changes re-create it).
let cachedRuntime: { kind: string; runtime: AgentRuntime } | null = null;

/** Returns the configured agent runtime (module-level singleton). */
export function getRuntime(): AgentRuntime {
  const kind = process.env.AGENT_RUNTIME || "mock";
  if (cachedRuntime && cachedRuntime.kind === kind) return cachedRuntime.runtime;
  if (kind === "opencode") {
    const { OpenCodeRuntime } = require("./opencode") as typeof import("./opencode");
    cachedRuntime = { kind, runtime: new OpenCodeRuntime() };
    return cachedRuntime.runtime;
  }
  const { MockAgentRuntime } = require("./mock") as typeof import("./mock");
  cachedRuntime = { kind, runtime: new MockAgentRuntime() };
  return cachedRuntime.runtime;
}
