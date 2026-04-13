/**
 * scripts/seed-demo.ts
 * Inserts realistic demo data into the local PGLite database so the dashboard
 * renders without needing Gmail / Calendar credentials.
 *
 * Usage:
 *   npx tsx scripts/seed-demo.ts
 *
 * ⚠  The agent must NOT be running while this script executes — PGLite
 *    enforces a single-writer-per-directory constraint.
 *
 * What gets seeded:
 *   • 8 pending action items (2 of each type: email_draft, conflict_resolution,
 *     slib_reminder, follow_up) — varied priorities and ages
 *   • 8 historical decisions spread across the last 7 days so the Analytics
 *     chart and approval-rate breakdown both have data to display
 */

import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { schema, actionItems, decisions } from "../src/pulse/db/schema.js";
import { runMigrations } from "../src/pulse/db/migrations.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR = "./.eliza/.elizadb";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** ISO datetime `n` days before "now" (negative = future). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** ISO datetime `n` hours before "now". */
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

// ─── Seed Data ────────────────────────────────────────────────────────────────

const tomorrow = new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10);
const in10days = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

const PENDING_ITEMS = [
  // ── conflict_resolution × 2 ─────────────────────────────────────────────
  {
    id:        crypto.randomUUID(),
    type:      "conflict_resolution",
    title:     "Calendar conflict: Q2 Review ↔ Sarah 1:1 (Thu 2pm)",
    body:
      "Two events overlap on Thursday at 14:00–15:00:\n\n" +
      "• Q2 Business Review (14:00–15:30) — org-wide, you are a presenter\n" +
      "• Sarah 1:1 (14:00–15:00) — recurring weekly\n\n" +
      "Suggested resolution: reschedule the 1:1 to Thursday 15:30 or Friday 10:00.\n\n" +
      "**Approve** to acknowledge, or **Reject** to dismiss.",
    metadata:  JSON.stringify({
      eventAId: "cal-ev-001", eventATitle: "Q2 Business Review",
      eventBId: "cal-ev-002", eventBTitle: "Sarah 1:1",
      eventAStart: "2026-04-17T14:00:00", eventAEnd: "2026-04-17T15:30:00",
      eventBStart: "2026-04-17T14:00:00", eventBEnd: "2026-04-17T15:00:00",
      overlapMinutes: 60, date: "2026-04-17",
    }),
    status:    "pending",
    priority:  1,
    createdAt: hoursAgo(2),
    decidedAt: null,
  },
  {
    id:        crypto.randomUUID(),
    type:      "conflict_resolution",
    title:     "Calendar conflict: Team stand-up ↔ Investor call (Mon 9am)",
    body:
      "Two events overlap on Monday at 09:00–09:30:\n\n" +
      "• Daily Team Stand-up (09:00–09:15) — recurring daily\n" +
      "• Investor Call with VC Partners (09:00–10:00) — high priority\n\n" +
      "Suggested resolution: skip the stand-up on Monday — investor call cannot be moved.\n\n" +
      "**Approve** to acknowledge, or **Reject** to dismiss.",
    metadata:  JSON.stringify({
      eventAId: "cal-ev-003", eventATitle: "Daily Stand-up",
      eventBId: "cal-ev-004", eventBTitle: "Investor Call",
      eventAStart: "2026-04-14T09:00:00", eventAEnd: "2026-04-14T09:15:00",
      eventBStart: "2026-04-14T09:00:00", eventBEnd: "2026-04-14T10:00:00",
      overlapMinutes: 15, date: "2026-04-14",
    }),
    status:    "pending",
    priority:  2,
    createdAt: hoursAgo(1),
    decidedAt: null,
  },

  // ── slib_reminder × 2 ───────────────────────────────────────────────────
  {
    id:        crypto.randomUUID(),
    type:      "slib_reminder",
    title:     "Slib Guard: pricing proposal for Mark due tomorrow",
    body:
      "In your email to Mark (3 days ago) you wrote:\n\n" +
      "  \"I'll send over the updated pricing proposal by end of week.\"\n\n" +
      "Tomorrow is Friday and no follow-up has been sent.\n\n" +
      "**Approve** to confirm on track, or **Reject** to dismiss.",
    metadata:  JSON.stringify({
      commitmentId: "commitment-seed-001",
      recipient: "Mark",
      deadline: tomorrow,
      verbatim: "I'll send over the updated pricing proposal by end of week.",
    }),
    status:    "pending",
    priority:  2,
    createdAt: hoursAgo(3),
    decidedAt: null,
  },
  {
    id:        crypto.randomUUID(),
    type:      "slib_reminder",
    title:     "Slib Guard: Q2 budget forecast for Finance by Apr 18",
    body:
      "Detected in your email to Anna (Finance):\n\n" +
      "  \"I'll have the Q2 budget forecast ready by April 18.\"\n\n" +
      `Deadline is ${in10days}. Flagged early so it doesn't slip.\n\n` +
      "**Approve** to confirm on track, or **Reject** to dismiss.",
    metadata:  JSON.stringify({
      commitmentId: "commitment-seed-002",
      recipient: "Anna",
      deadline: in10days,
      verbatim: "I'll have the Q2 budget forecast ready by April 18.",
    }),
    status:    "pending",
    priority:  7,
    createdAt: daysAgo(3),
    decidedAt: null,
  },

  // ── follow_up × 2 ───────────────────────────────────────────────────────
  {
    id:        crypto.randomUUID(),
    type:      "follow_up",
    title:     "No reply: \"Design review brief\" (5 days)",
    body:
      "You sent this email 5 days ago and haven't received a reply.\n\n" +
      "**To:** Elena <elena@design.co>\n" +
      "**Subject:** Design review brief for Q2 campaign\n\n" +
      "Should Pulse draft a follow-up nudge?\n\n" +
      "**Approve** to mark handled, or **Reject** to dismiss.",
    metadata:  JSON.stringify({
      gmailThreadId: "gmail-thread-def456",
      gmailMessageId: "gmail-msg-def456",
      subject: "Design review brief for Q2 campaign",
      sentDate: daysAgo(5),
      daysWithoutReply: 5,
    }),
    status:    "pending",
    priority:  3,
    createdAt: daysAgo(1),
    decidedAt: null,
  },
  {
    id:        crypto.randomUUID(),
    type:      "follow_up",
    title:     "No reply: \"Partnership opportunity\" (9 days)",
    body:
      "You sent this email 9 days ago and haven't received a reply.\n\n" +
      "**To:** David <david@partnerfirm.io>\n" +
      "**Subject:** Partnership opportunity — intro\n\n" +
      "This thread has been silent for over a week. Should Pulse draft a follow-up?\n\n" +
      "**Approve** to mark handled, or **Reject** to dismiss.",
    metadata:  JSON.stringify({
      gmailThreadId: "gmail-thread-ghi999",
      gmailMessageId: "gmail-msg-ghi999",
      subject: "Partnership opportunity — intro",
      sentDate: daysAgo(9),
      daysWithoutReply: 9,
    }),
    status:    "pending",
    priority:  2,
    createdAt: daysAgo(2),
    decidedAt: null,
  },

  // ── email_draft × 2 ─────────────────────────────────────────────────────
  {
    id:        crypto.randomUUID(),
    type:      "email_draft",
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
      from: "James <james@example.com>",
      subject: "Onboarding timeline for Alex",
      date: daysAgo(2),
      category: "action-required",
    }),
    status:    "pending",
    priority:  5,
    createdAt: daysAgo(2),
    decidedAt: null,
  },
  {
    id:        crypto.randomUUID(),
    type:      "email_draft",
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
      from: "Lisa <lisa@legalpartners.com>",
      subject: "Contract renewal — terms for review",
      date: daysAgo(1),
      category: "action-required",
    }),
    status:    "pending",
    priority:  4,
    createdAt: daysAgo(1),
    decidedAt: null,
  },
] as const;

