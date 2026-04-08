/**
 * src/pulse/evaluators/SlibGuardEvaluator.ts
 * alwaysRun Evaluator — scans every incoming user message for commitment
 * promises and writes them to pulse_commitments + pulse_action_items.
 *
 * "Slib Guard" = promise keeper. Named for the accountability concept.
 *
 * Flow per message:
 *   1. validate() — quick regex check; returns false for clearly non-commitment
 *      messages (avoids LLM cost on greetings, short replies, etc.)
 *   2. handler()  — extractCommitments() via LLM (regex fallback)
 *                  → insertCommitment() in pulse_commitments
 *                  → insertActionItem("slib_reminder") in pulse_action_items
 *                  → markReminderSent() to link the two rows
 *
 * DB access: same cast pattern as ProcessEmailsAction — runtime.db is the
 * Drizzle-over-PGLite instance registered by plugin-sql, cast to our Db type.
 *
 * The action item is created IMMEDIATELY (not deferred to remindAt) so the
 * commitment surfaces in the approval queue right away. The commitment row
 * still stores remindAt for PulseBackgroundService's scheduled reminder check.
 */

import type { Evaluator, IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  hasCommitmentPattern,
  extractCommitments,
  type ExtractedCommitment,
} from "../lib/commitmentParser.js";
import { insertCommitment, insertActionItem, markReminderSent } from "../db/queries.js";
import type { Db } from "../db/schema.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildReminderBody(c: ExtractedCommitment): string {
  const recipientClause = c.recipient
    ? `You told **${c.recipient}** you would:`
    : "You committed to:";

  const deadlineDate = new Date(c.deadline + "T12:00:00");
  const formatted = deadlineDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    `${recipientClause}\n\n` +
    `> "${c.text}"\n\n` +
    `**Deadline:** ${formatted}\n\n` +
    `Approve to acknowledge this commitment is on track, or Reject to dismiss it.`
  );
}

// ─── Evaluator ────────────────────────────────────────────────────────────────

export const slibGuardEvaluator: Evaluator = {
  name: "SLIB_GUARD",
  alwaysRun: true,

  description:
    "Scans every user message for commitment promises " +
    "('I'll send X to Y by Z', 'I will deliver X by Friday') " +
    "and records them in pulse_commitments with a T-1 day reminder action item.",

  similes: ["COMMITMENT_TRACKER", "DEADLINE_DETECTOR", "PROMISE_KEEPER"],

  examples: [
    {
      prompt: "The user sends a message containing a commitment promise.",
      messages: [
        {
          name: "user",
          content: {
            text: "I'll send the proposal to Mark by Wednesday.",
          },
        },
      ],
      outcome:
        "A commitment row is created in pulse_commitments with deadline=next-Wednesday " +
        "and a slib_reminder action item appears in the approval queue.",
    },
    {
      prompt: "The user makes a delivery commitment in a chat message.",
      messages: [
        {
          name: "user",
          content: {
            text: "I will have the report ready for Sarah by Friday EOD.",
          },
        },
      ],
      outcome:
        "Commitment row created with recipient=Sarah, deadline=next-Friday, " +
        "slib_reminder action item queued.",
    },
  ],

  // ── Validate ──────────────────────────────────────────────────────────────
  // Quick regex gate — only proceed to the handler when the message
  // plausibly contains a commitment. Avoids LLM cost on greetings, etc.

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const text = (message.content?.text as string | undefined) ?? "";
    // Minimum length guard + pattern check.
    return text.length >= 15 && hasCommitmentPattern(text);
  },

  // ── Handler ───────────────────────────────────────────────────────────────

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ) => {
    const text = (message.content?.text as string | undefined) ?? "";
    if (!text) return { success: true, data: { extracted: 0 } };

    // Extract all commitments from the message (LLM → regex fallback).
    let extracted: ExtractedCommitment[];
    try {
      extracted = await extractCommitments(runtime, text);
    } catch (err) {
      console.error(
        "[Pulse:SlibGuard] Extraction error:",
        err instanceof Error ? err.message : String(err)
      );
      return { success: false, error: String(err) };
    }

    if (extracted.length === 0) {
      // validate() fired but extraction found nothing — no-op.
      return { success: true, data: { extracted: 0 } };
    }

    const db = runtime.db as unknown as Db;
    const sourceMessageId = (message.id as string | undefined) ?? null;
    let saved = 0;

    for (const c of extracted) {
      try {
        // 1. Persist the commitment row.
        const commitment = await insertCommitment(db, {
          sourceMessageId,
          text:      c.text,
          recipient: c.recipient,
          deadline:  c.deadline,
          remindAt:  c.remindAt,
        });

        // 2. Create a slib_reminder action item immediately so it surfaces
        //    in the approval queue without waiting for remindAt to pass.
        const title =
          c.recipient
            ? `Commitment to ${c.recipient}: ${c.deadline}`
            : `Commitment by ${c.deadline}`;

        const actionItem = await insertActionItem(db, {
          type:     "slib_reminder",
          title,
          body:     buildReminderBody(c),
          metadata: {
            commitmentId: commitment.id,
            deadline:     c.deadline,
            recipient:    c.recipient,
            verbatim:     c.text,
          },
          priority: 2, // High — surfaces above email drafts (3) and follow-ups (5)
        });

        // 3. Link the action item back to the commitment row.
        await markReminderSent(db, commitment.id, actionItem.id);

        console.log(
          `[Pulse:SlibGuard] Commitment saved — recipient=${c.recipient ?? "unknown"}, ` +
          `deadline=${c.deadline}, actionItemId=${actionItem.id}`
        );

        saved++;
      } catch (err) {
        console.error(
          "[Pulse:SlibGuard] Failed to save commitment:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    return {
      success: true,
      data:    { extracted: extracted.length, saved },
    };
  },
};
