// Pulse API:   /pulse/*              → proxied to localhost:3000 in dev
// ElizaOS API: /api/agents, /api/messaging/sessions → proxied in dev

export type ActionItemType =
  | "email_draft"
  | "conflict_resolution"
  | "slib_reminder"
  | "follow_up";

export type ActionItemStatus = "pending" | "approved" | "rejected";

export interface ActionItem {
  id: string;
  type: ActionItemType;
  title: string;
  body: string;
  metadata: Record<string, unknown> | null;
  status: ActionItemStatus;
  priority: number;
  createdAt: string;
  decidedAt: string | null;
}

export interface Decision {
  id: string;
  actionItemId: string;
  decision: "approved" | "rejected";
  reason: string | null;
  decidedAt: string;
  title: string | null;
  itemType: string | null;
}

export interface DecisionPattern {
  type: string;
  approved: number;
  rejected: number;
}

export interface QueueResponse {
  items: ActionItem[];
  count: number;
}

export interface NosanaMetrics {
  nodeId: string | null;
  nodeUrl: string | null;
  isNosanaNode: boolean;
  llmCallCount: number;
  uptimeMs: number;
  jobType: string;
  startedAt: string;
}

export interface StatusResponse {
  queue: { pending: number; approved: number; rejected: number };
  gmail: { fetchedAt: string | null; messageCount: number };
  calendar: { fetchedAt: string | null; eventCount: number };
  agentName: string;
  nosana: NosanaMetrics;
}

export interface DecisionsResponse {
  decisions: Decision[];
  total: number;
  patterns: DecisionPattern[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export const pulseApi = {
  getQueue: () => request<QueueResponse>("/pulse/queue"),

  getStatus: () => request<StatusResponse>("/pulse/status"),

  getDecisions: (limit = 20) =>
    request<DecisionsResponse>(`/pulse/decisions?limit=${limit}`),

  approve: (id: string, reason?: string) =>
    request<{ success: boolean; id: string; status: string }>(
      `/pulse/approve/${id}`,
      { method: "POST", body: JSON.stringify({ reason: reason ?? null }) }
    ),

  reject: (id: string, reason?: string) =>
    request<{ success: boolean; id: string; status: string }>(
      `/pulse/reject/${id}`,
      { method: "POST", body: JSON.stringify({ reason: reason ?? null }) }
    ),
};

// ─── ElizaOS agent / sessions API ────────────────────────────────────────────

export interface ElizaAgent {
  id: string;
  name?: string;
}

interface ElizaAgentListResponse {
  success: boolean;
  data: { agents: ElizaAgent[] };
}

interface SessionCreateResponse {
  sessionId: string;
}

interface AgentResponseContent {
  text: string;
  thought?: string;
  actions?: string[];
  // Set by ElizaOS after actions run — contains action callback output (e.g. search results).
  // This is the correct source when the LLM replies with REPLY + WEB_SEARCH.
  actionCallbacks?: { text?: string };
}

interface SendMessageResponse {
  success: boolean;
  agentResponse?: AgentResponseContent;
}

export const agentApi = {
  /** Returns the first available agent's ID. */
  fetchAgentId: async (): Promise<string> => {
    const resp = await request<ElizaAgentListResponse>("/api/agents");
    const id = resp.data?.agents?.[0]?.id;
    if (!id) throw new Error("No agents available");
    return id;
  },

  /**
   * Create a messaging session for the given agent + user.
   * Returns the sessionId to use for all subsequent messages.
   */
  createSession: async (agentId: string, userId: string): Promise<string> => {
    const data = await request<SessionCreateResponse>("/api/messaging/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId, userId }),
    });
    return data.sessionId;
  },

  /**
   * Send a message in an existing session and wait for the agent response.
   * Uses transport: "http" which blocks until the agent replies.
   */
  sendMessage: async (sessionId: string, content: string, signal?: AbortSignal): Promise<string> => {
    const data = await request<SendMessageResponse>(
      `/api/messaging/sessions/${sessionId}/messages`,
      { method: "POST", body: JSON.stringify({ content, transport: "http" }), signal }
    );
    console.log("[ChatAPI] Raw response:", JSON.stringify(data));
    // actionCallbacks.text contains action output (e.g. WEB_SEARCH results).
    // Fall back to agentResponse.text which is the LLM's REPLY text.
    return data.agentResponse?.actionCallbacks?.text || data.agentResponse?.text || "";
  },
};
