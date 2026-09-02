import { ulid } from "../ulid";
import type { Bookmark, Mission } from "../types";
import type {
  AgentRuntime,
  AgentTurnResult,
  MissionContext,
  TriageSuggestion,
} from "./runtime";

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/**
 * Deterministic fake runtime for dev/tests — no API key needed.
 */
export class MockAgentRuntime implements AgentRuntime {
  async startMissionSession(_mission: Mission): Promise<string> {
    return `mock-session-${ulid()}`;
  }

  async runTurn(
    _sessionId: string,
    ctx: MissionContext,
    userMessage: string
  ): Promise<AgentTurnResult> {
    const msg = userMessage.toLowerCase();
    const result: AgentTurnResult = {
      reply:
        `[mock] Mission "${ctx.mission.title}" (${ctx.mission.type}). ` +
        `You said: "${userMessage}". ` +
        (ctx.bookmarkTitles.length
          ? `Linked bookmarks: ${ctx.bookmarkTitles.join(", ")}. `
          : "") +
        (ctx.artifactTitles.length
          ? `Artifacts: ${ctx.artifactTitles.join(", ")}.`
          : ""),
    };
    const newArtifacts: { kind: string; title: string; body: string }[] = [];
    if (msg.includes("mind map")) {
      newArtifacts.push({
        kind: "mindmap",
        title: `Mind map: ${ctx.mission.title}`,
        body: JSON.stringify({
          nodes: [
            { id: "root", label: ctx.mission.title },
            { id: "n1", label: "Key topic 1", note: "mock node" },
            { id: "n2", label: "Key topic 2" },
          ],
          edges: [
            { from: "root", to: "n1" },
            { from: "root", to: "n2", label: "related" },
          ],
        }),
      });
    }
    if (msg.includes("explainer")) {
      newArtifacts.push({
        kind: "explainer",
        title: `Explainer: ${ctx.mission.title}`,
        body: `<!DOCTYPE html><html><head><title>Explainer</title></head><body><h1>${ctx.mission.title}</h1><p>Mock explainer artifact.</p></body></html>`,
      });
    }
    if (msg.includes("brief")) {
      newArtifacts.push({
        kind: "brief",
        title: `Brief: ${ctx.mission.title}`,
        body: `# ${ctx.mission.title}\n\nMock synthesis brief.\n\n- Point one\n- Point two\n`,
      });
    }
    if (newArtifacts.length) result.newArtifacts = newArtifacts;
    return result;
  }

  async triageBookmark(b: Bookmark, missions: Mission[]): Promise<TriageSuggestion> {
    let host = "";
    try {
      host = new URL(b.url).host.toLowerCase();
    } catch {
      host = "";
    }
    const hostWords = keywords(host).filter(
      (w) => !["www", "com", "org", "net", "io", "dev", "co", "app"].includes(w)
    );
    const titleWords = keywords(b.title);
    const tags = [...new Set([...hostWords, ...titleWords])].slice(0, 4);
    const words = new Set([...hostWords, ...titleWords]);
    const mission_ids = missions
      .filter((m) => keywords(m.title).some((w) => words.has(w)))
      .slice(0, 3)
      .map((m) => m.id);
    return { tags, list: "inbox", mission_ids };
  }
}
