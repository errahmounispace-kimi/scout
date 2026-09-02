export interface Mission {
  id: string;
  title: string;
  type: "research" | "discovery" | "learning" | "ideation";
  goal: string;
  status: "active" | "paused" | "archived";
  agent_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Opportunity {
  id: string;
  title: string;
  source: "client_need" | "market_signal" | "discovery" | "idea";
  stage: "signal" | "validated" | "scoped" | "active" | "parked" | "archived";
  notes: string;
  origin_mission_id: string | null;
  origin_artifact_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Artifact {
  id: string;
  mission_id: string;
  kind: "mindmap" | "explainer" | "brief" | "roadmap" | "quiz";
  title: string;
  version: number;
  status: "draft" | "ready" | "broken";
  body_ref: string;
  created_by: "agent" | "user";
  created_at: string;
}

export interface Bookmark {
  id: string;
  url: string;
  canonical_url: string | null;
  title: string;
  note: string;
  captured_via: "extension" | "agent" | "manual";
  triage_status: "pending" | "suggested" | "confirmed" | "skipped";
  triage_suggestions: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  client_id: string | null; // client-generated idempotency key (user messages)
  artifact_ids: string; // JSON array
  at: string;
}
