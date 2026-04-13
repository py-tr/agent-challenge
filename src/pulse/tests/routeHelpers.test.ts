/**
 * Tests for src/pulse/lib/routeHelpers.ts
 *
 * Covers:
 *   1. sanitizeForPrompt() — truncation + CR stripping
 *   2. isValidEmail()       — valid/invalid address detection
 *   3. recordSentDraft()    — max 10 entries cap + ordering
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeForPrompt,
  isValidEmail,
  recordSentDraft,
  STYLE_MEMORY_MAX,
  type SentDraftEntry,
} from "../lib/routeHelpers.js";

// ─── sanitizeForPrompt ────────────────────────────────────────────────────────

describe("sanitizeForPrompt", () => {
  it("returns the string unchanged when within maxLen and no CR chars", () => {
    const s = "Hello, world!";
    expect(sanitizeForPrompt(s, 100)).toBe(s);
  });

  it("truncates to maxLen characters", () => {
    const s = "a".repeat(600);
    const result = sanitizeForPrompt(s, 500);
    expect(result).toHaveLength(500);
  });

  it("uses default maxLen of 500 when not specified", () => {
    const s = "x".repeat(600);
    expect(sanitizeForPrompt(s)).toHaveLength(500);
  });

  it("strips carriage returns (\\r)", () => {
    const s = "line1\r\nline2\r\nline3";
    expect(sanitizeForPrompt(s, 100)).toBe("line1\nline2\nline3");
  });

  it("strips CR before truncating", () => {
    // 300 chars of 'a\r' = 600 chars raw; after CR strip = 300 'a\n' pairs.
    // With maxLen=10, result should be 10 chars and contain no \r.
    const s = "a\r".repeat(300);
    const result = sanitizeForPrompt(s, 10);
    expect(result).toHaveLength(10);
    expect(result).not.toContain("\r");
  });

  it("handles empty string", () => {
    expect(sanitizeForPrompt("", 100)).toBe("");
  });

  it("handles string shorter than maxLen", () => {
    const s = "short";
    expect(sanitizeForPrompt(s, 1000)).toBe("short");
  });
});

// ─── isValidEmail ─────────────────────────────────────────────────────────────

describe("isValidEmail", () => {
  it("accepts a standard email address", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
  });

  it("accepts email with subdomain", () => {
    expect(isValidEmail("user@mail.example.co.uk")).toBe(true);
  });

  it("accepts email with plus sign in local part", () => {
    expect(isValidEmail("user+tag@example.com")).toBe(true);
  });

  it("accepts email with dots in local part", () => {
    expect(isValidEmail("first.last@example.org")).toBe(true);
  });

  it("accepts email with leading/trailing whitespace (trims)", () => {
    expect(isValidEmail("  user@example.com  ")).toBe(true);
  });

  it("rejects address with no @", () => {
    expect(isValidEmail("notanemail")).toBe(false);
  });

  it("rejects address with no domain", () => {
    expect(isValidEmail("user@")).toBe(false);
  });

  it("rejects address with no TLD (single-part domain)", () => {
    expect(isValidEmail("user@localhost")).toBe(false);
  });

  it("rejects address with spaces inside", () => {
    expect(isValidEmail("user @example.com")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });

  it("rejects address with two @ signs", () => {
    expect(isValidEmail("a@b@c.com")).toBe(false);
  });
});

// ─── recordSentDraft ─────────────────────────────────────────────────────────

describe("recordSentDraft", () => {
  it("adds an entry to an empty memory array", () => {
    const memory: SentDraftEntry[] = [];
    recordSentDraft(memory, "Subject A", "Body A");
    expect(memory).toHaveLength(1);
    expect(memory[0]!.subject).toBe("Subject A");
    expect(memory[0]!.body).toBe("Body A");
  });

  it("inserts new entries at index 0 (most recent first)", () => {
    const memory: SentDraftEntry[] = [];
    recordSentDraft(memory, "First", "Body 1");
    recordSentDraft(memory, "Second", "Body 2");
    expect(memory[0]!.subject).toBe("Second");
    expect(memory[1]!.subject).toBe("First");
  });

  it("sets sentAt to an ISO timestamp string", () => {
    const memory: SentDraftEntry[] = [];
    const before = new Date().toISOString();
    recordSentDraft(memory, "S", "B");
    const after = new Date().toISOString();
    expect(memory[0]!.sentAt >= before).toBe(true);
    expect(memory[0]!.sentAt <= after).toBe(true);
  });

  it(`caps at STYLE_MEMORY_MAX (${STYLE_MEMORY_MAX}) entries`, () => {
    const memory: SentDraftEntry[] = [];
    for (let i = 0; i < STYLE_MEMORY_MAX + 5; i++) {
      recordSentDraft(memory, `Subject ${i}`, `Body ${i}`);
    }
    expect(memory).toHaveLength(STYLE_MEMORY_MAX);
  });

  it("keeps the most recent entries when cap is reached", () => {
    const memory: SentDraftEntry[] = [];
    for (let i = 0; i < STYLE_MEMORY_MAX + 3; i++) {
      recordSentDraft(memory, `Subject ${i}`, `Body ${i}`);
    }
    // Most recent is Subject 12 (index 0)
    expect(memory[0]!.subject).toBe(`Subject ${STYLE_MEMORY_MAX + 2}`);
    // Oldest kept is at STYLE_MEMORY_MAX - 1
    const oldestKept = memory[STYLE_MEMORY_MAX - 1]!.subject;
    // It should NOT be Subject 0 (which was pushed out)
    expect(oldestKept).not.toBe("Subject 0");
  });

  it("does not mutate a different memory array", () => {
    const memA: SentDraftEntry[] = [];
    const memB: SentDraftEntry[] = [];
    recordSentDraft(memA, "A", "a");
    expect(memB).toHaveLength(0);
  });
});
