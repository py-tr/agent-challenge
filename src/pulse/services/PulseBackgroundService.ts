/**
 * src/pulse/services/PulseBackgroundService.ts
 * Core ElizaOS Service — background processing at 6-hour intervals.
 *
 * Architecture (ElizaOS-native patterns):
 *   1. Registers a named TaskWorker via runtime.registerTaskWorker() so the
 *      processing cycle is tracked in the ElizaOS task system.
 *   2. Creates a persistent Task record via runtime.createTask() that carries
 *      metadata about the schedule and last result.
 *   3. Drives actual execution with setInterval (ElizaOS's task system stores
 *      task records but does not auto-dispatch workers on updateInterval).
 *
 * Processing cycle — three independent stages (each catches its own errors):
 *   A. Email:     GmailMcpService.fetchAndClassify() → insert action items
 *   B. Calendar:  CalendarMcpService.getEvents() + detectConflicts() → insert conflicts
 *   C. Reminders: getPendingReminders() → insert slib_reminder items for due commitments
 *
 * Deduplication:
 *   A. Email dedup is handled by GmailMcpService via the Gmail History API cursor
 *      (pulse:gmail:last_history_id). Only messages added since the last sync are returned.
 *   B. Calendar dedup: before inserting a conflict, check existing pending
 *      conflict_resolution items for matching eventA/eventB IDs.
 *   C. Reminder dedup: getPendingReminders() only returns rows where
 *      reminderSent=false, so each commitment fires at most once.
 *
 * Observability:
 *   Every cycle emits a single structured log line:
 *   [Pulse] Cycle complete — emails=3 conflicts=1 reminders=2 duration=842ms
 */

import { Service, type IAgentRuntime, type UUID } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { GmailMcpService } from "./GmailMcpService.js";
import { CalendarMcpService } from "./CalendarMcpService.js";
import { detectConflicts } from "../lib/conflictDetector.js";
import {
  insertActionItem,
  getPendingReminders,
  markReminderSent,
  countByStatus,
} from "../db/queries.js";
import { actionItems, type Db } from "../db/schema.js";
import { seedDemoData } from "../lib/seedDemoData.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TASK_NAME         = "pulse.processing-cycle";
const CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 hours

// ─── Result types ─────────────────────────────────────────────────────────────

interface StageResult {
  processed: number;
  inserted:  number;
  skipped?:  number;
  error?:    string;
}

interface CycleResult {
  emails:    StageResult;
  conflicts: StageResult;
  reminders: StageResult;
  durationMs: number;
}

// ─── Dedup helper ─────────────────────────────────────────────────────────────

/**
 * Build a set of canonical conflict keys for items already in the pending queue.
 * Format: "<sortedEventAId>|<sortedEventBId>" so A↔B and B↔A are the same key.
 */
