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
  isNosanaNode: boolean;
  llmCallCount: number;
  /** Exponential moving average of inference latency in ms. Null until first call. */
  avgLatencyMs: number | null;
  uptimeMs: number;
  jobType: string;
  startedAt: string;
  /** Active model display name (e.g. "Qwen3.5-27B-AWQ-4bit"). Never the API key or URL. */
  modelName: string | null;
}

export interface StatusResponse {
  queue: { pending: number; approved: number; rejected: number };
  gmail: { fetchedAt: string | null; messageCount: number };
  calendar: { fetchedAt: string | null; eventCount: number };
  agentName: string;
  userDisplayName?: string;
  /** Inbox health score 0–100 computed from decisions, queue, and commitments. */
  score?: number;
  nosana: NosanaMetrics;
}

export interface DecisionsResponse {
  decisions: Decision[];
  total: number;
  patterns: DecisionPattern[];
}

export interface BriefingData {
  generatedAt: string;
  dateLabel: string;
  pendingItems: Array<{ type: string; title: string; priority: number }>;
  todayEvents: Array<{ title: string; start: string; allDay: boolean }>;
  urgentCommitments: Array<{ text: string; recipient: string | null; deadline: string }>;
}

export interface BriefingResponse {
  briefing: BriefingData | null;
}

/** Passed to ChatDrawer when opened from a conflict_resolution item. */
export interface ConflictContext {
  itemId: string;
  eventAId?: string;
  eventBId?: string;
  eventATitle: string;
  eventBTitle: string;
  eventAStart?: string;
  eventAEnd?: string;
  eventBStart?: string;
  eventBEnd?: string;
  date?: string;
}

/** Passed to ChatDrawer when the user wants to review/edit and send an email draft. */
export interface EmailDraftContext {
  itemId: string;
  to: string;
  subject: string;
  body: string;
  /** Full "From" header — shown in the collapsible original-email panel. */
  originalFrom?: string;
  /** Date string from the original email. */
  originalDate?: string;
  /** Snippet of the original email body. */
  originalSnippet?: string;
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
    request<{ success: boolean; id: string; status: string; draftCreated: boolean; draftRecipient: string | null }>(
      `/pulse/approve/${id}`,
      { method: "POST", body: JSON.stringify({ reason: reason ?? null }) }
    ),

  reject: (id: string, reason?: string) =>
    request<{ success: boolean; id: string; status: string }>(
      `/pulse/reject/${id}`,
      { method: "POST", body: JSON.stringify({ reason: reason ?? null }) }
    ),

  processInbox: () =>
    request<{ success: boolean; processed: number; inserted: number }>(
      `/pulse/process`,
      { method: "POST" }
    ),

  sendEmail: (draft: EmailDraftContext) =>
    request<{ success: boolean; messageId: string }>(
      `/pulse/send-email`,
      {
        method: "POST",
        body: JSON.stringify({
          to:      draft.to,
          subject: draft.subject,
          body:    draft.body,
          itemId:  draft.itemId,
        }),
      }
    ),

  suggestReplies: (params: { subject: string; from: string; bodySnippet: string }) =>
    request<{ suggestions: string[] }>(
      `/pulse/suggest-replies`,
      { method: "POST", body: JSON.stringify(params) }
    ),

  /**
   * Rewrite an email draft via a focused LLM call that bypasses all ElizaOS
   * providers. Prevents queue/calendar context from leaking into draft rewrites.
   */
  draftAssist: (params: {
    subject: string;
    to: string;
    currentBody: string;
    instruction: string;
    originalFrom?: string;
    originalSnippet?: string;
  }) =>
    request<{ reply: string }>(
      `/pulse/draft-assist`,
      { method: "POST", body: JSON.stringify(params) }
    ),

  createCalendarEvent: (message: string) =>
    request<{ success: boolean; title: string; start: string; end: string; eventId: string; confirmText: string }>(
      `/pulse/create-calendar-event`,
      { method: "POST", body: JSON.stringify({ message }) }
    ),

  getBriefing: () => request<BriefingResponse>("/pulse/briefing"),

  findFreeSlots: (params: { date: string; durationMinutes: number; excludeEventIds?: string[] }) =>
    request<{ slots: Array<{ start: string; end: string; label: string }> }>(
      `/pulse/find-free-slots`,
      { method: "POST", body: JSON.stringify(params) }
    ),

  resolveConflict: (params: {
    message: string;
    eventAId?: string; eventBId?: string;
    eventATitle?: string; eventBTitle?: string;
    eventAStart?: string; eventAEnd?: string;
    eventBStart?: string; eventBEnd?: string;
    date?: string;
  }) =>
    request<{ action: "rescheduled" | "suggestions"; text: string; newStart?: string; eventId?: string }>(
      `/pulse/resolve-conflict`,
      { method: "POST", body: JSON.stringify(params) }
    ),

  rescheduleEvent: (params: { eventId: string; newStart: string; newEnd: string; timeZone?: string }) =>
    request<{ success: boolean; eventId: string; title: string; newStart: string; label: string }>(
      `/pulse/reschedule-event`,
      { method: "POST", body: JSON.stringify(params) }
    ),

  dismiss: (id: string) =>
    request<{ success: boolean; id: string; status: string }>(
      `/pulse/dismiss/${id}`,
      { method: "POST" }
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
    // Try multiple ElizaOS response shapes:
    // 1. agentResponse.actionCallbacks.text  — action output (WEB_SEARCH etc.)
    // 2. agentResponse.text                  — direct LLM reply (older format)
    // 3. messages[].content where isAgent    — newer ElizaOS messaging format
    const resp = data as unknown as Record<string, unknown>;
    const ar = resp.agentResponse as Record<string, unknown> | undefined;
    const actionText = (ar?.actionCallbacks as Record<string, unknown> | undefined)?.text as string | undefined;
    const agentText  = ar?.text as string | undefined;
    if (actionText) return actionText;
    if (agentText)  return agentText;
    // Newer format: { messages: [{ content, isAgent, createdAt }] }
    const msgs = resp.messages as Array<{ content: string; isAgent: boolean }> | undefined;
    if (Array.isArray(msgs)) {
      const agentMsgs = msgs.filter((m) => m.isAgent);
      if (agentMsgs.length > 0) return agentMsgs[agentMsgs.length - 1].content;
    }
    return "";
  },

  /**
   * Fetch messages from a session that arrived after `after`.
   * Returns the text of the latest agent message, or null if none yet.
   * Used as a polling fallback when the frontend times out before the agent responds.
   */
  getMessages: async (sessionId: string, after: Date): Promise<string | null> => {
    const data = await request<{
      messages: Array<{ content: string; isAgent: boolean; createdAt: string }>;
      hasMore: boolean;
    }>(`/api/messaging/sessions/${sessionId}/messages?after=${encodeURIComponent(after.toISOString())}`);
    const agentMsgs = data.messages.filter((m) => m.isAgent);
    return agentMsgs.length > 0 ? agentMsgs[agentMsgs.length - 1].content : null;
  },
};
