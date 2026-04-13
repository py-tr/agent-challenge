/**
 * src/pulse/lib/emailClassifier.ts
 * Classifies a GmailMessage into a Pulse ActionItemType using the LLM,
 * with a fast keyword-heuristic fallback when the model is unavailable.
 *
 * Categories → ActionItemType mapping:
 *   "action-required" → "email_draft"   (user needs to reply; draft queued)
 *   "follow-up"       → "follow_up"     (no reply from a thread user started)
 *   "commitment"      → null            (Slib Guard handles this in Day 6)
 *   "noise"           → null            (newsletter/notification; skipped)
 */

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import type { GmailMessage } from "./gmailClient.js";
import type { ActionItemType } from "../types.js";

/** Display name used in outgoing email signatures. Configurable via env. */
const USER_DISPLAY_NAME =
  process.env.USER_NAME?.trim() ||
  process.env.USER_DISPLAY_NAME?.trim() ||
  "Pulse User";

// ─── Public Types ─────────────────────────────────────────────────────────────

export type EmailCategory =
  | "action-required"
  | "follow-up"
  | "noise"
  | "commitment";

export interface ClassificationResult {
  /** Raw LLM category label. */
  category: EmailCategory;
  /**
   * Which pulse_action_items type to create.
   * null → do not create an action item (noise / commitment).
   */
  actionItemType: ActionItemType | null;
  /** Queue priority 1 (highest) – 10 (lowest). */
  priority: number;
  /**
   * Text shown as the card body in the approval queue.
   * For email_draft: a pre-written reply scaffold.
   * For follow_up: a reminder sentence.
   */
  body: string;
  /**
   * Metadata to merge into the action item record.
   * For email_draft: always includes { from, messageId } so extractEmailAddress
   * can reliably find the sender even when the caller's metadata differs.
   */
  metadata?: Record<string, unknown>;
}

// ─── LLM Classification ───────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are an email triage assistant. Classify the email into exactly ONE category:
- action-required: the user must reply or make a decision
- follow-up: the user sent a message and received no reply; a nudge is needed
- commitment: the sender references a future deliverable (not a priority now)
- noise: newsletter, automated notification, marketing, or no action needed

Reply with ONLY a single word — the category name. No punctuation, no explanation.`;

// ─── Pre-LLM noise filter ─────────────────────────────────────────────────────

/**
 * Senders that should NEVER become action items — transactional mailers,
 * security notifications, newsletter platforms, etc.
 * Checked before the LLM to save inference cost and avoid spam in the queue.
 */
const NOISE_SENDER_PATTERNS = [
  /no-?reply@/i,
  /noreply@/i,
  /do-?not-?reply@/i,
  /@accounts\.google\.com/i,
  /@security\.google\.com/i,
  /@notifications?\.google\.com/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /@bounce\./i,
];

const NOISE_SUBJECT_PATTERNS = [
  /security alert/i,
  /sign-?in attempt/i,
  /new sign-?in/i,
  /account activity/i,
  /unsubscribe/i,
  /verify your email/i,
  /email confirmation/i,
  /password reset/i,
  /two-?factor/i,
  /2-?step verification/i,
];

function isDefinitelyNoise(msg: GmailMessage): boolean {
  if (NOISE_SENDER_PATTERNS.some((re) => re.test(msg.from))) return true;
  if (NOISE_SUBJECT_PATTERNS.some((re) => re.test(msg.subject))) return true;
  return false;
}

export async function classifyEmail(
  runtime: IAgentRuntime,
  msg: GmailMessage
): Promise<ClassificationResult> {
  // Short-circuit: skip LLM for obvious automated/transactional mail.
  if (isDefinitelyNoise(msg)) {
    return { category: "noise", actionItemType: null, priority: 10, body: msg.snippet };
  }

  // Re: emails are replies someone sent TO the user — treat as action-required
  // (user should respond). Never classify as follow-up based on subject keywords.
  const isReply = /^re:/i.test(msg.subject.trim());
  if (isReply) {
    return {
      category: "action-required",
      actionItemType: "email_draft",
      priority: 3,
      body: buildReplyDraft(msg),
      metadata: { from: msg.from, messageId: msg.id },
    };
  }

  // Sanitize email-sourced fields before injecting into LLM prompt.
  const safeFrom    = msg.from.replace(/\r/g, "").slice(0, 100);
  const safeSubject = msg.subject.replace(/\r/g, "").slice(0, 200);
  const safeSnippet = msg.snippet.replace(/\r/g, "").slice(0, 300);

  const prompt = `${CLASSIFY_SYSTEM}

