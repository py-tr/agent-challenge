// All fetch calls go through Vite's proxy: /pulse/* → localhost:3000/pulse/*

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

export interface StatusResponse {
  queue: { pending: number; approved: number; rejected: number };
  gmail: { fetchedAt: string | null; messageCount: number };
  calendar: { fetchedAt: string | null; eventCount: number };
  agentName: string;
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
