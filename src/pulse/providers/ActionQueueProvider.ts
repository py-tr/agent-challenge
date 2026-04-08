/**
 * src/pulse/providers/ActionQueueProvider.ts
 * Provider — injects a summary of the pending approval queue into every LLM
 * context window so Pulse can reference pending items in conversation.
 *
 * Output format (injected as system context):
 *   ## Pending Approval Queue (3 items)
 *   1. [email_draft | P3] Proposal draft for Sarah — 2 days ago
 *   2. [slib_reminder | P2] Commitment to Mark: 2026-04-08 — 1h ago
 *   3. [conflict_resolution | P1] "Team sync" ↔ "Client call" — Mon Apr 6 — 5m ago
 *   (User can approve/reject via the dashboard at localhost:5173)
 */

import type { Provider, ProviderResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import { getQueue } from "../db/queries.js";
import type { Db } from "../db/schema.js";
import type { ActionItem } from "../types.js";

function formatItem(item: ActionItem, index: number): string {
  const age = relativeAge(item.createdAt);
  return `${index + 1}. [${item.type} | P${item.priority}] ${item.title} — ${age}`;
}

function relativeAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  if (diff < 60_000) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const actionQueueProvider: Provider = {
  name: "ACTION_QUEUE",
  description:
    "Provides the current pending approval queue so Pulse can reference " +
    "outstanding items in conversation and answer user questions about them.",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    try {
      const db = runtime.db as unknown as Db;
      const items = await getQueue(db);

      if (items.length === 0) {
        return { text: "## Approval Queue\nNo pending items — queue is clear." };
      }

      const lines = items.map(formatItem);
      return {
        text:
          `## Pending Approval Queue (${items.length} item${items.length === 1 ? "" : "s"})\n` +
          lines.join("\n") +
          "\n(User can approve or reject via the dashboard.)",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:ActionQueueProvider] Error: ${msg}`);
      return { text: "## Approval Queue\n(Unavailable — DB error)" };
    }
  },
};
