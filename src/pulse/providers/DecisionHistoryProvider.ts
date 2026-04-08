/**
 * src/pulse/providers/DecisionHistoryProvider.ts
 * Provider — injects the last 10 user decisions into the LLM context so
 * Pulse can surface approval patterns and personalise suggestions.
 *
 * Output format:
 *   ## Recent Decisions (last 10)
 *   - APPROVED  email_draft  "Proposal for Sarah"  2h ago
 *   - REJECTED  conflict_resolution  "Team sync ↔ Client call"  1d ago
 *   …
 *   Pattern: you approve 87% of email drafts, reject 60% of meeting reschedules.
 */

import type { Provider, ProviderResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  getDecisions,
  countDecisions,
  getDecisionPatterns,
} from "../db/queries.js";
import type { Db } from "../db/schema.js";
import type { Decision } from "../types.js";

function formatDecision(d: Decision): string {
  const tag = d.decision === "approved" ? "✓ APPROVED" : "✕ REJECTED";
  const age = relativeAge(d.decidedAt);
  const reason = d.reason ? ` ("${d.reason}")` : "";
  return `- ${tag}  ${age}${reason}`;
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

export const decisionHistoryProvider: Provider = {
  name: "DECISION_HISTORY",
  description:
    "Provides the last 10 user decisions and approval-rate patterns so Pulse " +
    "can personalise responses and surface behavioural trends.",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    try {
      const db = runtime.db as unknown as Db;
      const [decisions, total, patterns] = await Promise.all([
        getDecisions(db, 10),
        countDecisions(db),
        getDecisionPatterns(db),
      ]);

      if (total === 0) {
        return { text: "## Decision History\nNo decisions made yet." };
      }

      const lines = decisions.map(formatDecision);
      let text =
        `## Recent Decisions (${Math.min(10, total)} of ${total} total)\n` +
        lines.join("\n");

      // Add pattern summary once 10+ decisions exist.
      if (total >= 10 && patterns.length > 0) {
        const patternLines = patterns.map((p) => {
          const approvedTotal = p.approved + p.rejected;
          const pct =
            approvedTotal > 0
              ? Math.round((p.approved / approvedTotal) * 100)
              : 0;
          return `  ${p.type.replace(/_/g, " ")}: ${pct}% approval rate`;
        });
        text += "\n\nApproval patterns:\n" + patternLines.join("\n");
      }

      return { text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:DecisionHistoryProvider] Error: ${msg}`);
      return { text: "## Decision History\n(Unavailable — DB error)" };
    }
  },
};
