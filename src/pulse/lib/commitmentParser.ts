/**
 * src/pulse/lib/commitmentParser.ts
 * Extracts commitment promises from free-form text.
 *
 * Primary path: LLM with a structured JSON prompt → reliable date resolution.
 * Fallback:     Regex extraction → relative-date resolver for common expressions.
 *
 * Key function: extractCommitments(runtime, text) → ExtractedCommitment[]
 * Quick check:  hasCommitmentPattern(text) → boolean  (used in Evaluator.validate)
 */

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface ExtractedCommitment {
  /** Verbatim phrase from the message, e.g. "I'll send the proposal to Mark by Wednesday" */
  text: string;
  /** Extracted name if present, e.g. "Mark". null if no recipient found. */
  recipient: string | null;
  /** Resolved deadline as YYYY-MM-DD */
  deadline: string;
  /** ISO datetime for the reminder: deadline − 1 calendar day at 09:00 local time */
  remindAt: string;
}

// ─── Quick Pattern Check (used in Evaluator.validate) ────────────────────────

// Anchored to first-person commitment starters
const COMMITMENT_TRIGGER = /\b(?:I(?:'ll|'m going to| will| can have| should| am going to))\b.{0,120}\bby\b/i;

export function hasCommitmentPattern(text: string): boolean {
  return COMMITMENT_TRIGGER.test(text);
}

// ─── Full Extraction ──────────────────────────────────────────────────────────

const TODAY_LABEL = (): string => new Date().toISOString().slice(0, 10);

/**
 * Extract all commitments from `text`.
 * Returns an empty array when no commitments are found.
 */
export async function extractCommitments(
  runtime: IAgentRuntime,
  text: string
): Promise<ExtractedCommitment[]> {
  // 1. Try LLM path for best accuracy (especially for relative dates).
  try {
    const result = await llmExtract(runtime, text);
    if (result.length > 0) return result;
  } catch (_err) {
    // LLM unavailable — fall through to regex.
  }

  // 2. Regex fallback.
  return regexExtract(text);
}

// ─── LLM Path ─────────────────────────────────────────────────────────────────

async function llmExtract(
  runtime: IAgentRuntime,
  text: string
): Promise<ExtractedCommitment[]> {
  const today = TODAY_LABEL();
  const prompt =
    `You extract commitment promises from messages. A commitment is when the author promises to do something by a specific date.\n` +
    `Today is ${today}.\n\n` +
    `Message:\n"${text}"\n\n` +
    `If commitments exist, reply with a JSON array ONLY (no other text):\n` +
    `[{"text":"verbatim phrase","recipient":"name or null","deadline":"YYYY-MM-DD"}]\n` +
    `If no commitments, reply with: []\n` +
    `Resolve relative dates (Monday, next Friday, tomorrow, end of week, etc.) against today (${today}).`;

  const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    maxTokens: 300,
    temperature: 0,
  });

  // Parse the JSON — strip any surrounding markdown fences.
  const json = raw.trim().replace(/^```(?:json)?|```$/gm, "").trim();
  const parsed = JSON.parse(json) as Array<{
    text: string;
    recipient: string | null;
    deadline: string;
  }>;

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((c) => c.text && /^\d{4}-\d{2}-\d{2}$/.test(c.deadline))
    .map((c) => ({
      text:      c.text,
      recipient: c.recipient ?? null,
      deadline:  c.deadline,
      remindAt:  computeRemindAt(c.deadline),
    }));
}

// ─── Regex Fallback ───────────────────────────────────────────────────────────

/**
 * Simple regex-based extraction for the most common English patterns.
 * Handles: "I'll [verb phrase] to [Name] by [date]"
 */
