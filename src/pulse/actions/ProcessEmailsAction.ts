/**
 * src/pulse/actions/ProcessEmailsAction.ts
 * ElizaOS Action — manually trigger an email processing cycle.
 *
 * Trigger phrases (case-insensitive, checked in validate()):
 *   "process my emails", "check my emails", "check my inbox",
 *   "scan my inbox", "fetch emails", "process emails now"
 *
 * Flow:
 *   1. Acknowledge via callback ("Fetching emails…")
 *   2. Get GmailMcpService from runtime
 *   3. fetchAndClassify() → deduplicated ClassifiedEmail[]
 *   4. Write each to pulse_action_items via insertActionItem()
 *   5. Callback with summary ("Added 3 items to your queue")
 *
 * DB access:
 *   runtime.db is the Drizzle-over-PGLite instance registered by plugin-sql.
 *   Cast to our Db type is safe: the underlying class is identical; schema
 *   type parameters are erased at runtime.
 */

import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import { GmailMcpService } from "../services/GmailMcpService.js";
import { insertActionItem } from "../db/queries.js";
import type { Db } from "../db/schema.js";

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
    "Fetch emails from Gmail, classify them into action items, follow-ups, " +
    "or noise, and add the relevant items to the approval queue in PGLite. " +
    "Triggered when the user asks to process, check, or scan their emails.",

  similes: [
    "FETCH_EMAILS",
    "CHECK_EMAILS",
    "SCAN_INBOX",
    "CHECK_INBOX",
    "PROCESS_INBOX",
    "READ_EMAILS",
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
          text: "Fetching and classifying your inbox on Nosana GPU…",
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
          text: "On it — scanning your inbox now.",
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
    // ── Step 1: Acknowledge ──────────────────────────────────────────────────
    if (callback) {
      await callback({
        text: "Fetching and classifying your emails on Nosana GPU…",
      });
    }

    try {
      // ── Step 2: Get Gmail service ──────────────────────────────────────────
      const gmailService = runtime.getService<GmailMcpService>(
        GmailMcpService.serviceType
      );

      if (!gmailService) {
        const errMsg =
          "Gmail service is not initialised. " +
          "Ensure GmailMcpService is registered in pulsePlugin.services.";
        console.error(`[Pulse:ProcessEmailsAction] ${errMsg}`);
        if (callback) await callback({ text: `⚠ ${errMsg}` });
        return { success: false, error: errMsg };
      }

      // ── Step 3: Fetch + classify ───────────────────────────────────────────
      const classified = await gmailService.fetchAndClassify();

      if (classified.length === 0) {
        const msg =
          "No new emails to process. " +
          "(Either your inbox is empty, Gmail credentials are not configured, " +
          "or all messages have already been queued.)";
        if (callback) await callback({ text: `✓ ${msg}` });
        return { success: true, data: { processed: 0, inserted: 0 }, text: msg };
      }

      // ── Step 4: Write to pulse_action_items ───────────────────────────────
      // runtime.db is the PgliteDatabase instance registered by plugin-sql.
      // The underlying Drizzle class is identical to our Db type.
      const db = runtime.db as unknown as Db;

      let inserted = 0;
      const errors: string[] = [];

      for (const { message: msg, classification } of classified) {
        if (!classification.actionItemType) continue; // noise/commitment

        try {
          await insertActionItem(db, {
            type: classification.actionItemType,
            title: msg.subject,
            body: classification.body,
            metadata: {
              gmailMessageId: msg.id,
              from: msg.from,
              date: msg.date,
              category: classification.category,
            },
            priority: classification.priority,
          });
          inserted++;
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : String(err);
          console.error(
            `[Pulse:ProcessEmailsAction] Failed to insert item for "${msg.subject}": ${errStr}`
          );
          errors.push(errStr);
        }
      }

      // ── Step 5: Reply with summary ────────────────────────────────────────
      const totalFetched = classified.length + /* noise skipped implicitly */ 0;
      const itemWord = inserted === 1 ? "item" : "items";
      const summaryLine =
        inserted === 0
          ? "No new action items (all emails were already queued or classified as noise)."
          : `Added ${inserted} ${itemWord} to your approval queue.`;

      const replyText = `✓ Processed ${classified.length} email${classified.length === 1 ? "" : "s"}. ${summaryLine}`;

      if (callback) await callback({ text: replyText });

      console.log(
        `[Pulse:ProcessEmailsAction] Done — fetched=${classified.length}, inserted=${inserted}, errors=${errors.length}`
      );

      return {
        success: errors.length === 0,
        data: {
          processed: classified.length,
          inserted,
          errors: errors.length > 0 ? errors : undefined,
        },
        text: summaryLine,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:ProcessEmailsAction] Unexpected error: ${errMsg}`);
      if (callback) {
        await callback({ text: `Email processing failed: ${errMsg}` });
      }
      return { success: false, error: errMsg };
    }
  },
};