// 8 historical decisions spread across the last 7 days
const HISTORICAL_ITEMS = [
  // Day 6
  { id: crypto.randomUUID(), type: "email_draft",
    title: "Draft: reply to client NDA enquiry", body: "(approved and sent)",
    metadata: null, status: "approved", priority: 3, createdAt: daysAgo(6), decidedAt: daysAgo(6),
    decision: "approved" as const, reason: null },
  { id: crypto.randomUUID(), type: "follow_up",
    title: "No reply: \"Vendor pricing request\" (7 days)", body: "(rejected — vendor responded via phone)",
    metadata: null, status: "rejected", priority: 5, createdAt: daysAgo(6), decidedAt: daysAgo(6),
    decision: "rejected" as const, reason: "Vendor responded via phone" },
  // Day 4
  { id: crypto.randomUUID(), type: "conflict_resolution",
    title: "Calendar conflict: All-hands ↔ Dentist appointment", body: "(approved — dentist rescheduled)",
    metadata: null, status: "approved", priority: 2, createdAt: daysAgo(4), decidedAt: daysAgo(4),
    decision: "approved" as const, reason: null },
  { id: crypto.randomUUID(), type: "slib_reminder",
    title: "Slib Guard: slide deck to Tom by last Friday", body: "(approved — sent on time)",
    metadata: null, status: "approved", priority: 3, createdAt: daysAgo(4), decidedAt: daysAgo(4),
    decision: "approved" as const, reason: null },
  // Day 2
  { id: crypto.randomUUID(), type: "email_draft",
    title: "Draft: reply to recruiter re: senior engineer role", body: "(rejected — not hiring)",
    metadata: null, status: "rejected", priority: 6, createdAt: daysAgo(2), decidedAt: daysAgo(2),
    decision: "rejected" as const, reason: "Not actively hiring for this role" },
  { id: crypto.randomUUID(), type: "follow_up",
    title: "No reply: \"Q1 report\" (4 days)", body: "(approved — follow-up sent)",
    metadata: null, status: "approved", priority: 3, createdAt: daysAgo(2), decidedAt: daysAgo(2),
    decision: "approved" as const, reason: null },
  // Yesterday
  { id: crypto.randomUUID(), type: "conflict_resolution",
    title: "Calendar conflict: Design review ↔ Client lunch", body: "(rejected — overlap minor)",
    metadata: null, status: "rejected", priority: 4, createdAt: daysAgo(1), decidedAt: daysAgo(1),
    decision: "rejected" as const, reason: "Overlap is only 5 minutes, manageable" },
  { id: crypto.randomUUID(), type: "slib_reminder",
    title: "Slib Guard: intro email to new board member", body: "(approved — email sent)",
    metadata: null, status: "approved", priority: 2, createdAt: daysAgo(1), decidedAt: daysAgo(1),
    decision: "approved" as const, reason: null },
] as const;

