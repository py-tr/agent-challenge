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
 * Insert 8 pending action items (2 of each type) + 8 historical items with
 * decisions spread across the last 7 days for analytics chart data.
 * Does NOT clear existing data — caller is responsible for checking
 * the queue is empty before calling.
 */
export async function seedDemoData(db: Db): Promise<SeedResult> {
  const tomorrow = new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10);
  const in10days = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

  // ── Pending items — 2 of each type ────────────────────────────────────────

  const pendingItems = [
    // ── conflict_resolution × 2 ────────────────────────────────────────────
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
      type:      "conflict_resolution" as const,
      title:     "Calendar conflict: Team stand-up ↔ Investor call (Mon 9am)",
      body:
        "Two events overlap on Monday at 09:00–09:30:\n\n" +
        "• Daily Team Stand-up (09:00–09:15) — recurring daily\n" +
        "• Investor Call with VC Partners (09:00–10:00) — high priority\n\n" +
        "Suggested resolution: skip the stand-up on Monday or move it to 09:30. " +
        "The investor call cannot be moved.\n\n" +
        "**Approve** to acknowledge, or **Reject** to dismiss.",
      metadata:  JSON.stringify({
        eventAId: "cal-ev-003", eventATitle: "Daily Stand-up",
        eventBId: "cal-ev-004", eventBTitle: "Investor Call",
        overlapMinutes: 15,
        date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      }),
      status:    "pending" as const,
      priority:  2,
      createdAt: hoursAgo(1),
      decidedAt: null,
    },

    // ── slib_reminder × 2 ──────────────────────────────────────────────────
    {
      id:        crypto.randomUUID(),
      type:      "slib_reminder" as const,
      title:     "Slib Guard: pricing proposal for Mark due tomorrow",
      body:
        "In your email to Mark (3 days ago) you wrote:\n\n" +
        "  \"I'll send over the updated pricing proposal by end of week.\"\n\n" +
        "Tomorrow is Friday and no follow-up has been sent.\n\n" +
        "**Approve** to confirm this commitment is on track, or **Reject** to dismiss it.",
      metadata:  JSON.stringify({
        commitmentId: "commitment-seed-001",
        recipient:    "Mark",
        deadline:     tomorrow,
        verbatim:     "I'll send over the updated pricing proposal by end of week.",
      }),
      status:    "pending" as const,
      priority:  2,
      createdAt: hoursAgo(3),
      decidedAt: null,
    },
    {
      id:        crypto.randomUUID(),
      type:      "slib_reminder" as const,
      title:     "Slib Guard: Q2 budget forecast for Finance by Apr 18",
      body:
        "Detected in your email to Anna (Finance):\n\n" +
        "  \"I'll have the Q2 budget forecast ready by April 18.\"\n\n" +
        `Deadline is ${in10days}. No action required yet, but flagged so it doesn't slip.\n\n` +
        "**Approve** to confirm on track, or **Reject** to dismiss.",
      metadata:  JSON.stringify({
        commitmentId: "commitment-seed-002",
        recipient:    "Anna",
        deadline:     in10days,
        verbatim:     "I'll have the Q2 budget forecast ready by April 18.",
      }),
      status:    "pending" as const,
      priority:  7,
      createdAt: daysAgo(3),
      decidedAt: null,
    },

    // ── follow_up × 2 ──────────────────────────────────────────────────────
    {
      id:        crypto.randomUUID(),
      type:      "follow_up" as const,
      title:     "No reply: \"Design review brief\" (5 days)",
      body:
        "You sent this email 5 days ago and haven't received a reply.\n\n" +
        "**To:** Elena <elena@design.co>\n" +
        "**Subject:** Design review brief for Q2 campaign\n\n" +
        "Should Pulse draft a follow-up nudge?\n\n" +
        "**Approve** to mark as handled, or **Reject** to dismiss.",
      metadata:  JSON.stringify({
        gmailThreadId:   "gmail-thread-def456",
        gmailMessageId:  "gmail-msg-def456",
        subject:         "Design review brief for Q2 campaign",
        sentDate:        daysAgo(5),
        daysWithoutReply: 5,
      }),
      status:    "pending" as const,
      priority:  3,
      createdAt: daysAgo(1),
      decidedAt: null,
    },
    {
      id:        crypto.randomUUID(),
      type:      "follow_up" as const,
      title:     "No reply: \"Partnership opportunity\" (9 days)",
      body:
        "You sent this email 9 days ago and haven't received a reply.\n\n" +
        "**To:** David <david@partnerfirm.io>\n" +
        "**Subject:** Partnership opportunity — intro\n\n" +
        "This thread has been silent for over a week. Should Pulse draft a follow-up?\n\n" +
        "**Approve** to mark as handled, or **Reject** to dismiss.",
      metadata:  JSON.stringify({
        gmailThreadId:   "gmail-thread-ghi999",
        gmailMessageId:  "gmail-msg-ghi999",
        subject:         "Partnership opportunity — intro",
        sentDate:        daysAgo(9),
        daysWithoutReply: 9,
      }),
      status:    "pending" as const,
      priority:  2,
      createdAt: daysAgo(2),
      decidedAt: null,
    },

    // ── email_draft × 2 ────────────────────────────────────────────────────
    {
      id:        crypto.randomUUID(),
      type:      "email_draft" as const,
      title:     "Draft: reply to James re: onboarding timeline",
      body:
        "**From:** James <james@example.com>\n" +
        "**Subject:** Onboarding timeline for Alex\n\n" +
        "**Their message:**\n" +
        "Hi, could you confirm the onboarding schedule for the new contractor? " +
        "We need to book travel by Friday.\n\n" +
        "---\n\n" +
        "**Suggested reply scaffold:**\n\n" +
        "Hi James,\n\nThanks for reaching out. We have onboarding slots available " +
        "on April 14 (10am–12pm) and April 16 (2pm–4pm). " +
        "Let me know which works for your team and I'll send a calendar invite.\n\nBest,\n\n" +
        "---\n\n" +
        "**Approve** to mark handled. To send, ask Pulse: _\"Draft a reply to James\"_",
      metadata:  JSON.stringify({
        gmailMessageId: "gmail-thread-ghi789",
        from:           "James <james@example.com>",
        subject:        "Onboarding timeline for Alex",
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
      type:      "email_draft" as const,
      title:     "Draft: reply to Lisa re: contract renewal terms",
      body:
        "**From:** Lisa <lisa@legalpartners.com>\n" +
        "**Subject:** Contract renewal — terms for review\n\n" +
        "**Their message:**\n" +
        "Please find the updated contract renewal terms attached. " +
        "We'd like to schedule a call to walk through section 4.2 before signing.\n\n" +
        "---\n\n" +
        "**Suggested reply scaffold:**\n\n" +
        "Hi Lisa,\n\nThank you for sending the updated terms. I've reviewed section 4.2 " +
        "and have a few questions. I'm available for a call on Thursday 2–4pm or Friday " +
        "10am–12pm — please let me know what works.\n\nBest,\n\n" +
        "---\n\n" +
        "**Approve** to mark handled. To send, ask Pulse: _\"Draft a reply to Lisa\"_",
      metadata:  JSON.stringify({
        gmailMessageId: "gmail-thread-jkl321",
        from:           "Lisa <lisa@legalpartners.com>",
        subject:        "Contract renewal — terms for review",
        date:           daysAgo(1),
        category:       "action-required",
      }),
      status:    "pending" as const,
      priority:  4,
      createdAt: daysAgo(1),
      decidedAt: null,
    },
  ];

  // ── Historical items + decisions (spread across 7 days for analytics) ──────

  type HistoricalStatus = "approved" | "rejected";
  const historicalItems: Array<{
    item: typeof actionItems.$inferInsert;
    decision: HistoricalStatus;
    reason: string | null;
  }> = [
    // Day 6 ago
    {
      item: {
        id: crypto.randomUUID(), type: "email_draft",
        title: "Draft: reply to client NDA enquiry",
        body: "(approved and sent)", metadata: null,
        status: "approved", priority: 3,
        createdAt: daysAgo(6), decidedAt: daysAgo(6),
      },
      decision: "approved", reason: null,
    },
    {
      item: {
        id: crypto.randomUUID(), type: "follow_up",
        title: "No reply: \"Vendor pricing request\" (7 days)",
        body: "(rejected — vendor responded separately)", metadata: null,
        status: "rejected", priority: 5,
        createdAt: daysAgo(6), decidedAt: daysAgo(6),
      },
      decision: "rejected", reason: "Vendor responded via phone",
    },
    // Day 4 ago
    {
      item: {
        id: crypto.randomUUID(), type: "conflict_resolution",
        title: "Calendar conflict: All-hands ↔ Dentist appointment",
        body: "(approved — dentist rescheduled)", metadata: null,
        status: "approved", priority: 2,
        createdAt: daysAgo(4), decidedAt: daysAgo(4),
      },
      decision: "approved", reason: null,
    },
    {
      item: {
        id: crypto.randomUUID(), type: "slib_reminder",
        title: "Slib Guard: send slide deck to Tom by last Friday",
        body: "(approved — sent on time)", metadata: null,
        status: "approved", priority: 3,
        createdAt: daysAgo(4), decidedAt: daysAgo(4),
      },
      decision: "approved", reason: null,
    },
    // Day 2 ago
    {
      item: {
        id: crypto.randomUUID(), type: "email_draft",
        title: "Draft: reply to recruiter re: senior engineer role",
        body: "(rejected — not hiring)", metadata: null,
        status: "rejected", priority: 6,
        createdAt: daysAgo(2), decidedAt: daysAgo(2),
      },
      decision: "rejected", reason: "Not actively hiring for this role",
    },
    {
      item: {
        id: crypto.randomUUID(), type: "follow_up",
        title: "No reply: \"Q1 report\" (4 days)",
        body: "(approved — follow-up sent)", metadata: null,
        status: "approved", priority: 3,
        createdAt: daysAgo(2), decidedAt: daysAgo(2),
      },
      decision: "approved", reason: null,
    },
    // Yesterday
    {
      item: {
        id: crypto.randomUUID(), type: "conflict_resolution",
        title: "Calendar conflict: Design review ↔ Client lunch",
        body: "(rejected — both events kept, overlap was minor)", metadata: null,
        status: "rejected", priority: 4,
        createdAt: daysAgo(1), decidedAt: daysAgo(1),
      },
      decision: "rejected", reason: "Overlap is only 5 minutes, manageable",
    },
    {
      item: {
        id: crypto.randomUUID(), type: "slib_reminder",
        title: "Slib Guard: intro email to new board member",
        body: "(approved — email drafted and sent)", metadata: null,
        status: "approved", priority: 2,
        createdAt: daysAgo(1), decidedAt: daysAgo(1),
      },
      decision: "approved", reason: null,
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
