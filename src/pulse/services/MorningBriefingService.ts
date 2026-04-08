/**
 * src/pulse/services/MorningBriefingService.ts
 * Generates a concise morning briefing on agent startup and logs it to the
 * console so it surfaces in Nosana job logs and local dev output.
 *
 * The briefing summarises three data sources — all of which are already
 * collected by other Pulse services — without duplicating any logic:
 *
 *   1. Pending action items  — count + highest-priority items from PGLite
 *   2. Today's calendar      — events from CalendarMcpService (with fallback
 *                              to cached data when Google is unreachable)
 *   3. Active Slib Guard     — commitments whose deadline is within 48 hours
 *
 * Design choices:
 *   - Fires once at startup, after a short delay so dependent services
 *     (GmailMcpService, CalendarMcpService) have time to initialise.
 *   - Does NOT send any message to the agent chat — output goes to stdout
 *     only, keeping the briefing as infrastructure-level logging.
 *   - All errors are caught and logged; a failed briefing must never crash
 *     the agent.
 *   - Uses the DB handle from GmailMcpService's migration (runtime.db) to
 *     avoid opening a second PGLite connection.
 */

import { Service, type IAgentRuntime } from "@elizaos/core";
import { eq, lte, and, asc } from "drizzle-orm";
import { actionItems, commitments } from "../db/schema.js";
import type { Db } from "../db/schema.js";
import { CalendarMcpService } from "./CalendarMcpService.js";
import type { CalendarEvent } from "../lib/calendarClient.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Delay after service registration before the briefing fires. */
const STARTUP_DELAY_MS = 5_000;

/** Max action items to list by name in the briefing. */
const MAX_ITEMS_IN_BRIEFING = 3;

/** Max calendar events to show today. */
const MAX_EVENTS_IN_BRIEFING = 5;

// ─── Service ──────────────────────────────────────────────────────────────────

export class MorningBriefingService extends Service {
  static readonly serviceType = "pulse-morning-briefing";

