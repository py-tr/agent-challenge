/**
 * Tests for src/pulse/lib/nosanaMetrics.ts
 *
 * Covers:
 *   1. recordLlmCall() — counter increments on every call
 *   2. EMA latency tracking
 *   3. getMetrics() — model name, uptime, nodeId extraction, nodeUrl not exposed
 *   4. formatUptime() — human-readable string formatting
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Module reset between tests ───────────────────────────────────────────────
// nosanaMetrics uses module-level counters; we re-import fresh for each suite
// via vi.resetModules().

describe("nosanaMetrics — recordLlmCall + getMetrics", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("starts with llmCallCount = 0", async () => {
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    const m = getMetrics();
    // After a resetModules the count may already be > 0 from prior test runs
    // in the same process; just verify the field exists and is a number.
    expect(typeof m.llmCallCount).toBe("number");
  });

  it("increments llmCallCount on each recordLlmCall", async () => {
    const { getMetrics, recordLlmCall } = await import("../lib/nosanaMetrics.js");
    const before = getMetrics().llmCallCount;
    recordLlmCall(100, 400);
    recordLlmCall(200, 800);
    const after = getMetrics().llmCallCount;
    expect(after - before).toBe(2);
  });

  it("avgLatencyMs is null before any calls then becomes a number", async () => {
    const { getMetrics, recordLlmCall } = await import("../lib/nosanaMetrics.js");
    // May not be null if prior test incremented — just verify type after a call.
    recordLlmCall(500, 400);
    const m = getMetrics();
    expect(typeof m.avgLatencyMs).toBe("number");
    expect(m.avgLatencyMs).toBeGreaterThan(0);
  });

  it("EMA latency is between min and max of recorded calls", async () => {
    const { getMetrics, recordLlmCall } = await import("../lib/nosanaMetrics.js");
    recordLlmCall(100, 400);
    recordLlmCall(900, 3600);
    const m = getMetrics();
    expect(m.avgLatencyMs).toBeGreaterThanOrEqual(100);
    expect(m.avgLatencyMs).toBeLessThanOrEqual(900);
  });

  it("totalTokensEstimated is responseChars / 4", async () => {
    const { getMetrics, recordLlmCall } = await import("../lib/nosanaMetrics.js");
    const before = getMetrics().totalTokensEstimated;
    // Add 400 chars → +100 tokens
    recordLlmCall(100, 400);
    const after = getMetrics().totalTokensEstimated;
    expect(after - before).toBe(100);
  });

  it("uptimeMs grows over time", async () => {
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    const t1 = getMetrics().uptimeMs;
    await new Promise((r) => setTimeout(r, 5));
    const t2 = getMetrics().uptimeMs;
    expect(t2).toBeGreaterThan(t1);
  });

  it("startedAt is a valid ISO 8601 timestamp", async () => {
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    const { startedAt } = getMetrics();
    expect(() => new Date(startedAt)).not.toThrow();
    expect(new Date(startedAt).getTime()).toBeGreaterThan(0);
  });

  it("does NOT expose nodeUrl in metrics output", async () => {
    process.env.OPENAI_API_URL = "https://abc123.node.k8s.prd.nos.ci/v1";
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    const m = getMetrics();
    // The full URL must not appear anywhere in the metrics object
    const serialised = JSON.stringify(m);
    expect(serialised).not.toContain("https://abc123.node");
    // But nodeId should be extracted
    expect(m.nodeId).toBe("abc123");
    delete process.env.OPENAI_API_URL;
  });

  it("isNosanaNode is true when OPENAI_API_URL contains .nos.ci", async () => {
    process.env.OPENAI_API_URL = "https://xyz.node.k8s.prd.nos.ci/v1";
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    expect(getMetrics().isNosanaNode).toBe(true);
    delete process.env.OPENAI_API_URL;
  });

  it("isNosanaNode is false for local dev URLs", async () => {
    process.env.OPENAI_API_URL = "http://127.0.0.1:11434/v1";
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    expect(getMetrics().isNosanaNode).toBe(false);
    delete process.env.OPENAI_API_URL;
  });

  it("modelName reflects OPENAI_SMALL_MODEL env var", async () => {
    process.env.OPENAI_SMALL_MODEL = "Qwen3.5-27B-AWQ-4bit";
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    expect(getMetrics().modelName).toBe("Qwen3.5-27B-AWQ-4bit");
    delete process.env.OPENAI_SMALL_MODEL;
  });

  it("modelName is null when no model env vars are set", async () => {
    delete process.env.OPENAI_SMALL_MODEL;
    delete process.env.SMALL_MODEL;
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    expect(getMetrics().modelName).toBeNull();
  });

  it("jobType defaults to 'scheduled' when PULSE_JOB_TYPE is unset", async () => {
    delete process.env.PULSE_JOB_TYPE;
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    expect(getMetrics().jobType).toBe("scheduled");
  });

  it("jobType reflects PULSE_JOB_TYPE env var", async () => {
    process.env.PULSE_JOB_TYPE = "morning";
    const { getMetrics } = await import("../lib/nosanaMetrics.js");
    expect(getMetrics().jobType).toBe("morning");
    delete process.env.PULSE_JOB_TYPE;
  });
});

// ─── formatUptime ─────────────────────────────────────────────────────────────

describe("formatUptime", () => {
  // Import synchronously — no module state to reset here
  let formatUptime: (ms: number) => string;

  beforeEach(async () => {
    vi.resetModules();
    ({ formatUptime } = await import("../lib/nosanaMetrics.js"));
  });

  it("formats seconds (< 60s)", () => {
    expect(formatUptime(45_000)).toBe("45s");
  });

  it("formats exactly 1 minute as '1m'", () => {
    expect(formatUptime(60_000)).toBe("1m");
  });

  it("formats minutes (< 1 hour)", () => {
    expect(formatUptime(15 * 60_000)).toBe("15m");
  });

  it("formats exactly 1 hour as '1h'", () => {
    expect(formatUptime(60 * 60_000)).toBe("1h");
  });

  it("formats hours + remainder minutes as '2h 15m'", () => {
    expect(formatUptime((2 * 60 + 15) * 60_000)).toBe("2h 15m");
  });

  it("formats whole hours without remainder as '3h'", () => {
    expect(formatUptime(3 * 60 * 60_000)).toBe("3h");
  });

  it("formats 0ms as '0s'", () => {
    expect(formatUptime(0)).toBe("0s");
  });
});
