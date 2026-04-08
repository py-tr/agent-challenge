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
}

// ─── LLM Classification ───────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are an email triage assistant. Classify the email into exactly ONE category:
- action-required: the user must reply or make a decision
- follow-up: the user sent a message and received no reply; a nudge is needed
- commitment: the sender references a future deliverable (not a priority now)
- noise: newsletter, automated notification, marketing, or no action needed

Reply with ONLY a single word — the category name. No punctuation, no explanation.`;

export async function classifyEmail(
  runtime: IAgentRuntime,
  msg: GmailMessage
): Promise<ClassificationResult> {
  const prompt = `${CLASSIFY_SYSTEM}

Email to classify:
From: ${msg.from}
Subject: ${msg.subject}
Preview: ${msg.snippet.slice(0, 300)}`;

  let raw = "";
  try {
    raw = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 12,
      temperature: 0,
    });
  } catch (_err) {
    // Model unavailable (bad API key, rate limit, etc.) — use heuristics.
    raw = heuristicCategory(msg);
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
 * Fast keyword-based fallback — no LLM required.
 * Errs on the side of "noise" to keep the queue clean when offline.
 */
function heuristicCategory(msg: GmailMessage): EmailCategory {
  const text = `${msg.subject} ${msg.snippet} ${msg.from}`.toLowerCase();

  // Noisy senders / subjects
  const noisePatterns = [
    "unsubscribe",
    "newsletter",
    "no-reply",
    "noreply",
    "notification",
    "automated",
    "do not reply",
    "marketing",
    "promotion",
    "offer",
    "sale",
    "your receipt",
    "invoice",
    "order confirm",
    "shipment",
    "tracking",
    "digest",
    "weekly update",
    "github notification",
    "jira",
    "confluence",
    "slack notification",
  ];
  if (noisePatterns.some((p) => text.includes(p))) return "noise";

  // Action-required signals
  const actionPatterns = [
    "can you",
    "could you",
    "please review",
    "please respond",
    "action required",
    "needs your",
    "waiting for",
    "your feedback",
    "urgent",
    "asap",
    "by end of",
    "by eod",
    "by tomorrow",
    "please confirm",
    "let me know",
    "your thoughts",
    "approve",
  ];
  if (actionPatterns.some((p) => text.includes(p))) return "action-required";

  // Follow-up signals
  const followUpPatterns = [
    "following up",
    "just checking in",
    "circling back",
    "any update",
    "no response",
    "still waiting",
    "reminder",
  ];
  if (followUpPatterns.some((p) => text.includes(p))) return "follow-up";

  return "noise";
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
      };

    case "follow-up":
      return {
        category,
        actionItemType: "follow_up",
        priority: 5,
        body:
          `Hi,\n\nI wanted to follow up on my previous email regarding "${msg.subject}". ` +
          `Please let me know if you need any additional information.\n\nBest,`,
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

/** Minimal reply scaffold so the card is ready-to-approve. */
function buildReplyDraft(msg: GmailMessage): string {
  // Extract name from "First Last <email>" format.
  const nameMatch = msg.from.match(/^([^<]+)</);
  const firstName = nameMatch
    ? nameMatch[1].trim().split(" ")[0]
    : "there";

  return (
    `Hi ${firstName},\n\nThank you for your email regarding "${msg.subject}".\n\n` +
    `[Your response here]\n\nBest regards,`
  );
}
