/**
 * Tests 3 & 4 — Action Queue: approve/reject flow + PGLite persistence
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeDb } from "./helpers.js";
import {
  insertActionItem,
  getActionItem,
  setActionItemStatus,
  insertDecision,
  getQueue,
  getDecisions,
} from "../db/queries.js";
import type { Db } from "../db/schema.js";

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

// ─── Test 3: Approve sets status + creates decision row ───────────────────────

describe("Approve flow", () => {
  it("insertActionItem creates a pending row", async () => {
    const item = await insertActionItem(db, {
      type: "email_draft",
      title: "Test email draft",
      body: "Please review and approve.",
      priority: 3,
    });

    expect(item.id).toBeTruthy();
    expect(item.status).toBe("pending");
    expect(item.type).toBe("email_draft");
  });

  it("setActionItemStatus to 'approved' updates the row", async () => {
    const item = await insertActionItem(db, {
      type: "email_draft",
      title: "Approve me",
      body: "Body text",
    });

    await setActionItemStatus(db, item.id, "approved");

    const fetched = await getActionItem(db, item.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("approved");
    expect(fetched!.decidedAt).not.toBeNull();
  });

  it("approved item does NOT appear in getQueue", async () => {
    const item = await insertActionItem(db, {
      type: "follow_up",
      title: "Follow-up draft",
      body: "Following up…",
    });

    await setActionItemStatus(db, item.id, "approved");

    const queue = await getQueue(db);
    const found = queue.find((i) => i.id === item.id);
    expect(found).toBeUndefined();
  });

  it("insertDecision creates a decision row linked to the item", async () => {
    const item = await insertActionItem(db, {
      type: "conflict_resolution",
      title: "Calendar conflict",
      body: "Two events overlap.",
      priority: 1,
    });

    await setActionItemStatus(db, item.id, "approved");
    const decision = await insertDecision(db, {
      actionItemId: item.id,
      decision: "approved",
      reason: null,
    });

    expect(decision.id).toBeTruthy();
    expect(decision.decision).toBe("approved");
    expect(decision.actionItemId).toBe(item.id);
  });
});

// ─── Test 4: Reject with reason ───────────────────────────────────────────────

describe("Reject flow", () => {
  it("setActionItemStatus to 'rejected' updates status", async () => {
    const item = await insertActionItem(db, {
      type: "slib_reminder",
      title: "Commitment reminder",
      body: "You committed to Mark by Wednesday.",
      priority: 2,
    });

    await setActionItemStatus(db, item.id, "rejected");

    const fetched = await getActionItem(db, item.id);
    expect(fetched!.status).toBe("rejected");
    expect(fetched!.decidedAt).not.toBeNull();
  });

  it("decision row stores rejection reason", async () => {
    const item = await insertActionItem(db, {
      type: "email_draft",
      title: "Draft to reject",
      body: "Reject me.",
    });

    await setActionItemStatus(db, item.id, "rejected");
    await insertDecision(db, {
      actionItemId: item.id,
      decision: "rejected",
      reason: "Tone is off",
    });

    const decisions = await getDecisions(db, 10);
    const d = decisions.find((x) => x.actionItemId === item.id);
    expect(d).toBeDefined();
    expect(d!.decision).toBe("rejected");
    expect(d!.reason).toBe("Tone is off");
  });

  it("rejected item is NOT deleted — still retrievable", async () => {
    const item = await insertActionItem(db, {
      type: "follow_up",
      title: "Rejected item",
      body: "Still exists.",
    });

    await setActionItemStatus(db, item.id, "rejected");

    const fetched = await getActionItem(db, item.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("rejected");
  });
});

// ─── Queue ordering ───────────────────────────────────────────────────────────

describe("Queue ordering", () => {
  it("getQueue returns items sorted by priority asc", async () => {
    // Insert out-of-order priorities
    await insertActionItem(db, { type: "follow_up", title: "Low", body: "", priority: 5 });
    await insertActionItem(db, { type: "conflict_resolution", title: "High", body: "", priority: 1 });
    await insertActionItem(db, { type: "email_draft", title: "Med", body: "", priority: 3 });

    const queue = await getQueue(db);
    const priorities = queue.map((i) => i.priority);
    // All pending items should be in ascending priority order
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]!).toBeGreaterThanOrEqual(priorities[i - 1]!);
    }
  });
});
