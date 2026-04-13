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
import { PulseBackgroundService } from "../services/PulseBackgroundService.js";

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
    if (callback) {
      await callback({ text: "Scanning your calendar for the next 14 days…" });
    }

    try {
      const bgSvc = runtime.getService(
        PulseBackgroundService.serviceType
      ) as PulseBackgroundService | null;

      if (!bgSvc) {
        const errMsg = "Background service not initialised.";
        if (callback) await callback({ text: `⚠ ${errMsg}` });
        return { success: false, error: errMsg };
      }

      // Delegate to stageConflicts() via runProcessingCycle() — dedup is handled there.
      const result = await bgSvc.runProcessingCycle();
      const { conflicts } = result;

      const replyText = conflicts.error
        ? `Calendar scan failed: ${conflicts.error}`
        : conflicts.inserted === 0
          ? `✓ Scanned ${conflicts.processed} event pair(s) — no new conflicts found.`
          : `✓ Scanned ${conflicts.processed} event(s). Found ${conflicts.inserted} new conflict(s) — added to your approval queue.`;

      if (callback) await callback({ text: replyText });

      return {
        success: !conflicts.error,
        data: result as unknown as Record<string, unknown>,
        text: replyText,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:DetectConflictsAction] Unexpected error: ${errMsg}`);
      if (callback) await callback({ text: `Calendar scan failed: ${errMsg}` });
      return { success: false, error: errMsg };
    }
  },
};