// ─── Runner ───────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  void (async () => {
    console.log("╔══════════════════════════════════════╗");
    console.log("║   Pulse — Demo Seed Script           ║");
    console.log("╚══════════════════════════════════════╝\n");
    console.log(`Database: ${DATA_DIR}\n`);
    console.log("⚠  Ensure the agent is NOT running (PGLite: one writer per directory)\n");

    type Closeable = { close(): Promise<void> };
    const db = drizzle(DATA_DIR, { schema }) as ReturnType<typeof drizzle> & {
      $client: Closeable;
    };

    try {
      // Ensure schema exists — idempotent.
      await runMigrations(db as Parameters<typeof runMigrations>[0]);

      // ── Clear existing demo data ──────────────────────────────────────────
      // We only touch rows we're about to insert — a full wipe is intentional
      // for reproducibility, since this is a demo script.
      await db.execute(sql`DELETE FROM pulse_decisions`);
      await db.execute(sql`DELETE FROM pulse_action_items`);
      console.log("✓ Cleared existing action items and decisions\n");

      // ── Insert pending items ──────────────────────────────────────────────
      for (const item of PENDING_ITEMS) {
        await db.insert(actionItems).values(item);
        console.log(`  ✓ Pending [${item.type.padEnd(20)}] "${item.title.slice(0, 55)}…"`);
      }

      // ── Insert historical items + decisions ───────────────────────────────
      for (const item of HISTORICAL_ITEMS) {
        const { decision, reason, ...itemRow } = item;
        await db.insert(actionItems).values(itemRow);
        await db.insert(decisions).values({
          id:           crypto.randomUUID(),
          actionItemId: item.id,
          decision,
          reason,
          decidedAt:    item.decidedAt,
        });

        console.log(
          `  ✓ History  [${item.type.padEnd(20)}] "${item.title.slice(0, 47)}…" → ${decision}`
        );
      }

      // ── Verification ──────────────────────────────────────────────────────
      const pendingCount = await db.execute(
        sql`SELECT COUNT(*) AS n FROM pulse_action_items WHERE status = 'pending'`
      );
      const decisionCount = await db.execute(
        sql`SELECT COUNT(*) AS n FROM pulse_decisions`
      );

      console.log("\n──────────────────────────────────────");
      console.log(`  pending action items : ${(pendingCount.rows[0] as { n: string }).n}`);
      console.log(`  decisions recorded   : ${(decisionCount.rows[0] as { n: string }).n}`);
      console.log("──────────────────────────────────────");
      console.log("\n✓ Seed complete. Start the agent and visit http://localhost:3000/pulse/dashboard\n");
    } finally {
      await db.$client.close();
    }
  })().catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
