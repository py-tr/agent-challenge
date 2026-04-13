/**
 * src/pulse/lib/routeHelpers.ts
 * Pure helper functions shared across route handlers.
 * Exported here so they can be unit-tested without importing the full routes module.
 */

// ─── Sent-draft style memory ──────────────────────────────────────────────────

export interface SentDraftEntry {
  subject: string;
  body: string;
  sentAt: string;
}

/** Maximum number of sent-draft entries to keep in memory. */
export const STYLE_MEMORY_MAX = 10;

/**
 * Prepend a sent draft to the in-memory style-memory buffer, capping at
 * STYLE_MEMORY_MAX entries.  The most-recent draft is at index 0.
 *
 * @param memory  The mutable array to update (the caller owns it).
 */
export function recordSentDraft(
  memory: SentDraftEntry[],
  subject: string,
  body: string
): void {
  memory.unshift({ subject, body, sentAt: new Date().toISOString() });
  if (memory.length > STYLE_MEMORY_MAX) {
    memory.length = STYLE_MEMORY_MAX;
  }
}

// ─── Input sanitisation ───────────────────────────────────────────────────────

/** Minimal RFC 5322 email-address check — rejects obviously invalid values. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(addr: string): boolean {
  return EMAIL_RE.test(addr.trim());
}

/**
 * Sanitize a string before injecting it into an LLM prompt.
 * Strips carriage returns that could disrupt prompt structure,
 * and hard-caps length to prevent context flooding.
 */
export function sanitizeForPrompt(s: string, maxLen = 500): string {
  return s.replace(/\r/g, "").slice(0, maxLen);
}
