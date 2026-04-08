/**
 * Test 7 — Providers: ActionQueueProvider + DecisionHistoryProvider output format
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeDb, makeMockRuntime } from "./helpers.js";
import { actionQueueProvider } from "../providers/ActionQueueProvider.js";
import { decisionHistoryProvider } from "../providers/DecisionHistoryProvider.js";
import {
  insertActionItem,
  insertDecision,
  setActionItemStatus,
} from "../db/queries.js";
import type { Db } from "../db/schema.js";
import type { State } from "@elizaos/core";

// Cast to satisfy Provider.get()'s required State param in tests
const STATE = {} as State;

let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  const result = await makeDb();
  db = result.db;
  closeDb = result.close;
});

afterAll(async () => {
  await closeDb();
});

describe("ActionQueueProvider", () => {
  it("returns empty-queue message when no items pending", async () => {
    const runtime = makeMockRuntime({ db });
    const result = await actionQueueProvider.get(runtime, {} as never, STATE);

    expect(typeof result.text).toBe("string");
    expect(result.text).toContain("queue");
  });

  it("includes item count and title when items are pending", async () => {
    await insertActionItem(db, {
      type: "email_draft",
      title: "Proposal for Sarah",
      body: "Draft body",
      priority: 3,
    });

    const runtime = makeMockRuntime({ db });
    const result = await actionQueueProvider.get(runtime, {} as never, STATE);

    expect(result.text).toContain("Pending Approval Queue");
    expect(result.text).toContain("Proposal for Sarah");
    expect(result.text).toMatch(/\d+ item/);
  });

  it("mentions item type and priority", async () => {
    const runtime = makeMockRuntime({ db });
    const result = await actionQueueProvider.get(runtime, {} as never, STATE);

    expect(result.text).toMatch(/email_draft|conflict_resolution|slib_reminder|follow_up/);
    expect(result.text).toMatch(/P\d/);
  });
});

describe("DecisionHistoryProvider", () => {
  it("returns no-decisions message when history is empty", async () => {
    const { db: emptyDb, close } = await makeDb();
    const runtime = makeMockRuntime({ db: emptyDb });
    const result = await decisionHistoryProvider.get(runtime, {} as never, STATE);
    await close();

    expect(result.text).toContain("No decisions");
  });

  it("includes decision count and approved/rejected markers", async () => {
    const item = await insertActionItem(db, {
      type: "conflict_resolution",
      title: "Team sync conflict",
      body: "Two events overlap.",
      priority: 1,
    });
    await setActionItemStatus(db, item.id, "approved");
    await insertDecision(db, { actionItemId: item.id, decision: "approved" });

    const runtime = makeMockRuntime({ db });
    const result = await decisionHistoryProvider.get(runtime, {} as never, STATE);

    expect(result.text).toContain("Recent Decisions");
    expect(result.text).toMatch(/APPROVED|REJECTED/);
  });

  it("shows pattern summary after 10+ decisions", async () => {
    for (let i = 0; i < 10; i++) {
      const item = await insertActionItem(db, {
        type: "email_draft",
        title: `Draft ${i}`,
        body: "",
      });
      await setActionItemStatus(db, item.id, "approved");
      await insertDecision(db, { actionItemId: item.id, decision: "approved" });
    }

    const runtime = makeMockRuntime({ db });
    const result = await decisionHistoryProvider.get(runtime, {} as never, STATE);

    expect(result.text).toContain("Approval patterns");
    expect(result.text).toContain("email draft");
  });
});
