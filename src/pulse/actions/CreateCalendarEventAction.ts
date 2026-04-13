/**
 * src/pulse/actions/CreateCalendarEventAction.ts
 * ElizaOS Action — detect natural-language calendar creation requests,
 * extract structured event details via LLM, create the event in Google
 * Calendar, queue it as a "follow_up" action item for user confirmation,
 * and report back in the chat.
 *
 * Detected phrases (examples):
 *   "Schedule a meeting with Sarah on Monday at 3pm"
 *   "Add golf tomorrow morning"
 *   "Create a lunch with the team Friday at noon"
 *   "Set up a call with Bob on April 15 at 2:30pm for 45 minutes"
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { CalendarMcpService } from "../services/CalendarMcpService.js";
import { insertActionItem } from "../db/queries.js";
import type { Db } from "../db/schema.js";
import { useModelWithFallback } from "../lib/llmFallback.js";

// ─── Intent detection ─────────────────────────────────────────────────────────

const CALENDAR_INTENT_RE =
  /\b(schedule|book|set\s+up|create|add|plan|organise|organize)\b.{0,60}\b(meeting|call|appointment|event|lunch|dinner|coffee|golf|session|interview|review|standup|stand[-\s]?up|sync|demo)\b/i;

const CALENDAR_QUICK_RE =
  /\b(schedule|book|set\s+up|add|create)\b.{0,80}\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|at\s+\d)/i;

function looksLikeCalendarRequest(text: string): boolean {
  return CALENDAR_INTENT_RE.test(text) || CALENDAR_QUICK_RE.test(text);
}

// ─── LLM extraction ───────────────────────────────────────────────────────────

interface ExtractedEvent {
  title: string;
  date: string;          // YYYY-MM-DD
  startTime: string;     // HH:MM (24-hour)
  durationMinutes: number;
  location?: string;
  attendees?: string[];  // email addresses only
  timeZone?: string;     // IANA, e.g. "America/New_York"
}

// ─── Date/time context builder ────────────────────────────────────────────────

/**
 * Pre-compute all relative date references so the small LLM never has to
 * do calendar arithmetic itself. Returns a multi-line string to inject into
 * the prompt and a lookup map for validation.
 */
function buildDateTimeContext(now: Date): string {
  const pad  = (n: number) => String(n).padStart(2, "0");
  const ymd  = (d: Date)   => d.toISOString().slice(0, 10);
  const hm   = (d: Date)   => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const DAY_NAMES = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const todayIdx  = now.getDay();

  // next occurrence of each weekday (same day = 7 days forward, not 0)
  const nextDay = (targetIdx: number): Date => {
    const d = new Date(now);
    let delta = targetIdx - todayIdx;
    if (delta <= 0) delta += 7;
    d.setDate(d.getDate() + delta);
    return d;
  };

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Relative time helpers
  const inHours = (h: number): { date: string; time: string } => {
    const d = new Date(now.getTime() + h * 3_600_000);
    return { date: ymd(d), time: hm(d) };
  };

  const lines: string[] = [
    `=== DATE/TIME REFERENCE (use these exact values — do NOT compute yourself) ===`,
    `today        = ${ymd(now)}  (${DAY_NAMES[todayIdx]})`,
    `tomorrow     = ${ymd(tomorrow)}`,
    ``,
    `--- Next occurrence of each weekday ---`,
    ...DAY_NAMES.map((name, i) => `${name.padEnd(12)} = ${ymd(nextDay(i))}`),
    ``,
    `--- Relative times from NOW (${hm(now)}) ---`,
    `in 1 hour    = ${inHours(1).date} ${inHours(1).time}`,
    `in 2 hours   = ${inHours(2).date} ${inHours(2).time}`,
    `in 3 hours   = ${inHours(3).date} ${inHours(3).time}`,
    `in 30 min    = ${inHours(0.5).date} ${inHours(0.5).time}`,
    ``,
    `--- Time-of-day defaults ---`,
    `morning      = 09:00`,
    `noon / lunch = 12:00`,
    `afternoon    = 14:00`,
    `evening      = 18:00`,
    `night        = 20:00`,
    `=== END REFERENCE ===`,
  ];

  return lines.join("\n");
}

// ─── LLM extraction ───────────────────────────────────────────────────────────

/**
 * Ask the LLM to extract structured event details from the user's message.
 * Returns null if the model can't produce a valid JSON object.
 */
