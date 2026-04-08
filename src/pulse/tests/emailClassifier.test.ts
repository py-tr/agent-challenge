/**
 * Test 5 — Email classification categories
 */

import { describe, it, expect } from "vitest";
import { classifyEmail } from "../lib/emailClassifier.js";
import { makeMockRuntime } from "./helpers.js";
import type { GmailMessage } from "../lib/gmailClient.js";

function makeMsg(override: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "msg-test-" + Math.random().toString(36).slice(2),
    subject: "Test email",
    from: "sender@example.com",
    date: new Date().toISOString(),
    snippet: "Test snippet",
    ...override,
  };
}

describe("Email classifier — LLM path", () => {
  it("maps LLM 'action-required' to email_draft type with priority 3", async () => {
    const runtime = makeMockRuntime({ modelResponse: "action-required" });
    const result = await classifyEmail(runtime, makeMsg({ subject: "Please review" }));

    expect(result.category).toBe("action-required");
    expect(result.actionItemType).toBe("email_draft");
    expect(result.priority).toBe(3);
  });

  it("maps LLM 'follow-up' to follow_up type with priority 5", async () => {
    const runtime = makeMockRuntime({ modelResponse: "follow-up" });
    const result = await classifyEmail(runtime, makeMsg());

    expect(result.category).toBe("follow-up");
    expect(result.actionItemType).toBe("follow_up");
    expect(result.priority).toBe(5);
  });

  it("maps LLM 'noise' to null actionItemType (skip queue)", async () => {
    const runtime = makeMockRuntime({ modelResponse: "noise" });
    const result = await classifyEmail(
      runtime,
      makeMsg({ subject: "Weekly newsletter" })
    );

    expect(result.category).toBe("noise");
    expect(result.actionItemType).toBeNull();
  });

  it("maps LLM 'commitment' to null actionItemType (handled by Slib Guard)", async () => {
    const runtime = makeMockRuntime({ modelResponse: "commitment" });
    const result = await classifyEmail(
      runtime,
      makeMsg({ subject: "Talk Thursday" })
    );

    expect(result.category).toBe("commitment");
    expect(result.actionItemType).toBeNull();
  });
});

describe("Email classifier — heuristic fallback", () => {
  it("completes without crash when LLM throws", async () => {
    const runtime = makeMockRuntime();
    (runtime as { useModel: unknown }).useModel = async () => {
      throw new Error("LLM unavailable");
    };

    const result = await classifyEmail(
      runtime,
      makeMsg({ subject: "Newsletter: Top picks this week" })
    );

    // No crash — classification completes
    expect(["noise", "follow-up", "action-required", "commitment"]).toContain(
      result.category
    );
  });

  it("body is always a non-empty string", async () => {
    const runtime = makeMockRuntime({ modelResponse: "action-required" });
    const result = await classifyEmail(
      runtime,
      makeMsg({ subject: "Review Q1 report", snippet: "Can you check this?" })
    );

    expect(typeof result.body).toBe("string");
    expect(result.body.length).toBeGreaterThan(0);
  });
});
