/**
 * Test 8 — DB migrations + CRUD from clean state
 *
 * Creates a fresh in-memory PGLite, runs migrations, then verifies
 * full CRUD across all three Pulse tables.
 */

import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers.js";
import {
  insertActionItem,
  getActionItem,
  getQueue,
  setActionItemStatus,
  insertCommitment,
  getPendingReminders,
  markReminderSent,
  insertDecision,
  getDecisions,
  countByStatus,
  countDecisions,
} from "../db/queries.js";

describe("DB persistence from clean state", () => {
  it("runs migrations and all three tables are writable", async () => {
    const { db, close } = await makeDb();

    try {
      // ── pulse_action_items ────────────────────────────────────────────────
      const item = await insertActionItem(db, {
        type: "email_draft",
        title: "Test item",
        body: "Body text",
        metadata: { gmailMessageId: "abc123" },
        priority: 3,
      });

      expect(item.id).toBeTruthy();
      expect(item.status).toBe("pending");
      expect(item.metadata).toMatchObject({ gmailMessageId: "abc123" });

      const fetched = await getActionItem(db, item.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe("Test item");
      expect(fetched!.priority).toBe(3);

      // ── pulse_commitments ─────────────────────────────────────────────────
      const pastRemindAt = new Date(Date.now() - 1000).toISOString();
      const commitment = await insertCommitment(db, {
        text: "I'll send the proposal to Mark by Wednesday",
        recipient: "Mark",
        deadline: "2026-04-08",
        remindAt: pastRemindAt, // in the past so it shows in getPendingReminders
        sourceMessageId: null,
      });

      expect(commitment.id).toBeTruthy();
      expect(commitment.recipient).toBe("Mark");
      expect(commitment.reminderSent).toBe(false);

      const pending = await getPendingReminders(db);
      expect(pending.some((c) => c.id === commitment.id)).toBe(true);

      // Link an action item to the commitment
      const reminderItem = await insertActionItem(db, {
        type: "slib_reminder",
        title: "Commitment to Mark: 2026-04-08",
        body: "You committed to Mark by Wednesday.",
        priority: 2,
      });
      await markReminderSent(db, commitment.id, reminderItem.id);

      const afterMark = await getPendingReminders(db);
      expect(afterMark.some((c) => c.id === commitment.id)).toBe(false);

      // ── pulse_decisions ───────────────────────────────────────────────────
      await setActionItemStatus(db, item.id, "approved");
      const decision = await insertDecision(db, {
        actionItemId: item.id,
        decision: "approved",
        reason: "Looks good",
      });

      expect(decision.id).toBeTruthy();
      expect(decision.decision).toBe("approved");
      expect(decision.reason).toBe("Looks good");

      const decisions = await getDecisions(db, 10);
      expect(decisions.some((d) => d.id === decision.id)).toBe(true);

      // ── Counts ────────────────────────────────────────────────────────────
      // item was approved; reminderItem is still pending
      const pendingCount = await countByStatus(db, "pending");
      expect(pendingCount).toBeGreaterThanOrEqual(1);

      const approvedCount = await countByStatus(db, "approved");
      expect(approvedCount).toBeGreaterThanOrEqual(1);

      const totalDecisions = await countDecisions(db);
      expect(totalDecisions).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
  });

  it("getQueue only returns pending items, ordered by priority", async () => {
    const { db, close } = await makeDb();

    try {
      const high = await insertActionItem(db, { type: "conflict_resolution", title: "High", body: "", priority: 1 });
      const mid  = await insertActionItem(db, { type: "email_draft",          title: "Mid",  body: "", priority: 3 });
      const low  = await insertActionItem(db, { type: "follow_up",            title: "Low",  body: "", priority: 5 });

      // Approve one
      await setActionItemStatus(db, low.id, "approved");

      const queue = await getQueue(db);

      // Only pending items
      expect(queue.every((i) => i.status === "pending")).toBe(true);
      expect(queue.some((i) => i.id === low.id)).toBe(false);

      // Priority order
      const ids = queue.map((i) => i.id);
      const hiIdx  = ids.indexOf(high.id);
      const midIdx = ids.indexOf(mid.id);
      expect(hiIdx).toBeLessThan(midIdx);
    } finally {
      await close();
    }
  });
});