  readonly capabilityDescription =
    "Generates a daily morning briefing on startup summarising pending action " +
    "items, today's calendar events, and active Slib Guard commitment reminders.";

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const svc = new MorningBriefingService(runtime);
    // Fire after a short delay so GmailMcpService and CalendarMcpService
    // have completed their own start() routines.
    setTimeout(() => {
      void svc.generateBriefing().catch((err: unknown) => {
        console.error(
          "[Pulse:MorningBriefing] Briefing generation failed:",
          err instanceof Error ? err.message : String(err)
        );
      });
    }, STARTUP_DELAY_MS);
    return svc;
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    // No persistent resources to clean up.
    const instance = runtime.getService<MorningBriefingService>(
      MorningBriefingService.serviceType
    );
    await instance?.stop();
  }

  async stop(): Promise<void> {
    console.log("[Pulse:MorningBriefing] Service stopped.");
  }

  // ── Briefing Generation ───────────────────────────────────────────────────

  async generateBriefing(): Promise<void> {
    const now = new Date();
    const todayLabel = now.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    const [pendingItems, todayEvents, urgentCommitments] = await Promise.all([
      this.fetchPendingItems(),
      this.fetchTodayEvents(),
      this.fetchUrgentCommitments(now),
    ]);

    this.printBriefing(todayLabel, pendingItems, todayEvents, urgentCommitments);
  }

  // ── Data Fetchers ────────────────────────────────────────────────────────

  private async fetchPendingItems(): Promise<PendingItemSummary[]> {
    try {
      const db = this.runtime.db as unknown as Db;
      const rows = await db
        .select({
          id:       actionItems.id,
          type:     actionItems.type,
          title:    actionItems.title,
          priority: actionItems.priority,
        })
        .from(actionItems)
        .where(eq(actionItems.status, "pending"))
        .orderBy(asc(actionItems.priority), asc(actionItems.createdAt))
        .limit(MAX_ITEMS_IN_BRIEFING + 1); // +1 so we know if there are more

      return rows.map((r) => ({
        type:     r.type,
        title:    r.title,
        priority: r.priority,
      }));
    } catch (err) {
      console.warn(
        "[Pulse:MorningBriefing] Could not fetch pending items:",
        err instanceof Error ? err.message : String(err)
      );
      return [];
    }
  }

  private async fetchTodayEvents(): Promise<CalendarEvent[]> {
    try {
      const calSvc = this.runtime.getService<CalendarMcpService>(
        CalendarMcpService.serviceType
      );
      if (!calSvc) return [];

      // getEvents returns the next N days; filter down to today only.
      const allEvents = await calSvc.getEvents(1);
      const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      return allEvents
        .filter((e) => e.start.startsWith(todayStr))
        .sort((a, b) => a.start.localeCompare(b.start))
        .slice(0, MAX_EVENTS_IN_BRIEFING);
    } catch (err) {
      console.warn(
        "[Pulse:MorningBriefing] Could not fetch calendar events:",
        err instanceof Error ? err.message : String(err)
      );
      return [];
    }
  }

  private async fetchUrgentCommitments(now: Date): Promise<CommitmentSummary[]> {
    try {
      const db = this.runtime.db as unknown as Db;
      // "Urgent" = remindAt is within the next 48 hours and reminder not yet sent.
      const cutoff = new Date(now.getTime() + 48 * 3_600_000).toISOString();

      const rows = await db
        .select({
          text:      commitments.text,
          recipient: commitments.recipient,
          deadline:  commitments.deadline,
        })
        .from(commitments)
        .where(
          and(
            lte(commitments.remindAt, cutoff),
            eq(commitments.reminderSent, false)
          )
        )
        .orderBy(asc(commitments.deadline));

      return rows.map((r) => ({
        text:      r.text,
        recipient: r.recipient ?? null,
        deadline:  r.deadline,
      }));
    } catch (err) {
      console.warn(
        "[Pulse:MorningBriefing] Could not fetch commitments:",
        err instanceof Error ? err.message : String(err)
      );
      return [];
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private printBriefing(
    dateLabel: string,
    pendingItems: PendingItemSummary[],
    todayEvents: CalendarEvent[],
    urgentCommitments: CommitmentSummary[]
  ): void {
    const lines: string[] = [
      "",
      "╔══════════════════════════════════════════════════╗",
      "║       ⚡  PULSE — Morning Briefing               ║",
      `╠══════════════════════════════════════════════════╣`,
      `║  ${dateLabel.padEnd(48)}║`,
      "╚══════════════════════════════════════════════════╝",
    ];

    // ── Section 1: Pending Queue ────────────────────────────────────────────
    lines.push("");
    if (pendingItems.length === 0) {
      lines.push("  ✓ Approval queue is empty — nothing needs your attention.");
    } else {
      const shown = pendingItems.slice(0, MAX_ITEMS_IN_BRIEFING);
      const overflow = pendingItems.length > MAX_ITEMS_IN_BRIEFING
        ? ` (+${pendingItems.length - MAX_ITEMS_IN_BRIEFING} more)`
        : "";
      lines.push(`  📋 Pending approvals: ${pendingItems.length}${overflow}`);
      for (const item of shown) {
        const tag = TYPE_TAG[item.type] ?? "📌";
        lines.push(`     ${tag}  [P${item.priority}] ${truncate(item.title, 55)}`);
      }
    }

    // ── Section 2: Today's Calendar ────────────────────────────────────────
    lines.push("");
    if (todayEvents.length === 0) {
      lines.push("  📅 Calendar: no events scheduled today.");
    } else {
      lines.push(`  📅 Today's calendar (${todayEvents.length} event${todayEvents.length !== 1 ? "s" : ""}):`);
      for (const ev of todayEvents) {
        const time = ev.allDay
          ? "all-day"
          : formatTime(ev.start);
        lines.push(`     ${time.padEnd(8)} ${truncate(ev.title, 50)}`);
      }
    }

    // ── Section 3: Slib Guard ───────────────────────────────────────────────
    lines.push("");
    if (urgentCommitments.length === 0) {
      lines.push("  🛡  Slib Guard: no commitments due in the next 48 hours.");
    } else {
      lines.push(`  🛡  Slib Guard — ${urgentCommitments.length} commitment${urgentCommitments.length !== 1 ? "s" : ""} due soon:`);
      for (const c of urgentCommitments) {
        const who = c.recipient ? ` → ${c.recipient}` : "";
        lines.push(`     ⏰ [${c.deadline}]${who} ${truncate(c.text, 52)}`);
      }
    }

    lines.push("");
    lines.push("  → Dashboard: http://localhost:3000/pulse/dashboard");
    lines.push("");

    // Write as a single console.log call so interleaved output doesn't split it.
    console.log(lines.join("\n"));
  }
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface PendingItemSummary {
  type:     string;
  title:    string;
  priority: number;
}

interface CommitmentSummary {
  text:      string;
  recipient: string | null;
  deadline:  string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TYPE_TAG: Record<string, string> = {
  email_draft:         "✉️ ",
  conflict_resolution: "⚠️ ",
  slib_reminder:       "🛡 ",
  follow_up:           "🔔",
};

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Format an ISO datetime as "HH:MM" in local time. */
function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso.slice(11, 16); // fallback: slice from ISO string
  }
}