async function extractEventDetails(
  runtime: IAgentRuntime,
  userText: string
): Promise<ExtractedEvent | null> {
  const now = new Date();
  const dateCtx = buildDateTimeContext(now);

  const prompt =
    `${dateCtx}\n\n` +
    `Extract calendar event details from the user's request and return ONLY a JSON object:\n` +
    `{\n` +
    `  "title": string,\n` +
    `  "date": "YYYY-MM-DD",\n` +
    `  "startTime": "HH:MM",\n` +
    `  "durationMinutes": number (default 60),\n` +
    `  "location": string | null,\n` +
    `  "attendees": string[] (email addresses only, may be empty),\n` +
    `  "timeZone": string | null (IANA timezone only if explicitly mentioned)\n` +
    `}\n\n` +
    `User request: "${userText}"\n\n` +
    `CRITICAL rules:\n` +
    `- Use the EXACT dates from the reference table above. Never compute day names yourself.\n` +
    `- "Thursday" → use the thursday value from the table, not any other date.\n` +
    `- "in 2 hours" → use the "in 2 hours" value from the table.\n` +
    `- "postpone X hours" or "X hours later" → add X hours to the stated/implied start time.\n` +
    `- Return ONLY raw JSON. No markdown, no explanation.\n`;

  let raw: string;
  try {
    raw = await useModelWithFallback(runtime, ModelType.TEXT_SMALL, { prompt });
  } catch (err) {
    console.warn(
      "[CreateCalendarEventAction] LLM call failed:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }

  // Strip optional markdown code fences the model might add
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as Partial<ExtractedEvent>;

    if (!parsed.title || !parsed.date || !parsed.startTime) {
      console.warn(
        "[CreateCalendarEventAction] LLM returned incomplete JSON:",
        cleaned.slice(0, 200)
      );
      return null;
    }

    return {
      title:           String(parsed.title),
      date:            String(parsed.date),
      startTime:       String(parsed.startTime),
      durationMinutes: typeof parsed.durationMinutes === "number" ? parsed.durationMinutes : 60,
      location:        typeof parsed.location === "string" ? parsed.location : undefined,
      attendees:       Array.isArray(parsed.attendees) ? parsed.attendees.filter((a): a is string => typeof a === "string") : [],
      timeZone:        typeof parsed.timeZone === "string" ? parsed.timeZone : undefined,
    };
  } catch {
    console.warn(
      "[CreateCalendarEventAction] JSON parse failed. Raw:",
      cleaned.slice(0, 200)
    );
    return null;
  }
}

// ─── Conflict pre-check ───────────────────────────────────────────────────────

/**
 * Returns any existing events that overlap with [newStart, newEnd).
 * All strings are naive ISO datetimes ("YYYY-MM-DDTHH:MM:SS") — compared
 * lexicographically, which is valid for same-timezone strings.
 */
function findOverlappingEvents(
  existingEvents: Array<{ title: string; start: string; end: string }>,
  newStart: string,
  newEnd: string
): Array<{ title: string; start: string; end: string }> {
  const sNew = new Date(newStart).getTime();
  const eNew = new Date(newEnd).getTime();
  return existingEvents.filter((ev) => {
    const sEv = new Date(ev.start).getTime();
    const eEv = new Date(ev.end).getTime();
    return sEv < eNew && eEv > sNew;
  });
}

/** Convert "YYYY-MM-DD" + "HH:MM" to a naive ISO 8601 datetime string. */
function toIso(date: string, time: string): string {
  // Normalise "H:MM" → "HH:MM"
  const normalised = time.includes(":")
    ? time.slice(0, 5).padStart(5, "0")
    : time;
  return `${date}T${normalised}:00`;
}

/**
 * Add `minutes` to a naive ISO datetime string ("YYYY-MM-DDTHH:MM:SS")
 * using pure string/integer arithmetic — no Date objects, no UTC conversion.
 * Handles day overflow correctly up to +24 h.
 */
function addMinutes(naiveIso: string, minutes: number): string {
  const datePart = naiveIso.slice(0, 10);   // "YYYY-MM-DD"
  const timePart = naiveIso.slice(11, 16);  // "HH:MM"
  const [hhStr, mmStr] = timePart.split(":");
  const totalMins = Number(hhStr) * 60 + Number(mmStr) + minutes;
  const newHh = Math.floor(totalMins / 60) % 24;
  const newMm = totalMins % 60;
  const overflowDays = Math.floor(totalMins / 1440);

  let resultDate = datePart;
  if (overflowDays > 0) {
    // Use UTC noon to safely advance the date without DST ambiguity
    const d = new Date(`${datePart}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + overflowDays);
    resultDate = d.toISOString().slice(0, 10);
  }

  return `${resultDate}T${String(newHh).padStart(2, "0")}:${String(newMm).padStart(2, "0")}:00`;
}

// ─── Action ───────────────────────────────────────────────────────────────────

export const createCalendarEventAction: Action = {
  name: "CREATE_CALENDAR_EVENT",
  description:
    "Detect natural-language calendar creation requests ('schedule a meeting', " +
    "'add golf tomorrow'), extract structured details via LLM, create the event " +
    "in Google Calendar, and queue it as a follow_up action item for confirmation.",

  similes: [
    "SCHEDULE_EVENT",
    "ADD_TO_CALENDAR",
    "BOOK_MEETING",
    "CREATE_MEETING",
    "CALENDAR_ADD",
    "SET_UP_MEETING",
  ],

  examples: [
    [
      { name: "user", content: { text: "Schedule a team sync tomorrow at 10am" } },
      { name: "Pulse", content: { text: "I've added 'Team Sync' to your calendar for tomorrow at 10:00 AM and queued it for your confirmation." } },
    ],
    [
      { name: "user", content: { text: "Book a golf round on Saturday morning" } },
      { name: "Pulse", content: { text: "Added 'Golf' for Saturday at 09:00 AM — it's in your queue for final approval." } },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory
  ): Promise<boolean> => {
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content as { text?: string })?.text ?? "";
    return looksLikeCalendarRequest(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const rawText =
      typeof message.content === "string"
        ? message.content
        : (message.content as { text?: string })?.text ?? "";

    // ── 1. Extract structured event details ─────────────────────────────────
    const details = await extractEventDetails(runtime, rawText);

    if (!details) {
      const errText =
        "I understood you want to create a calendar event, but I couldn't extract the details. " +
        "Try: \"Schedule a meeting with Bob on Friday at 2pm for 1 hour\".";
      await callback?.({ text: errText });
      return { success: false, text: errText, error: "extraction_failed" };
    }

    // ── 2. Conflict pre-check ────────────────────────────────────────────────
    const calSvc = runtime.getService(
      CalendarMcpService.serviceType
    ) as CalendarMcpService | null;

    if (!calSvc) {
      const errText =
        "CalendarMcpService is not available. Make sure Google Calendar credentials are configured.";
      await callback?.({ text: errText });
      return { success: false, text: errText, error: "service_unavailable" };
    }

    const startIso = toIso(details.date, details.startTime);
    const endIso   = addMinutes(startIso, details.durationMinutes);

    // Fetch events for that day and check for overlaps before creating.
    // Skip check if the user explicitly overrides ("schedule anyway").
    const isForced = /schedule\s+anyway|force\s+it|override|ignore\s+conflict/i.test(rawText);
    if (!isForced) try {
      const existingEvents = await calSvc.getEvents(14);
      const overlapping = findOverlappingEvents(existingEvents, startIso, endIso);

      if (overlapping.length > 0) {
        const conflictList = overlapping
          .map((ev) => `**${ev.title}** (${ev.start.slice(11, 16)}–${ev.end.slice(11, 16)})`)
          .join(", ");

        const warnText =
          `⚠ You already have ${conflictList} at that time. ` +
          `The event was **not** created. ` +
          `Choose a different time or say "schedule anyway" to override.`;

        await callback?.({ text: warnText });
        return { success: false, text: warnText, error: "conflict" };
      }
    } catch (err) {
      // Non-fatal — if we can't fetch existing events, proceed with creation.
      console.warn(
        "[CreateCalendarEventAction] Conflict pre-check failed (proceeding):",
        err instanceof Error ? err.message : String(err)
      );
    }

    // Prefer LLM-detected timezone; fall back to the system's local timezone
    // (works correctly on the user's machine — avoids UTC shifting 1pm → 11am).
    const timeZone = details.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

    console.log("[Calendar] Creating event:", startIso, endIso, "tz:", timeZone);

    let createdEvent;
    try {
      createdEvent = await calSvc.createEvent({
        title:       details.title,
        start:       startIso,
        end:         endIso,
        location:    details.location,
        attendees:   details.attendees,
        timeZone,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errText = `Failed to create calendar event: ${msg}`;
      await callback?.({ text: errText });
      return { success: false, text: errText, error: msg };
    }

    // ── 3. Queue as follow_up action item ───────────────────────────────────
    const db = runtime.db as unknown as Db;
    const startReadable = new Date(startIso).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });

    const body =
      `**Event:** ${details.title}\n` +
      `**When:** ${startReadable}\n` +
      `**Duration:** ${details.durationMinutes} min\n` +
      (details.location ? `**Location:** ${details.location}\n` : "") +
      (details.attendees && details.attendees.length > 0
        ? `**Attendees:** ${details.attendees.join(", ")}\n`
        : "") +
      `\nCalendar event created (id: ${createdEvent.id}). Approve to confirm it's correctly scheduled.`;

    try {
      await insertActionItem(db, {
        type:     "follow_up",
        title:    `New event: ${details.title}`,
        body,
        metadata: {
          calendarEventId: createdEvent.id,
          start:           createdEvent.start,
          end:             createdEvent.end,
          source:          "create-calendar-event-action",
        },
        priority: 3,
      });
    } catch (insertErr) {
      // Non-fatal — the event was created; just log the queue failure.
      console.warn(
        "[CreateCalendarEventAction] Failed to insert action item:",
        insertErr instanceof Error ? insertErr.message : String(insertErr)
      );
    }

    // ── 4. Report back to user ───────────────────────────────────────────────
    const confirmText =
      `Done! I've added **${details.title}** to your calendar for ${startReadable}` +
      (details.durationMinutes !== 60 ? ` (${details.durationMinutes} min)` : "") +
      "." +
      (details.location ? ` Location: ${details.location}.` : "") +
      " I've also added it to your queue — approve it to confirm.";

    await callback?.({ text: confirmText });
    return {
      success: true,
      text: confirmText,
      data: {
        eventId:  createdEvent.id,
        title:    details.title,
        start:    createdEvent.start,
        end:      createdEvent.end,
      },
    };
  },
};
