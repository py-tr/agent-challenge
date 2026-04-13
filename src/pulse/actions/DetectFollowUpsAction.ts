/**
 * src/pulse/actions/DetectFollowUpsAction.ts
 * ElizaOS Action — scans the user's SENT folder for emails that have received
 * no reply in 3+ days and surfaces them as follow_up action items.
 *
 * Flow:
 *   1. Fetch recent SENT messages (last 14 days)
 *   2. For each, check the thread: if the last message is still from the user
 *      AND the email is older than FOLLOW_UP_THRESHOLD_DAYS, it's awaiting reply
 *   3. Skip threads that already have a pending follow_up item in the queue
 *   4. Insert a follow_up action item for each unanswered thread
 *
 * Trigger phrases: "check follow-ups", "any unanswered emails", "who hasn't replied"
 */

import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from "@elizaos/core";
import { listSentMessages, getThreadInfo, searchMessages } from "../lib/gmailClient.js";
import { insertActionItem, followUpExistsForGmailThread, resolveFollowUpsWithReplies } from "../db/queries.js";
import type { Db } from "../db/schema.js";

const FOLLOW_UP_THRESHOLD_DAYS = 3;
const FOLLOW_UP_THRESHOLD_MS   = FOLLOW_UP_THRESHOLD_DAYS * 24 * 60 * 60 * 1_000;
const MAX_SENT_TO_CHECK         = 20;

// ─── Trigger detection ────────────────────────────────────────────────────────

function isFollowUpRequest(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("follow") ||
    t.includes("unanswered") ||
    t.includes("no reply") ||
    t.includes("haven't replied") ||
    t.includes("who replied") ||
    t.includes("who hasn't replied") ||
    t.includes("waiting on") ||
    t.includes("check follow")
  );
}

// ─── Action ───────────────────────────────────────────────────────────────────

export const detectFollowUpsAction: Action = {
  name: "DETECT_FOLLOW_UPS",

  description:
    "Scan the user's Gmail SENT folder for emails that have received no reply in 3+ days. " +
    "Surfaces unanswered threads as follow_up action items in the approval queue. " +
    "Triggered when the user asks about unanswered emails or follow-ups.",

  similes: [
    "CHECK_FOLLOW_UPS",
    "FIND_UNANSWERED_EMAILS",
    "WHO_HASNT_REPLIED",
    "PENDING_REPLIES",
    "UNANSWERED_THREADS",
  ],

  examples: [
    [
      { name: "user", content: { text: "Who hasn't replied to me?" } },
      { name: "Pulse", content: { text: "Scanning your sent folder for unanswered threads…" } },
    ],
    [
      { name: "user", content: { text: "Check my follow-ups" } },
      { name: "Pulse", content: { text: "Checking for emails awaiting a reply…" } },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message.content?.text as string | undefined) ?? "";
    return isFollowUpRequest(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    await callback?.({ text: "Scanning sent folder for unanswered threads…" });

    const db = runtime.db as unknown as Db;
    let inserted = 0;
    let resolved = 0;
    let checked  = 0;

    try {
      const sent = await listSentMessages(MAX_SENT_TO_CHECK);
      const now  = Date.now();

      // Deduplicate by threadId — only check each thread once
      const seen  = new Set<string>();
      const tasks = sent.filter((msg) => {
        if (seen.has(msg.threadId)) return false;
        seen.add(msg.threadId);

        // Only consider emails older than the threshold
        const sentDate = new Date(msg.date).getTime();
        return !isNaN(sentDate) && now - sentDate > FOLLOW_UP_THRESHOLD_MS;
      });

      // First pass: find which threads now have replies so we can auto-resolve stale items
      const repliedThreadIds = new Set<string>();
      const userEmail = (process.env.GOOGLE_USER_EMAIL ?? "").toLowerCase();

      for (const msg of tasks) {
        try {
          const { messageCount, lastMessageFrom } = await getThreadInfo(msg.threadId);
          const lastIsUser = userEmail
            ? lastMessageFrom.toLowerCase().includes(userEmail)
            : messageCount === 1;

          if (!lastIsUser) {
            repliedThreadIds.add(msg.threadId);
          } else {
            // IMAP-inserted replies don't thread properly — fall back to subject search.
            // If a "Re: <subject>" exists in the inbox, treat the thread as replied.
            const cleanSubject = msg.subject.replace(/^(Re|Fwd?):\s*/i, "").trim();
            const hits = await searchMessages(`subject:"Re: ${cleanSubject}" in:inbox`, 1);
            if (hits.length > 0) repliedThreadIds.add(msg.threadId);
          }
        } catch { /* skip */ }
      }

      // Auto-resolve any queued follow_up items that now have a reply
      resolved = await resolveFollowUpsWithReplies(db, repliedThreadIds);

      for (const msg of tasks) {
        checked++;
        try {
          const { messageCount, lastMessageFrom } = await getThreadInfo(msg.threadId);

          // Reply received if thread has >1 message AND last message isn't from the user
          const lastIsUser =
            userEmail
              ? lastMessageFrom.toLowerCase().includes(userEmail)
              : messageCount === 1; // fallback: single message = no reply

          if (!lastIsUser) continue; // reply received via thread

          // IMAP-inserted replies don't thread — also check for Re: subject in inbox
          const cleanSubject = msg.subject.replace(/^(Re|Fwd?):\s*/i, "").trim();
          const replyHits = await searchMessages(`subject:"Re: ${cleanSubject}" in:inbox`, 1);
          if (replyHits.length > 0) continue; // reply found via subject match

          // Skip if already queued
          const exists = await followUpExistsForGmailThread(db, msg.threadId);
          if (exists) continue;

          // Strip Re:/Fwd: prefixes for a cleaner title
          const subject = msg.subject.replace(/^(Re|Fwd?):\s*/i, "").trim();
          const daysAgo = Math.floor((now - new Date(msg.date).getTime()) / 86_400_000);

          await insertActionItem(db, {
            type:     "follow_up",
            title:    `No reply: "${subject}"`,
            body:     `You sent this email ${daysAgo} day${daysAgo !== 1 ? "s" : ""} ago and haven't received a reply.\n\nShould Pulse draft a follow-up nudge?`,
            metadata: {
              gmailThreadId: msg.threadId,
              gmailMessageId: msg.id,
              subject: msg.subject,
              sentDate: msg.date,
              daysWithoutReply: daysAgo,
            },
            priority: daysAgo >= 7 ? 2 : 3,
          });
          inserted++;
        } catch {
          // Silently skip threads that fail (permission / deleted thread)
        }
      }

      const parts: string[] = [];
      if (inserted > 0) parts.push(`${inserted} unanswered thread${inserted !== 1 ? "s" : ""} added to your queue`);
      if (resolved > 0) parts.push(`${resolved} follow-up${resolved !== 1 ? "s" : ""} resolved (reply received)`);
      const summary = parts.length > 0
        ? parts.join(", ") + "."
        : `Checked ${checked} sent threads — all have received replies or are already queued.`;

      await callback?.({ text: `✓ ${summary}` });
      return { success: true, text: summary, data: { checked, inserted } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `Follow-up scan failed: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