Email to classify:
From: ${safeFrom}
Subject: ${safeSubject}
Preview: ${safeSnippet}`;

  let raw = "";
  try {
    raw = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 12,
      temperature: 0,
    });
  } catch (err) {
    console.error(
      "[Pulse:EmailClassifier] LLM classification failed:",
      err instanceof Error ? err.message : String(err)
    );
    return subjectFallback(msg);
  }

  // LLM returned an empty string — treat as unavailable and use fallback.
  if (!raw.trim()) {
    return subjectFallback(msg);
  }

  const category = parseCategory(raw);
  return buildResult(category, msg);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set<EmailCategory>([
  "action-required",
  "follow-up",
  "noise",
  "commitment",
]);

function parseCategory(raw: string): EmailCategory {
  const normalised = raw.trim().toLowerCase().replace(/[^a-z-]/g, "");
  // Handle common LLM slips: "action_required", "actionrequired" etc.
  if (normalised === "actionrequired" || normalised === "action_required") {
    return "action-required";
  }
  if (normalised === "followup" || normalised === "follow_up") {
    return "follow-up";
  }
  if (VALID_CATEGORIES.has(normalised as EmailCategory)) {
    return normalised as EmailCategory;
  }
  // Default to noise so we don't spam the queue with mis-classified emails.
  return "noise";
}

/**
 * Subject-based fallback that returns a full ClassificationResult directly,
 * bypassing the EmailCategory → ActionItemType mapping so it can produce
 * conflict_resolution items (which have no corresponding EmailCategory).
 * Called when the LLM is unavailable.
 * Defaults to email_draft P4 rather than noise so no email is silently dropped.
 */
function subjectFallback(msg: GmailMessage): ClassificationResult {
  const subject = msg.subject.toLowerCase();

  if (["reschedule", "meeting", "call"].some((k) => subject.includes(k))) {
    return {
      category: "action-required",
      actionItemType: "conflict_resolution",
      priority: 2,
      body:
        `**Subject:** ${msg.subject}\n` +
        `**From:** ${msg.from}\n\n` +
        `${msg.snippet}`,
      metadata: { from: msg.from, messageId: msg.id },
    };
  }

  if (["proposal", "pricing", "contract"].some((k) => subject.includes(k))) {
    return {
      category: "action-required",
      actionItemType: "email_draft",
      priority: 2,
      body: buildReplyDraft(msg),
      metadata: { from: msg.from, messageId: msg.id },
    };
  }

  if (["follow up", "following up"].some((k) => subject.includes(k))) {
    return {
      category: "follow-up",
      actionItemType: "follow_up",
      priority: 3,
      body:
        `Hi,\n\nI wanted to follow up on my previous email regarding "${msg.subject}". ` +
        `Please let me know if you need any additional information.\n\nBest,\n${USER_DISPLAY_NAME}`,
      metadata: { from: msg.from, messageId: msg.id },
    };
  }

  if (["budget", "forecast", "deadline"].some((k) => subject.includes(k))) {
    return {
      category: "action-required",
      actionItemType: "email_draft",
      priority: 3,
      body: buildReplyDraft(msg),
      metadata: { from: msg.from, messageId: msg.id },
    };
  }

  // Default: treat every unknown email as actionable rather than dropping it.
  return {
    category: "action-required",
    actionItemType: "email_draft",
    priority: 4,
    body: buildReplyDraft(msg),
    metadata: { from: msg.from, messageId: msg.id },
  };
}

/** Map a category to its ActionItemType, priority, and a draft body string. */
function buildResult(
  category: EmailCategory,
  msg: GmailMessage
): ClassificationResult {
  switch (category) {
    case "action-required":
      return {
        category,
        actionItemType: "email_draft",
        priority: 3,
        body: buildReplyDraft(msg),
        metadata: { from: msg.from, messageId: msg.id },
      };

    case "follow-up":
      return {
        category,
        actionItemType: "follow_up",
        priority: 5,
        body:
          `Hi,\n\nI wanted to follow up on my previous email regarding "${msg.subject}". ` +
          `Please let me know if you need any additional information.\n\nBest,\n${USER_DISPLAY_NAME}`,
        metadata: { from: msg.from, messageId: msg.id },
      };

    case "commitment":
    case "noise":
    default:
      return {
        category,
        actionItemType: null,
        priority: 10,
        body: msg.snippet,
      };
  }
}

/**
 * Reply scaffold that includes the original email snippet so the draft is
 * grounded in the actual message content rather than a fully generic template.
 */
function buildReplyDraft(msg: GmailMessage): string {
  // Extract name from "First Last <email>" format.
  const nameMatch = msg.from.match(/^([^<]+)</);
  const senderName = nameMatch ? nameMatch[1].trim() : null;
  const firstName  = senderName ? senderName.split(" ")[0] : "there";

  // Strip display name to get bare email for the "ask Pulse" prompt.
  const emailMatch = msg.from.match(/<([^>]+)>/);
  const senderRef  = emailMatch
    ? emailMatch[1]
    : (senderName ?? msg.from);

  // Show up to 400 chars of the original message so the reply is contextual.
  const original = msg.snippet.trim().slice(0, 400);

  return (
    `**From:** ${msg.from}\n` +
    `**Subject:** ${msg.subject}\n\n` +
    `---\n\n` +
    `**Their message:**\n${original}\n\n` +
    `---\n\n` +
    `**Suggested reply scaffold:**\n\n` +
    `Hi ${firstName},\n\n` +
    `[Add your response here]\n\n` +
    `Best,\n${USER_DISPLAY_NAME}\n\n` +
    `---\n\n` +
    `**Approve** to mark this email as handled and log the decision.\n` +
    `**Reject** to dismiss it from your queue.\n\n` +
    `To send a customised reply, ask Pulse: _"Draft a reply to ${senderRef}"_`
  );
}
