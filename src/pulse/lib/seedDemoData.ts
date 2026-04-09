/**
 * src/pulse/lib/seedDemoData.ts
 * Inserts realistic demo data into PGLite so the dashboard is populated on
 * first launch without needing Gmail / Calendar credentials.
 *
 * Called by PulseBackgroundService when PULSE_SEED_ON_START=true AND the
 * action queue is empty (guard is in the caller — this function just inserts).
 *
 * The same data is defined in scripts/seed-demo.ts for the manual CLI workflow;
 * keep them in sync when updating demo content.
 */

import { actionItems, decisions, type Db } from "../db/schema.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface SeedResult {
  pending:    number;
  historical: number;
}

// ─── Seed function ────────────────────────────────────────────────────────────

/**
 * Insert 5 pending action items + 3 historical items with decisions.
 * Does NOT clear existing data — caller is responsible for checking
 * the queue is empty before calling.
 */
export async function seedDemoData(db: Db): Promise<SeedResult> {
  // ── Pending items ──────────────────────────────────────────────────────────

  const pendingItems = [
    {
      id:        crypto.randomUUID(),
      type:      "conflict_resolution" as const,
      title:     "Calendar conflict: Q2 Review ↔ Sarah 1:1 (Thu 2pm)",
      body:
        "Two events overlap on Thursday at 14:00–15:00:\n\n" +
        "• Q2 Business Review (14:00–15:30) — org-wide, you are a presenter\n" +
        "• Sarah 1:1 (14:00–15:00) — recurring weekly\n\n" +
        "Suggested resolution: reschedule the 1:1 to Thursday 15:30 or Friday 10:00. " +
        "Sarah has both slots free.\n\n" +
        "**Approve** to acknowledge this conflict is handled, or **Reject** to dismiss it.",
      metadata:  JSON.stringify({
        eventAId: "cal-ev-001", eventATitle: "Q2 Business Review",
        eventBId: "cal-ev-002", eventBTitle: "Sarah 1:1",
        overlapMinutes: 60,
        date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
      }),
      status:    "pending" as const,
      priority:  1,
      createdAt: hoursAgo(2),
      decidedAt: null,
    },
    {
      id:        crypto.randomUUID(),
      type:      "slib_reminder" as const,
      title:     "Slib Guard: proposal for Mark due tomorrow",
      body:
        "In your email to Mark (3 days ago) you wrote:\n\n" +
        "  \"I'll send over the updated pricing proposal by end of week.\"\n\n" +
        "Tomorrow is Friday and no follow-up has been sent.\n\n" +
        "**Approve** to confirm this commitment is on track, or **Reject** to dismiss it.",
      metadata:  JSON.stringify({
        commitmentId: "commitment-seed-001",
        recipient:    "Mark",
        deadline:     new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10),
        verbatim:     "I'll send over the updated pricing proposal by end of week.",
      }),
      status:    "pending" as const,
      priority:  2,
      createdAt: hoursAgo(1),
      decidedAt: null,
    },
    {
      id:        crypto.randomUUID(),
      type:      "follow_up" as const,
      title:     "Follow-up: Elena hasn't replied in 5 days",
      body:
        "You emailed Elena on April 3rd about the design review brief. " +
        "No reply has been received (5 days).\n\n" +
        "Pulse drafted a gentle follow-up:\n\n" +
        "---\nHi Elena,\n\nJust checking in — did you get a chance to look at the " +
        "design review brief I sent last week? Happy to jump on a quick call " +
        "if that's easier.\n\nBest,\n\n" +
        "---\n\n**Approve** to mark as handled. To send, ask Pulse: _\"Draft a reply to Elena\"_",
      metadata:  JSON.stringify({
        gmailMessageId: "gmail-thread-def456",
        from:           "Elena <elena@example.com>",
        date:           daysAgo(5),
        category:       "follow-up",
      }),
      status:    "pending" as const,
      priority:  4,
      createdAt: daysAgo(1),
      decidedAt: null,
    },
    {
      id:        crypto.randomUUID(),
      type:      "email_draft" as const,
      title:     "Draft: reply to James re: onboarding timeline",
      body:
        "**From:** James <james@example.com>\n" +
        "**Subject:** Onboarding timeline for Alex\n\n" +
        "---\n\n" +
        "**Suggested reply scaffold:**\n\n" +
        "Hi James,\n\nThanks for reaching out. We have onboarding slots available " +
        "on April 14 (10am–12pm) and April 16 (2pm–4pm). " +
        "Let me know which works for your team and I'll send a calendar invite.\n\nBest,\n\n" +
        "---\n\n" +
        "**Approve** to mark this email as handled and log the decision.\n" +
        "**Reject** to dismiss it from your queue.\n\n" +
        "To send a reply, ask Pulse: _\"Draft a reply to james@example.com\"_",
      metadata:  JSON.stringify({
        gmailMessageId: "gmail-thread-ghi789",
        from:           "James <james@example.com>",
        date:           daysAgo(2),
        category:       "action-required",
      }),
      status:    "pending" as const,
      priority:  5,
      createdAt: daysAgo(2),
      decidedAt: null,
    },
    {
      id:        crypto.randomUUID(),
      type:      "slib_reminder" as const,
      title:     "Slib Guard: send budget forecast to Finance by Apr 18",
      body:
        "Detected in your email to Anna (Finance):\n\n" +
        "  \"I'll have the Q2 budget forecast ready by April 18.\"\n\n" +
        "Deadline is in 10 days. No action required yet, but this reminder " +
        "is here so it doesn't slip through the cracks.\n\n" +
        "**Approve** to confirm this commitment is on track, or **Reject** to dismiss it.",
      metadata:  JSON.stringify({
        commitmentId: "commitment-seed-002",
        recipient:    "Anna",
        deadline:     new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
        verbatim:     "I'll have the Q2 budget forecast ready by April 18.",
      }),
      status:    "pending" as const,
      priority:  7,
      createdAt: daysAgo(3),
      decidedAt: null,
    },
  ];

  // ── Historical items + decisions ───────────────────────────────────────────

  type HistoricalStatus = "approved" | "rejected";
  const historicalItems: Array<{
    item: typeof actionItems.$inferInsert;
    decision: HistoricalStatus;
    reason: string | null;
  }> = [
    {
      item: {
        id:        crypto.randomUUID(),
        type:      "email_draft",
        title:     "Draft: reply to client NDA enquiry",
        body:      "(approved and sent)",
        metadata:  null,
        status:    "approved",
        priority:  3,
        createdAt: daysAgo(5),
        decidedAt: daysAgo(4),
      },
      decision: "approved",
      reason:   null,
    },
    {
      item: {
        id:        crypto.randomUUID(),
        type:      "conflict_resolution",
        title:     "Calendar conflict: All-hands ↔ Dentist appointment",
        body:      "(approved — resolved by rescheduling dentist)",
        metadata:  null,
        status:    "approved",
        priority:  2,
        createdAt: daysAgo(7),
        decidedAt: daysAgo(7),
      },
      decision: "approved",
      reason:   null,
    },
    {
      item: {
        id:        crypto.randomUUID(),
        type:      "follow_up",
        title:     "Follow-up: vendor pricing request",
        body:      "(rejected — not needed)",
        metadata:  null,
        status:    "rejected",
        priority:  6,
        createdAt: daysAgo(10),
        decidedAt: daysAgo(9),
      },
      decision: "rejected",
      reason:   "Not needed at this time",
    },
  ];

  // ── Insert ─────────────────────────────────────────────────────────────────

  for (const item of pendingItems) {
    await db.insert(actionItems).values(item);
  }

  for (const { item, decision, reason } of historicalItems) {
    await db.insert(actionItems).values(item);
    await db.insert(decisions).values({
      id:           crypto.randomUUID(),
      actionItemId: item.id as string,
      decision,
      reason,
      decidedAt:    item.decidedAt as string,
    });
  }

  return {
    pending:    pendingItems.length,
    historical: historicalItems.length,
  };
}
