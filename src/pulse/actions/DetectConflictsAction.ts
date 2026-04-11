/**
 * src/pulse/actions/DetectConflictsAction.ts
 * ElizaOS Action — manually trigger a calendar conflict scan.
 *
 * Trigger phrases (checked in validate()):
 *   "check my calendar", "scan my calendar", "detect conflicts",
 *   "check for conflicts", "calendar conflicts", "any conflicts"
 *
 * Flow:
 *   1. Acknowledge via callback ("Scanning your calendar…")
 *   2. Get CalendarMcpService from runtime
 *   3. getEvents(14) → CalendarEvent[]
 *   4. detectConflicts(runtime, events) → ConflictResult[]
 *   5. insertActionItem() per conflict
 *   6. Callback with summary
 */

import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import { CalendarMcpService } from "../services/CalendarMcpService.js";
import { detectConflicts } from "../lib/conflictDetector.js";
import { insertActionItem } from "../db/queries.js";
import type { Db } from "../db/schema.js";

// ─── Trigger Detection ────────────────────────────────────────────────────────

function isConflictDetectRequest(text: string): boolean {
  const t = text.toLowerCase();
  const mentionsCalendar =
    t.includes("calendar") || t.includes("schedule") || t.includes("conflict");
  const hasAction =
    t.includes("check") ||
    t.includes("scan") ||
    t.includes("detect") ||
    t.includes("find") ||
    t.includes("show") ||
    t.includes("any");
  return mentionsCalendar && hasAction;
}

// ─── Action Definition ────────────────────────────────────────────────────────

export const detectConflictsAction: Action = {
  name: "DETECT_CONFLICTS",
  description:
    "Scan the next 14 days of Google Calendar for overlapping events. " +
    "For each conflict, generate a resolution suggestion and add a " +
    "conflict_resolution item to the approval queue. " +
    "Triggered when the user asks to check or scan their calendar for conflicts.",

  similes: [
    "CHECK_CALENDAR",
    "SCAN_CALENDAR",
    "CALENDAR_CONFLICTS",
    "FIND_CONFLICTS",
    "CHECK_CONFLICTS",
  ],

  examples: [
    [
      { name: "user", content: { text: "Check my calendar for conflicts" } },
      {
        name: "Pulse",
        content: { text: "Scanning your calendar for the next 14 days…" },
      },
    ],
    [
      { name: "user", content: { text: "Detect calendar conflicts" } },
      {
        name: "Pulse",
        content: { text: "On it — checking your schedule now." },
      },
    ],
  ],

  // ── Validate ────────────────────────────────────────────────────────────────

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory
  ): Promise<boolean> => {
    const text = (message.content?.text as string | undefined) ?? "";
    return isConflictDetectRequest(text);
  },

  // ── Handler ─────────────────────────────────────────────────────────────────

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: (response: { text: string }) => Promise<unknown>
  ) => {
    // Step 1: Acknowledge
    if (callback) {
      await callback({ text: "Scanning your calendar for the next 14 days…" });
    }

    try {
      // Step 2: Get CalendarMcpService
      const calService = runtime.getService(
        CalendarMcpService.serviceType
      ) as CalendarMcpService | null;

      if (!calService) {
        const errMsg =
          "Calendar service is not initialised. " +
          "Ensure CalendarMcpService is registered in pulsePlugin.services.";
        console.error(`[Pulse:DetectConflictsAction] ${errMsg}`);
        if (callback) await callback({ text: `⚠ ${errMsg}` });
        return { success: false, error: errMsg };
      }

      // Step 3: Fetch events
      const events = await calService.getEvents(14);

      if (events.length === 0) {
        const msg = "No calendar events found in the next 14 days.";
        if (callback) await callback({ text: `✓ ${msg}` });
        return { success: true, data: { events: 0, conflicts: 0 }, text: msg };
      }

      // Step 4: Detect conflicts
      const conflicts = await detectConflicts(runtime, events);

      if (conflicts.length === 0) {
        const msg = `Scanned ${events.length} events — no conflicts found.`;
        if (callback) await callback({ text: `✓ ${msg}` });
        return {
          success: true,
          data: { events: events.length, conflicts: 0 },
          text: msg,
        };
      }

      // Step 5: Write to pulse_action_items
      const db = runtime.db as unknown as Db;
      let inserted = 0;
      const errors: string[] = [];

      for (const conflict of conflicts) {
        const { eventA, eventB, overlapMinutes, suggestion } = conflict;

        const dateStr = eventA.start.slice(0, 10);
        const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString(
          "en-US",
          { weekday: "short", month: "short", day: "numeric" }
        );

        const title = `Conflict: "${eventA.title}" ↔ "${eventB.title}" — ${dateLabel}`;

        const body =
          `**${eventA.title}** (${eventA.start.slice(11, 16)}–${eventA.end.slice(11, 16)}) ` +
          `overlaps with **${eventB.title}** (${eventB.start.slice(11, 16)}–${eventB.end.slice(11, 16)}) ` +
          `by ${overlapMinutes} minute${overlapMinutes === 1 ? "" : "s"}.\n\n` +
          `**Suggested resolution:** ${suggestion}\n\n` +
          `Approve to acknowledge this conflict is handled, or Reject to dismiss it.`;

        try {
          await insertActionItem(db, {
            type: "conflict_resolution",
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
              date: dateStr,
            },
            priority: 1, // Highest — surfaces above all other items
          });
          inserted++;
        } catch (err) {
          const errStr = err instanceof Error ? err.message : String(err);
          console.error(
            `[Pulse:DetectConflictsAction] Failed to insert conflict item: ${errStr}`
          );
          errors.push(errStr);
        }
      }

      // Step 6: Summary
      const conflictWord = inserted === 1 ? "conflict" : "conflicts";
      const replyText =
        `✓ Scanned ${events.length} events. Found ${inserted} ${conflictWord} — added to your approval queue.`;

      if (callback) await callback({ text: replyText });

      console.log(
        `[Pulse:DetectConflictsAction] Done — events=${events.length}, ` +
        `conflicts=${conflicts.length}, inserted=${inserted}, errors=${errors.length}`
      );

      return {
        success: errors.length === 0,
        data: {
          events: events.length,
          conflicts: conflicts.length,
          inserted,
          errors: errors.length > 0 ? errors : undefined,
        },
        text: replyText,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:DetectConflictsAction] Unexpected error: ${errMsg}`);
      if (callback) {
        await callback({ text: `Calendar scan failed: ${errMsg}` });
      }
      return { success: false, error: errMsg };
    }
  },
};
