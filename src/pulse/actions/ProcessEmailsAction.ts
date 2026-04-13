/**
 * src/pulse/actions/ProcessEmailsAction.ts
 * ElizaOS Action — manually trigger a full Pulse processing cycle.
 *
 * Trigger phrases (case-insensitive, checked in validate()):
 *   "process my emails", "check my emails", "check my inbox",
 *   "scan my inbox", "fetch emails", "process emails now"
 *
 * Flow:
 *   Delegates entirely to PulseBackgroundService.runProcessingCycle() which
 *   runs all three stages: emails, calendar conflicts, and Slib Guard reminders.
 *   This ensures a manual trigger produces the same result as the scheduled cycle.
 */

import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import { PulseBackgroundService } from "../services/PulseBackgroundService.js";

// ─── Trigger Detection ────────────────────────────────────────────────────────

/**
 * Returns true if the message is a manual email-processing request.
 * Intentionally broad so "check emails", "process inbox", etc. all work.
 */
function isEmailProcessRequest(text: string): boolean {
  const t = text.toLowerCase();
  // Must mention emails / inbox
  const mentionsEmails =
    t.includes("email") || t.includes("inbox") || t.includes("mail");
  // Must have an action verb
  const hasAction =
    t.includes("process") ||
    t.includes("check") ||
    t.includes("fetch") ||
    t.includes("scan") ||
    t.includes("read") ||
    t.includes("show") ||
    t.includes("get");
  return mentionsEmails && hasAction;
}

// ─── Action Definition ────────────────────────────────────────────────────────

export const processEmailsAction: Action = {
  name: "PROCESS_EMAILS",
  description:
    "Run a full Pulse processing cycle: fetch and classify Gmail emails, " +
    "detect calendar conflicts, and surface due Slib Guard commitment reminders. " +
    "Triggered when the user asks to process, check, or scan their emails or inbox.",

  similes: [
    "FETCH_EMAILS",
    "CHECK_EMAILS",
    "SCAN_INBOX",
    "CHECK_INBOX",
    "PROCESS_INBOX",
    "READ_EMAILS",
    "SYNC_INBOX",
  ],

  examples: [
    [
      {
        name: "user",
        content: { text: "Process my emails now" },
      },
      {
        name: "Pulse",
        content: {
          text: "Running a full sync — emails, calendar conflicts, and reminders…",
        },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Check my inbox" },
      },
      {
        name: "Pulse",
        content: {
          text: "On it — scanning emails, checking calendar conflicts, and reviewing commitments.",
        },
      },
    ],
  ],

  // ── Validate ──────────────────────────────────────────────────────────────

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory
  ): Promise<boolean> => {
    const text = (message.content?.text as string | undefined) ?? "";
    return isEmailProcessRequest(text);
  },

  // ── Handler ───────────────────────────────────────────────────────────────

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: (response: { text: string }) => Promise<unknown>
  ) => {
    if (callback) {
      await callback({
        text: "Running a full sync on Nosana GPU — emails, calendar conflicts, and commitment reminders…",
      });
    }

    try {
      const bgService = runtime.getService<PulseBackgroundService>(
        PulseBackgroundService.serviceType
      );

      if (!bgService) {
        const errMsg = "PulseBackgroundService is not available.";
        console.error(`[Pulse:ProcessEmailsAction] ${errMsg}`);
        if (callback) await callback({ text: `⚠ ${errMsg}` });
        return { success: false, error: errMsg };
      }

      const result = await bgService.runProcessingCycle();

      const parts: string[] = [];
      if (result.emails.inserted > 0)
        parts.push(`${result.emails.inserted} email${result.emails.inserted === 1 ? "" : "s"}`);
      if (result.conflicts.inserted > 0)
        parts.push(`${result.conflicts.inserted} calendar conflict${result.conflicts.inserted === 1 ? "" : "s"}`);
      if (result.reminders.inserted > 0)
        parts.push(`${result.reminders.inserted} commitment reminder${result.reminders.inserted === 1 ? "" : "s"}`);

      const summary = parts.length > 0
        ? `Added ${parts.join(", ")} to your approval queue.`
        : "Nothing new — your queue is up to date.";

      const replyText = `✓ Sync complete (${result.durationMs}ms). ${summary}`;
      if (callback) await callback({ text: replyText });

      return { success: true, data: result as unknown as Record<string, unknown>, text: summary };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:ProcessEmailsAction] Unexpected error: ${errMsg}`);
      if (callback) await callback({ text: `Sync failed: ${errMsg}` });
      return { success: false, error: errMsg };
    }
  },
};