async function existingConflictKeys(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ metadata: actionItems.metadata })
    .from(actionItems)
    .where(
      and(
        eq(actionItems.type, "conflict_resolution"),
        eq(actionItems.status, "pending")
      )
    );

  const keys = new Set<string>();
  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      const meta = JSON.parse(row.metadata) as {
        eventAId?: string;
        eventBId?: string;
      };
      if (meta.eventAId && meta.eventBId) {
        keys.add([meta.eventAId, meta.eventBId].sort().join("|"));
      }
    } catch {
      // Ignore malformed metadata — don't block the cycle
    }
  }
  return keys;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class PulseBackgroundService extends Service {
  static readonly serviceType = "pulse";

  readonly capabilityDescription =
    "Processes Gmail and Google Calendar events on a 6-hour schedule. " +
    "Classifies emails, detects calendar conflicts, surfaces due Slib Guard " +
    "commitment reminders, and populates the action approval queue in PGLite. " +
    "Registered as an ElizaOS TaskWorker — task record persisted in the runtime DB.";

  private cycleInterval: ReturnType<typeof setInterval> | null = null;
  private taskId: UUID | null = null;
  private cycleCount = 0;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new PulseBackgroundService(runtime);
    await service.onStart();
    return service;
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    const instance = runtime.getService<PulseBackgroundService>(
      PulseBackgroundService.serviceType
    );
    await instance?.stop();
  }

  async stop(): Promise<void> {
    if (this.cycleInterval !== null) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
    // Remove the task record so a fresh start creates a clean one.
    if (this.taskId !== null) {
      await this.runtime.deleteTask(this.taskId).catch((e: unknown) => {
        console.warn(
          "[Pulse] Could not delete task record on stop:",
          e instanceof Error ? e.message : String(e)
        );
      });
      this.taskId = null;
    }
    console.log("[Pulse] Background service stopped.");
  }

  // ── Startup ───────────────────────────────────────────────────────────────

  private async onStart(): Promise<void> {
    // 1. Register the TaskWorker so the runtime's task system knows this
    //    worker by name — any external code can call it via getTaskWorker().
    this.runtime.registerTaskWorker({
      name: TASK_NAME,
      execute: async (_rt: IAgentRuntime) => {
        await this.runProcessingCycle();
      },
    });

    // 2. Create (or reuse) a persistent task record in the runtime DB.
    //    ElizaOS 1.7.2+ requires a worldId on createTask — we use agentId as
    //    the world identifier (safe fallback when no explicit world is set).
    //    Task registration is non-fatal: the setInterval below drives the actual
    //    processing cycle regardless of whether the task record is persisted.
    try {
      const existing = await this.runtime.getTasksByName(TASK_NAME).catch(() => []);
      if (existing.length > 0) {
        this.taskId = existing[0].id as UUID;
        await this.runtime.updateTask(this.taskId, {
          metadata: {
            updateInterval: CYCLE_INTERVAL_MS,
            jobType: process.env.PULSE_JOB_TYPE ?? "scheduled",
            restartedAt: new Date().toISOString(),
          },
        }).catch(() => null);
      } else {
        this.taskId = await this.runtime.createTask({
          name: TASK_NAME,
          description: "Pulse 6-hour processing: Gmail → classify → queue, Calendar → conflicts, Commitments → reminders",
          tags: ["pulse", "scheduled", "recurring"],
          worldId: this.runtime.agentId as UUID,
          metadata: {
            updateInterval: CYCLE_INTERVAL_MS,
            jobType: process.env.PULSE_JOB_TYPE ?? "scheduled",
            createdAt: new Date().toISOString(),
          },
        });
      }
    } catch (e) {
      console.warn(
        "[Pulse] Task record registration skipped (non-fatal):",
        e instanceof Error ? e.message : String(e)
      );
      this.taskId = crypto.randomUUID() as UUID;
    }

    console.log(
      `[Pulse] Background service started. ` +
      `Task ID: ${this.taskId} · Cycle every ${CYCLE_INTERVAL_MS / 3_600_000}h`
    );

    // 3. Auto-seed demo data when requested and the queue is empty.
    //    Runs before the first processing cycle so the dashboard is populated
    //    immediately on Nosana deployments without manual intervention.
    if (process.env.PULSE_SEED_ON_START === "true") {
      await this.maybeSeedDemo();
    }

    // 4. Run one cycle immediately so the queue is populated on first launch,
    //    then repeat on the schedule.
    void this.runProcessingCycle();

    this.cycleInterval = setInterval(() => {
      void this.runProcessingCycle();
    }, CYCLE_INTERVAL_MS);
  }

  // ── Demo seed ─────────────────────────────────────────────────────────────

  /**
   * Seeds demo data only when the pending queue is empty, so real data is
   * never overwritten. Called once at startup when PULSE_SEED_ON_START=true.
   */
  private async maybeSeedDemo(): Promise<void> {
    try {
      const db      = this.runtime.db as unknown as Db;
      const pending = await countByStatus(db, "pending");

      if (pending > 0) {
        console.log(
          `[Pulse] Demo seed skipped — queue already has ${pending} pending item(s).`
        );
        return;
      }

      const result = await seedDemoData(db);
      console.log(
        `[Pulse] Demo seed complete — ` +
        `${result.pending} pending items, ${result.historical} historical decisions inserted.`
      );
    } catch (err) {
      // Non-fatal: a seed failure should never prevent the agent from starting.
      console.error(
        "[Pulse] Demo seed failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Exposed so ProcessEmailsAction and DetectConflictsAction can trigger
   * a fresh cycle on demand (e.g. user asks "process my emails now").
   */
  async runProcessingCycle(): Promise<CycleResult> {
    this.cycleCount++;
    const cycleNum  = this.cycleCount;
    const startedAt = Date.now();
    const jobType   = process.env.PULSE_JOB_TYPE ?? "scheduled";

    console.log(
      `[Pulse] Cycle #${cycleNum} started — job_type=${jobType} at=${new Date(startedAt).toISOString()}`
    );

    // Run all three stages in parallel where possible, but each independently
    // so one failure never blocks the others.
    const [emailsResult, conflictsResult, remindersResult] = await Promise.all([
      this.stageEmails(),
      this.stageCalendar(),
      this.stageReminders(),
    ]);

    const durationMs = Date.now() - startedAt;
    const result: CycleResult = {
      emails:    emailsResult,
      conflicts: conflictsResult,
      reminders: remindersResult,
      durationMs,
    };

    // Update the task record with the last cycle outcome.
    if (this.taskId) {
      await this.runtime.updateTask(this.taskId, {
        metadata: {
          updateInterval: CYCLE_INTERVAL_MS,
          jobType,
          lastCycleAt:     new Date().toISOString(),
          lastCycleResult: result,
          totalCycles:     cycleNum,
        },
      }).catch(() => null);
    }

    console.log(
      `[Pulse] Cycle #${cycleNum} complete — ` +
      `emails=${emailsResult.inserted}/${emailsResult.processed} ` +
      `conflicts=${conflictsResult.inserted}/${conflictsResult.processed} ` +
      `reminders=${remindersResult.inserted}/${remindersResult.processed} ` +
      `duration=${durationMs}ms` +
      (emailsResult.error    ? ` | email-err: ${emailsResult.error.slice(0, 60)}`    : "") +
      (conflictsResult.error ? ` | cal-err: ${conflictsResult.error.slice(0, 60)}`   : "") +
      (remindersResult.error ? ` | remind-err: ${remindersResult.error.slice(0, 60)}` : "")
    );

    return result;
  }

  // ── Stage A: Email processing ─────────────────────────────────────────────

  private async stageEmails(): Promise<StageResult> {
    try {
      const gmailSvc = this.runtime.getService<GmailMcpService>(
        GmailMcpService.serviceType
      );
      if (!gmailSvc) {
        return { processed: 0, inserted: 0, error: "GmailMcpService not available" };
      }

      const classified = await gmailSvc.fetchAndClassify();
      if (classified.length === 0) {
        return { processed: 0, inserted: 0 };
      }

      const db      = this.runtime.db as unknown as Db;
      let inserted  = 0;
      let skipped   = 0;

      for (const { message: msg, classification } of classified) {
        // Noise-classified and commitment-only emails don't get action items.
        if (!classification.actionItemType) {
          skipped++;
          continue;
        }

        try {
          await insertActionItem(db, {
            type:     classification.actionItemType,
            title:    msg.subject,
            body:     classification.body,
            metadata: {
              gmailMessageId: msg.id,
              from:           msg.from,
              date:           msg.date,
              category:       classification.category,
            },
            priority: classification.priority,
          });
          inserted++;
        } catch (err) {
          console.error(
            `[Pulse:Email] Failed to insert item for "${msg.subject}":`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      return { processed: classified.length, inserted, skipped };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:Email] Stage failed: ${msg}`);
      return { processed: 0, inserted: 0, error: msg };
    }
  }

  // ── Stage B: Calendar conflict detection ──────────────────────────────────

  private async stageCalendar(): Promise<StageResult> {
    try {
      const calSvc = this.runtime.getService<CalendarMcpService>(
        CalendarMcpService.serviceType
      );
      if (!calSvc) {
        return { processed: 0, inserted: 0, error: "CalendarMcpService not available" };
      }

      const events = await calSvc.getEvents(14);
      if (events.length === 0) {
        return { processed: 0, inserted: 0 };
      }

      const conflicts = await detectConflicts(this.runtime, events);
      if (conflicts.length === 0) {
        return { processed: events.length, inserted: 0 };
      }

      const db           = this.runtime.db as unknown as Db;
      const knownKeys    = await existingConflictKeys(db);
      let inserted       = 0;
      let skipped        = 0;

      for (const conflict of conflicts) {
        const { eventA, eventB, overlapMinutes, suggestion } = conflict;

        // Dedup: skip if already queued for this event pair.
        const key = [eventA.id, eventB.id].sort().join("|");
        if (knownKeys.has(key)) {
          skipped++;
          continue;
        }

        const dateStr  = eventA.start.slice(0, 10);
        const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString(
          "en-US",
          { weekday: "short", month: "short", day: "numeric" }
        );

        const title =
          `Conflict: "${eventA.title}" ↔ "${eventB.title}" — ${dateLabel}`;

        const body =
          `**${eventA.title}** (${eventA.start.slice(11, 16)}–${eventA.end.slice(11, 16)}) ` +
          `overlaps with **${eventB.title}** (${eventB.start.slice(11, 16)}–${eventB.end.slice(11, 16)}) ` +
          `by ${overlapMinutes} minute${overlapMinutes === 1 ? "" : "s"}.\n\n` +
          `**Suggested resolution:** ${suggestion}\n\n` +
          `Approve to acknowledge this conflict is handled, or Reject to dismiss it.`;

        try {
          await insertActionItem(db, {
            type:     "conflict_resolution",
            title,
            body,
            metadata: {
              eventAId:    eventA.id,
              eventBId:    eventB.id,
              eventATitle: eventA.title,
              eventBTitle: eventB.title,
              eventAStart: eventA.start,
              eventAEnd:   eventA.end,
              eventBStart: eventB.start,
              eventBEnd:   eventB.end,
              overlapMinutes,
              date:        dateStr,
            },
            priority: 1, // Highest — conflicts surface above all other items
          });
          // Add to local dedup set so subsequent conflicts in this cycle don't
          // double-insert the same pair.
          knownKeys.add(key);
          inserted++;
        } catch (err) {
          console.error(
            `[Pulse:Calendar] Failed to insert conflict (${eventA.title} ↔ ${eventB.title}):`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      return { processed: conflicts.length, inserted, skipped };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:Calendar] Stage failed: ${msg}`);
      return { processed: 0, inserted: 0, error: msg };
    }
  }

  // ── Stage C: Slib Guard pending reminders ─────────────────────────────────

  private async stageReminders(): Promise<StageResult> {
    try {
      const db  = this.runtime.db as unknown as Db;
      const due = await getPendingReminders(db);

      if (due.length === 0) {
        return { processed: 0, inserted: 0 };
      }

      let inserted = 0;

      for (const commitment of due) {
        try {
          const title = commitment.recipient
            ? `Commitment to ${commitment.recipient}: due ${commitment.deadline}`
            : `Commitment due ${commitment.deadline}`;

          const deadlineDate = new Date(commitment.deadline + "T12:00:00");
          const formatted    = deadlineDate.toLocaleDateString("en-US", {
            weekday: "long",
            month:   "long",
            day:     "numeric",
            year:    "numeric",
          });
          const recipientLine = commitment.recipient
            ? `You told **${commitment.recipient}** you would:`
            : "You committed to:";

          const body =
            `${recipientLine}\n\n` +
            `> "${commitment.text}"\n\n` +
            `**Deadline:** ${formatted}\n\n` +
            `Approve to confirm this commitment is on track, or Reject to dismiss it.`;

          const actionItem = await insertActionItem(db, {
            type:     "slib_reminder",
            title,
            body,
            metadata: {
              commitmentId: commitment.id,
              deadline:     commitment.deadline,
              recipient:    commitment.recipient,
              verbatim:     commitment.text,
            },
            priority: 2, // High — above email drafts (3), below calendar conflicts (1)
          });

          // Mark reminder as sent so it doesn't fire again.
          await markReminderSent(db, commitment.id, actionItem.id);
          inserted++;
        } catch (err) {
          console.error(
            `[Pulse:Reminders] Failed to queue reminder for commitment ${commitment.id}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      return { processed: due.length, inserted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:Reminders] Stage failed: ${msg}`);
      return { processed: 0, inserted: 0, error: msg };
    }
  }
}
