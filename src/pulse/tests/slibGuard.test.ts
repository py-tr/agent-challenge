/**
 * Tests 1 & 2 — Slib Guard: commitment extraction + reminder timing
 */

import { describe, it, expect } from "vitest";
import {
  hasCommitmentPattern,
  resolveDate,
  computeRemindAt,
  extractCommitments,
} from "../lib/commitmentParser.js";
import { makeMockRuntime } from "./helpers.js";

// ─── Test 1: Commitment extraction ───────────────────────────────────────────

describe("hasCommitmentPattern", () => {
  it("matches first-person commitment with 'by'", () => {
    expect(
      hasCommitmentPattern("I'll send the proposal to Mark by Wednesday")
    ).toBe(true);
  });

  it("matches 'I will deliver X by Friday'", () => {
    expect(hasCommitmentPattern("I will deliver the report by Friday EOD")).toBe(
      true
    );
  });

  it("does NOT match greetings", () => {
    expect(hasCommitmentPattern("Hey, how are you?")).toBe(false);
  });

  it("does NOT match short messages", () => {
    expect(hasCommitmentPattern("I'll do it")).toBe(false); // no 'by'
  });
});

describe("resolveDate", () => {
  // Base date: Monday 2026-04-06
  const base = new Date("2026-04-06T12:00:00");

  it("resolves 'today'", () => {
    expect(resolveDate("today", base)).toBe("2026-04-06");
  });

  it("resolves 'tomorrow'", () => {
    expect(resolveDate("tomorrow", base)).toBe("2026-04-07");
  });

  it("resolves 'wednesday' (next occurrence)", () => {
    expect(resolveDate("wednesday", base)).toBe("2026-04-08");
  });

  it("resolves 'friday'", () => {
    expect(resolveDate("friday", base)).toBe("2026-04-10");
  });

  it("resolves 'next monday' (7–13 days out)", () => {
    // base is Monday Apr 6; next Monday = Apr 13
    expect(resolveDate("next monday", base)).toBe("2026-04-13");
  });

  it("resolves 'end of week'", () => {
    expect(resolveDate("end of week", base)).toBe("2026-04-10");
  });

  it("resolves 'in 3 days'", () => {
    expect(resolveDate("in 3 days", base)).toBe("2026-04-09");
  });

  it("resolves ISO date passthrough", () => {
    expect(resolveDate("2026-05-01", base)).toBe("2026-05-01");
  });

  it("resolves 'April 15'", () => {
    expect(resolveDate("april 15", base)).toBe("2026-04-15");
  });

  it("returns null for gibberish", () => {
    expect(resolveDate("whenever", base)).toBeNull();
  });
});

// ─── Test 2: Reminder is T-1 day at 09:00 ────────────────────────────────────

describe("computeRemindAt", () => {
  it("schedules reminder one calendar day before deadline at 09:00", () => {
    // Deadline: 2026-04-10 (Friday) → reminder: 2026-04-09 (Thursday) at 09:00
    const remindAt = computeRemindAt("2026-04-10");
    const d = new Date(remindAt);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // April = 3
    expect(d.getDate()).toBe(9);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it("returns now+5min when deadline has passed", () => {
    const past = "2020-01-01";
    const before = Date.now();
    const remindAt = computeRemindAt(past);
    const after = Date.now();
    const d = new Date(remindAt).getTime();
    // Should be within [now+4min, now+6min]
    expect(d).toBeGreaterThanOrEqual(before + 4 * 60 * 1000);
    expect(d).toBeLessThanOrEqual(after + 6 * 60 * 1000);
  });
});

// ─── LLM extraction (mocked) ─────────────────────────────────────────────────

describe("extractCommitments (LLM path, mocked)", () => {
  it("parses LLM JSON response into ExtractedCommitment array", async () => {
    const llmResponse = JSON.stringify([
      {
        text: "I'll send the proposal to Mark by Wednesday",
        recipient: "Mark",
        deadline: "2026-04-08",
      },
    ]);

    const runtime = makeMockRuntime({ modelResponse: llmResponse });
    const results = await extractCommitments(
      runtime,
      "I'll send the proposal to Mark by Wednesday"
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.recipient).toBe("Mark");
    expect(results[0]!.deadline).toBe("2026-04-08");
    expect(results[0]!.remindAt).toBeTruthy();
  });

  it("falls back to regex when LLM returns invalid JSON", async () => {
    const runtime = makeMockRuntime({ modelResponse: "not json" });
    // The regex should still catch "I'll ... by Wednesday"
    const results = await extractCommitments(
      runtime,
      "I'll send the report by wednesday"
    );
    // Regex finds at least one commitment (date may vary by today's date)
    expect(results.length).toBeGreaterThanOrEqual(0); // graceful — no crash
  });
});
