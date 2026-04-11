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
 *   • 5 action items in the pending queue (all four types represented, varied
 *     priorities and ages)
 *   • 3 historical decisions (2 approved, 1 rejected) with linked items so the
 *     DecisionHistory panel shows realistic pattern data
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

const PENDING_ITEMS = [
  // Highest priority: calendar conflict detected this morning
  {
    id:        crypto.randomUUID(),
    type:      "conflict_resolution",
    title:     "Calendar conflict: Q2 Review ↔ Sarah 1:1 (Thu 2pm)",
    body:
      "Two events overlap on Thursday at 14:00–15:00:\n\n" +
      "• Q2 Business Review (14:00–15:30) — org-wide, you are a presenter\n" +
      "• Sarah 1:1 (14:00–15:00) — recurring weekly\n\n" +
      "Suggested resolution: reschedule the 1:1 to Thursday 15:30 or Friday 10:00. " +
      "Sarah has both slots free.",
    metadata:  JSON.stringify({
      eventAId:    "cal-ev-001",
      eventBId:    "cal-ev-002",
      eventATitle: "Q2 Business Review",
      eventBTitle: "Sarah 1:1",
      eventAStart: "2026-04-17T14:00:00",
      eventAEnd:   "2026-04-17T15:30:00",
      eventBStart: "2026-04-17T14:00:00",
      eventBEnd:   "2026-04-17T15:00:00",
      overlapMinutes: 60,
      date:        "2026-04-17",
    }),
    status:    "pending",
    priority:  1,
    createdAt: hoursAgo(2),
    decidedAt: null,
  },

  // Slib Guard reminder: commitment about to be missed
  {
    id:        crypto.randomUUID(),
    type:      "slib_reminder",
    title:     "Slib Guard: proposal for Mark due tomorrow",
    body:
      "In your email to Mark (3 days ago) you wrote:\n\n" +
      "  \"I'll send over the updated pricing proposal by end of week.\"\n\n" +
      "Tomorrow is Friday and no follow-up has been sent. " +
      "Pulse drafted a follow-up below — approve to send.\n\n" +
      "---\n" +
      "Hi Mark,\n\nHere's the updated pricing proposal we discussed. " +
      "Let me know if you have any questions.\n\n[attachment: proposal-v2.pdf]",
    metadata:  JSON.stringify({
      sourceMessageId: "gmail-msg-abc123",
      recipient:       "Mark",
      deadline:        "2026-04-11",
      remindAt:        hoursAgo(1),
    }),
    status:    "pending",
    priority:  2,
    createdAt: hoursAgo(1),
    decidedAt: null,
  },

  // Email draft: follow-up after no reply
  {
    id:        crypto.randomUUID(),
    type:      "follow_up",
    title:     "Follow-up: Elena hasn't replied in 5 days",
    body:
      "You emailed Elena on April 3rd about the design review brief. " +
      "No reply has been received (5 days).\n\n" +
      "Pulse drafted a gentle follow-up:\n\n" +
      "---\n" +
      "Hi Elena,\n\nJust checking in — did you get a chance to look at the " +
      "design review brief I sent last week? Happy to jump on a quick call " +
      "if that's easier.\n\nBest,",
    metadata:  JSON.stringify({
      threadId:      "gmail-thread-def456",
      originalDate:  "2026-04-03T09:15:00",
      recipientName: "Elena",
    }),
    status:    "pending",
    priority:  4,
    createdAt: daysAgo(1),
    decidedAt: null,
  },

  // Email draft: outbound from Pulse
  {
    id:        crypto.randomUUID(),
    type:      "email_draft",
    title:     "Draft: reply to James re: onboarding timeline",
    body:
      "James emailed asking for an updated onboarding timeline for the new " +
      "contractor. Pulse drafted a reply based on your calendar availability:\n\n" +
      "---\n" +
      "Hi James,\n\nThanks for reaching out. We have onboarding slots available " +
      "on April 14 (10am–12pm) and April 16 (2pm–4pm). " +
      "Let me know which works for your team and I'll send a calendar invite.\n\nBest,",
    metadata:  JSON.stringify({
      threadId:    "gmail-thread-ghi789",
      replyTo:     "james@example.com",
      subject:     "Re: Onboarding timeline for Alex",
    }),
    status:    "pending",
    priority:  5,
    createdAt: daysAgo(2),
    decidedAt: null,
  },

  // Low-priority: Slib Guard reminder far in the future but surfaced early
  {
    id:        crypto.randomUUID(),
    type:      "slib_reminder",
    title:     "Slib Guard: send budget forecast to Finance by Apr 18",
    body:
      "Detected in your email to Anna (Finance):\n\n" +
      "  \"I'll have the Q2 budget forecast ready by April 18.\"\n\n" +
      "Deadline is in 10 days. No action required yet, but this reminder " +
      "is here so it doesn't slip through the cracks.",
    metadata:  JSON.stringify({
      sourceMessageId: "gmail-msg-jkl012",
      recipient:       "Anna",
      deadline:        "2026-04-18",
    }),
    status:    "pending",
    priority:  7,
    createdAt: daysAgo(3),
    decidedAt: null,
  },
] as const;

// Items for the 3 historical decisions (already resolved)
const HISTORICAL_ITEMS = [
  {
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
  {
    id:        crypto.randomUUID(),
    type:      "conflict_resolution",
    title:     "Calendar conflict: All-hands ↔ Dentist appointment",
    body:      "(approved and sent)",
    metadata:  null,
    status:    "approved",
    priority:  2,
    createdAt: daysAgo(7),
    decidedAt: daysAgo(7),
  },
  {
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
        await db.insert(actionItems).values(item);

        const decisionValue = item.status as "approved" | "rejected";
        await db.insert(decisions).values({
          id:           crypto.randomUUID(),
          actionItemId: item.id,
          decision:     decisionValue,
          reason:       decisionValue === "rejected" ? "Not needed at this time" : null,
          decidedAt:    item.decidedAt,
        });

        console.log(
          `  ✓ History  [${item.type.padEnd(20)}] "${item.title.slice(0, 47)}…" → ${decisionValue}`
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
