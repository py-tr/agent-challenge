/**
 * Test 6 — Calendar conflict detection
 *
 * detectConflicts finds overlapping event pairs and calls LLM for suggestion.
 * We mock the runtime to return a fixed suggestion string.
 */

import { describe, it, expect } from "vitest";
import { detectConflicts } from "../lib/conflictDetector.js";
import { eventsOverlap } from "../lib/calendarClient.js";
import { makeMockRuntime } from "./helpers.js";
import type { CalendarEvent } from "../lib/calendarClient.js";

function makeEvent(
  id: string,
  title: string,
  startHH: number,
  endHH: number,
  date = "2026-04-10"
): CalendarEvent {
  return {
    id,
    title,
    start: `${date}T${String(startHH).padStart(2, "0")}:00:00`,
    end: `${date}T${String(endHH).padStart(2, "0")}:00:00`,
    allDay: false,
    attendees: [],
    calendarId: "primary",
  };
}

describe("eventsOverlap", () => {
  it("detects overlap when events share time", () => {
    const a = makeEvent("a", "Team sync", 14, 15);
    const b = makeEvent("b", "Client call", 14, 15, "2026-04-10");
    // Both 14:00–15:00 on same day — full overlap
    b.start = "2026-04-10T14:45:00";
    b.end = "2026-04-10T15:45:00";
    expect(eventsOverlap(a, b)).toBe(true);
  });

  it("returns false for back-to-back events (no overlap)", () => {
    const a = makeEvent("a", "Morning standup", 9, 10);
    const b = makeEvent("b", "Design review", 10, 11);
    expect(eventsOverlap(a, b)).toBe(false);
  });

  it("returns false for all-day events (skipped by design)", () => {
    const a: CalendarEvent = {
      id: "a",
      title: "Holiday",
      start: "2026-04-10",
      end: "2026-04-11",
      allDay: true,
      attendees: [],
      calendarId: "primary",
    };
    const b = makeEvent("b", "Meeting", 14, 15);
    expect(eventsOverlap(a, b)).toBe(false);
  });
});

describe("detectConflicts", () => {
  const runtime = makeMockRuntime({
    modelResponse:
      "Reschedule 'Team sync' to 3pm — it has fewer attendees than 'Client call'.",
  });

  it("returns one ConflictResult for two overlapping events", async () => {
    const teamSync = makeEvent("ev1", "Team sync", 14, 15);
    const clientCall = makeEvent("ev2", "Client call", 14, 15);
    clientCall.start = "2026-04-10T14:30:00"; // overlap by 30 min

    const conflicts = await detectConflicts(runtime, [teamSync, clientCall]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.overlapMinutes).toBe(30);
    expect(conflicts[0]!.suggestion).toBeTruthy();
    expect(typeof conflicts[0]!.suggestion).toBe("string");
  });

  it("returns empty array when no events overlap", async () => {
    const morning = makeEvent("ev3", "Morning standup", 9, 10);
    const afternoon = makeEvent("ev4", "Design review", 14, 15);

    const conflicts = await detectConflicts(runtime, [morning, afternoon]);
    expect(conflicts).toHaveLength(0);
  });

  it("detects multiple conflicts in a busy day", async () => {
    // Three events that all overlap with each other
    const a = makeEvent("ea", "A", 13, 16);
    const b = makeEvent("eb", "B", 14, 17);
    const c = makeEvent("ec", "C", 15, 18);

    const conflicts = await detectConflicts(runtime, [a, b, c]);
    // 3 pairs: (a,b), (a,c), (b,c) — all overlap
    expect(conflicts.length).toBeGreaterThanOrEqual(3);
  });

  it("returns empty array for empty event list", async () => {
    const conflicts = await detectConflicts(runtime, []);
    expect(conflicts).toHaveLength(0);
  });
});