function regexExtract(text: string): ExtractedCommitment[] {
  // Match: "I'll / I will / I'm going to / I can have / I should ... by [date phrase]"
  const pattern =
    /\b(?:I(?:'ll|'m going to| will| can have| should| am going to))\s+(.+?)\s+by\s+([^.!?,;:]+)/gi;

  const results: ExtractedCommitment[] = [];

  for (const match of text.matchAll(pattern)) {
    const fullPhrase = match[0].trim();
    const body       = match[1].trim();
    const dateExpr   = match[2].trim();

    // Resolve the date expression to YYYY-MM-DD.
    const deadline = resolveDate(dateExpr, new Date());
    if (!deadline) continue;

    // Try to extract a recipient name from "to [FirstName]" in the phrase body.
    const recipientMatch = body.match(/\bto\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    const recipient = recipientMatch?.[1] ?? null;

    results.push({
      text:      fullPhrase,
      recipient,
      deadline,
      remindAt:  computeRemindAt(deadline),
    });
  }

  return results;
}

// ─── Date Resolution ──────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Resolve a natural-language date expression to YYYY-MM-DD.
 * Returns null if the expression cannot be resolved.
 */
export function resolveDate(expr: string, base: Date = new Date()): string | null {
  const s = expr.trim().toLowerCase().replace(/[.,!?]$/, "");

  // "today" / "eod" / "end of day"
  if (/^(?:today|eod|end of day)$/.test(s)) {
    return toYMD(base);
  }

  // "tomorrow"
  if (s === "tomorrow") {
    return toYMD(addDays(base, 1));
  }

  // "end of week" / "eow" — treat as Friday of current week
  if (/^(?:end of (?:the )?week|eow)$/.test(s)) {
    return toYMD(nextWeekday(WEEKDAYS.friday, base));
  }

  // "next week" — treat as Monday of next week
  if (/^next week$/.test(s)) {
    const monday = nextWeekday(WEEKDAYS.monday, base);
    // Ensure it's genuinely "next" week
    const daysUntil = (WEEKDAYS.monday - base.getDay() + 7) % 7;
    return toYMD(addDays(base, daysUntil === 0 ? 7 : daysUntil));
  }

  // "next [weekday]" — the occurrence that falls 7-13 days from today.
  // Algorithm: advance 7 days, then find the first hit of targetDay from there.
  const nextDayMatch = s.match(/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (nextDayMatch) {
    const targetDay  = WEEKDAYS[nextDayMatch[1]];
    const startFrom  = addDays(base, 7);
    const diff       = (targetDay - startFrom.getDay() + 7) % 7;
    return toYMD(addDays(startFrom, diff));
  }

  // Plain weekday name: "wednesday", "friday", etc. → next occurrence
  if (WEEKDAYS[s] !== undefined) {
    return toYMD(nextWeekday(WEEKDAYS[s], base));
  }

  // "this [weekday]" — same as plain weekday (this week's occurrence)
  const thisDayMatch = s.match(/^this\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (thisDayMatch) {
    return toYMD(nextWeekday(WEEKDAYS[thisDayMatch[1]], base));
  }

  // "in N days"
  const inDaysMatch = s.match(/^in\s+(\d+)\s+days?$/);
  if (inDaysMatch) {
    return toYMD(addDays(base, parseInt(inDaysMatch[1], 10)));
  }

  // ISO format: already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Month name formats: "April 15", "April 15th", "15 April"
  const monthNameMatch = s.match(
    /^(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december))$/
  );
  if (monthNameMatch) {
    const MONTHS: Record<string, number> = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    };
    const monthStr = monthNameMatch[1] ?? monthNameMatch[4];
    const dayStr   = monthNameMatch[2] ?? monthNameMatch[3];
    const month    = MONTHS[monthStr];
    const day      = parseInt(dayStr, 10);
    if (month !== undefined && day >= 1 && day <= 31) {
      // Use current year; if the date has already passed, use next year.
      let year = base.getFullYear();
      const candidate = new Date(year, month, day);
      if (candidate < base) year++;
      return toYMD(new Date(year, month, day));
    }
  }

  // m/d or m/d/yyyy
  const numericDateMatch = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (numericDateMatch) {
    const m    = parseInt(numericDateMatch[1], 10) - 1;
    const d    = parseInt(numericDateMatch[2], 10);
    const year = numericDateMatch[3]
      ? parseInt(numericDateMatch[3], 10)
      : base.getFullYear();
    return toYMD(new Date(year, m, d));
  }

  return null;
}

// ─── Reminder Timing ──────────────────────────────────────────────────────────

/**
 * Given a deadline YYYY-MM-DD, compute the ISO datetime for the reminder:
 * one calendar day before the deadline at 09:00 in local time.
 *
 * If the deadline is today or already passed, schedule remindAt = now + 5 min
 * so it surfaces in the queue immediately rather than being silently missed.
 */
export function computeRemindAt(deadline: string): string {
  const [y, mo, d] = deadline.split("-").map(Number);
  const deadlineDate = new Date(y, mo - 1, d);
  const remindDate   = new Date(y, mo - 1, d - 1, 9, 0, 0, 0); // T-1 day at 9am

  const now = new Date();
  if (remindDate <= now) {
    // Deadline is today or in the past — remind in 5 min so it surfaces quickly.
    return new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  }

  return remindDate.toISOString();
}

// ─── Date Utilities ───────────────────────────────────────────────────────────

function toYMD(d: Date): string {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dd}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * Return the next occurrence of `targetDay` (0=Sun…6=Sat) starting from
 * the day AFTER `base`. If `base` is already `targetDay`, returns 7 days later.
 */
function nextWeekday(targetDay: number, base: Date): Date {
  const diff = ((targetDay - base.getDay() + 7) % 7) || 7;
  return addDays(base, diff);
}
