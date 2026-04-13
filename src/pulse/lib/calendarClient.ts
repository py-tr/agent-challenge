/**
 * src/pulse/lib/calendarClient.ts
 * Day 2 MCP Spike — Google Calendar client with MCP-first / REST fallback
 *
 * Standalone run:
 *   npx tsx src/pulse/lib/calendarClient.ts
 *
 * Reuses Google OAuth credentials from gmailClient (same env vars).
 * OAuth scope required (add when generating your refresh token):
 *   https://www.googleapis.com/auth/calendar.readonly
 *
 * Access paths (tried in order):
 *   A. MCP  — set CALENDAR_MCP_SERVER_URL (e.g. http://localhost:3002)
 *   B. REST — set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN
 */

import { fileURLToPath } from "node:url";
import { refreshAccessToken } from "./gmailClient.js";

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;        // ISO 8601 — datetime or date for all-day
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees: string[];  // display names or emails
  calendarId: string;
}

export type CalendarPath = "mcp" | "rest" | "cache";

export interface CalendarResult {
  events: CalendarEvent[];
  path: CalendarPath;
  windowStart: string;  // ISO — included for logging / demo StatusBar
  windowEnd: string;
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return ISO strings for [now, now + days]. */
function timeWindow(days: number): { min: string; max: string } {
  const min = new Date();
  const max = new Date(min.getTime() + days * 24 * 60 * 60 * 1000);
  return { min: min.toISOString(), max: max.toISOString() };
}

// ─── REST Path ────────────────────────────────────────────────────────────────

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

async function restListEvents(
  days: number,
  calendarId = "primary"
): Promise<CalendarEvent[]> {
  const token = await refreshAccessToken();
  const { min, max } = timeWindow(days);

  const params = new URLSearchParams({
    timeMin: min,
    timeMax: max,
    singleEvents: "true",   // expand recurring events into instances
    orderBy: "startTime",
    maxResults: "100",
  });

  const resp = await fetch(
    `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) {
    throw new Error(`Calendar list HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      location?: string;
      description?: string;
      attendees?: Array<{ displayName?: string; email: string }>;
    }>;
  };

  return (data.items ?? []).map((item) => {
    const startRaw = item.start.dateTime ?? item.start.date ?? "";
    const endRaw = item.end.dateTime ?? item.end.date ?? "";
    const allDay = !item.start.dateTime;

    const attendees = (item.attendees ?? []).map(
      (a) => a.displayName ?? a.email
    );

    return {
      id: item.id,
      title: item.summary ?? "(untitled)",
      start: startRaw,
      end: endRaw,
      allDay,
      location: item.location,
      description: item.description,
      attendees,
      calendarId,
    } satisfies CalendarEvent;
  });
}

// ─── MCP Path ────────────────────────────────────────────────────────────────
//
// Requires: pnpm add @modelcontextprotocol/sdk
//
// The server at CALENDAR_MCP_SERVER_URL must expose a tool named
// "gcal_list_events" compatible with the Google Calendar MCP schema.
// The claude.ai Calendar MCP (gcal_list_events tool) uses this shape:
//   { calendarId, timeMin, timeMax, singleEvents, orderBy, maxResults }
//
// If the package is missing or the server is unreachable, the error
// is caught by listEvents() and REST is tried next.

async function mcpListEvents(
  serverUrl: string,
  days: number
): Promise<CalendarEvent[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Client } = (await import("@modelcontextprotocol/sdk/client/index.js")) as any;
  const { StreamableHTTPClientTransport } = (await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )) as any;

  const { min, max } = timeWindow(days);
  const client = new Client({ name: "pulse-spike-cal", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("/mcp", serverUrl)
  );

  await client.connect(transport);

  try {
    const result = (await client.callTool({
      name: "gcal_list_events",
      arguments: {
        calendarId: "primary",
        timeMin: min,
        timeMax: max,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 100,
      },
    })) as { content: Array<{ type: string; text: string }> };

    const raw = result.content[0]?.text ?? "[]";

    // MCP result may be a JSON array or a human-readable string depending
    // on the server implementation. Try JSON parse; fall through if not.
    try {
      const parsed = JSON.parse(raw) as CalendarEvent[];
      return parsed;
    } catch {
      // Server returned a human-readable summary — not machine-parseable.
      // Treat as empty so REST fallback runs.
      throw new Error(`MCP returned non-JSON response: ${raw.slice(0, 120)}`);
    }
  } finally {
    await client.close();
  }
}

// ─── Create Event ─────────────────────────────────────────────────────────────

export interface NewCalendarEvent {
  title: string;
  /** ISO 8601 datetime, e.g. "2026-04-11T14:00:00" */
  start: string;
  /** ISO 8601 datetime */
  end: string;
  location?: string;
  description?: string;
  /** IANA timezone, e.g. "America/New_York". Defaults to "UTC". */
  timeZone?: string;
  attendees?: string[];   // email addresses
}

/**
 * Create a new event on the primary Google Calendar via the REST API.
 * Returns the created CalendarEvent (with its server-assigned id).
 */
export async function createEvent(
  event: NewCalendarEvent,
  calendarId = "primary"
): Promise<CalendarEvent> {
  const token = await refreshAccessToken();

  const body: Record<string, unknown> = {
    summary: event.title,
    start: {
      dateTime: event.start,
      timeZone: event.timeZone ?? "UTC",
    },
    end: {
      dateTime: event.end,
      timeZone: event.timeZone ?? "UTC",
    },
  };

  if (event.location) body.location = event.location;
  if (event.description) body.description = event.description;
  if (event.attendees && event.attendees.length > 0) {
    body.attendees = event.attendees.map((email) => ({ email }));
  }

  const resp = await fetch(
    `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Calendar create HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    id: string;
    summary?: string;
    start: { dateTime?: string; date?: string };
    end: { dateTime?: string; date?: string };
    location?: string;
    description?: string;
    attendees?: Array<{ displayName?: string; email: string }>;
  };

  return {
    id:          data.id,
    title:       data.summary ?? event.title,
    start:       data.start.dateTime ?? data.start.date ?? event.start,
    end:         data.end.dateTime ?? data.end.date ?? event.end,
    allDay:      !data.start.dateTime,
    location:    data.location,
    description: data.description,
    attendees:   (data.attendees ?? []).map((a) => a.displayName ?? a.email),
    calendarId,
  };
}

/**
 * Update the start/end time of an existing event (PATCH).
 * Returns the updated CalendarEvent.
 */
export async function updateEvent(
  eventId: string,
  patch: { start: string; end: string; timeZone?: string },
  calendarId = "primary"
): Promise<CalendarEvent> {
  const token = await refreshAccessToken();

  const tz = patch.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = {
    start: { dateTime: patch.start, timeZone: tz },
    end:   { dateTime: patch.end,   timeZone: tz },
  };

  const resp = await fetch(
    `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Calendar update HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    id: string;
    summary?: string;
    start: { dateTime?: string; date?: string };
    end:   { dateTime?: string; date?: string };
    location?: string;
    description?: string;
    attendees?: Array<{ displayName?: string; email: string }>;
  };

  return {
    id:          data.id,
    title:       data.summary ?? "",
    start:       data.start.dateTime ?? data.start.date ?? patch.start,
    end:         data.end.dateTime   ?? data.end.date   ?? patch.end,
    allDay:      !data.start.dateTime,
    location:    data.location,
    description: data.description,
    attendees:   (data.attendees ?? []).map((a) => a.displayName ?? a.email),
    calendarId,
  };
}

export async function deleteEvent(
  eventId: string,
  calendarId = "primary"
): Promise<void> {
  const token = await refreshAccessToken();

  const resp = await fetch(
    `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!resp.ok && resp.status !== 204 && resp.status !== 410) {
    const text = await resp.text();
    throw new Error(`Calendar delete HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch calendar events for the next `days` days.
 * MCP is tried first when CALENDAR_MCP_SERVER_URL is set; REST is the fallback.
 */
export async function listEvents(days = 7): Promise<CalendarResult> {
  const { min: windowStart, max: windowEnd } = timeWindow(days);
  const mcpUrl = process.env.CALENDAR_MCP_SERVER_URL?.trim();

  if (mcpUrl) {
    try {
      const events = await mcpListEvents(mcpUrl, days);
      return { events, path: "mcp", windowStart, windowEnd };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[CalendarClient] MCP failed (${msg}), falling back to REST`);
    }
  }

  try {
    const events = await restListEvents(days);
    return { events, path: "rest", windowStart, windowEnd };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[CalendarClient] REST also failed: ${error}`);
    return { events: [], path: "cache", windowStart, windowEnd, error };
  }
}

/**
 * Quick overlap check between two events — used later by conflictDetector.ts.
 * Returns true if the events overlap by any amount.
 */
export function eventsOverlap(a: CalendarEvent, b: CalendarEvent): boolean {
  if (a.allDay || b.allDay) return false; // skip all-day for conflict detection
  const aStart = new Date(a.start).getTime();
  const aEnd = new Date(a.end).getTime();
  const bStart = new Date(b.start).getTime();
  const bEnd = new Date(b.end).getTime();
  return aStart < bEnd && bStart < aEnd;
}

// ─── Standalone Spike ─────────────────────────────────────────────────────────
// Run only when this file is the direct entry point:
//   npx tsx src/pulse/lib/calendarClient.ts

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  void (async () => {
    console.log("╔═══════════════════════════════════╗");
    console.log("║  Pulse — Calendar Client Spike    ║");
    console.log("╚═══════════════════════════════════╝\n");

    console.log("Env check:");
    console.log(
      `  CALENDAR_MCP_SERVER_URL : ${process.env.CALENDAR_MCP_SERVER_URL ?? "(not set)"}`
    );
    console.log(
      `  GOOGLE_CLIENT_ID        : ${process.env.GOOGLE_CLIENT_ID ? "✓ set" : "✗ missing"}`
    );
    console.log(
      `  GOOGLE_CLIENT_SECRET    : ${process.env.GOOGLE_CLIENT_SECRET ? "✓ set" : "✗ missing"}`
    );
    console.log(
      `  GOOGLE_REFRESH_TOKEN    : ${process.env.GOOGLE_REFRESH_TOKEN ? "✓ set" : "✗ missing"}`
    );
    console.log("");

    const result = await listEvents(7);

    if (result.error) {
      console.error(`✗ SPIKE FAILED\n  ${result.error}\n`);
      console.error("Add one of the following to your .env:");
      console.error(
        "  Path A (MCP):  CALENDAR_MCP_SERVER_URL=http://localhost:3002"
      );
      console.error(
        "  Path B (REST): GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN"
      );
      console.error(
        "\nScope required: https://www.googleapis.com/auth/calendar.readonly"
      );
      process.exit(1);
    }

    const fromDate = new Date(result.windowStart).toDateString();
    const toDate = new Date(result.windowEnd).toDateString();

    console.log(`✓ Connected via: ${result.path.toUpperCase()}`);
    console.log(`✓ Window: ${fromDate} → ${toDate}`);
    console.log(`✓ Events fetched: ${result.events.length}\n`);
    console.log("─".repeat(60));

    if (result.events.length === 0) {
      console.log("  (no events in this window)");
    }

    // Group by day for readable output
    const byDay = new Map<string, CalendarEvent[]>();
    for (const ev of result.events) {
      const day = ev.start.slice(0, 10); // YYYY-MM-DD
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(ev);
    }

    for (const [day, events] of byDay) {
      const label = new Date(day + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
      console.log(`\n${label}`);

      for (const ev of events) {
        const timeStr = ev.allDay
          ? "All day"
          : `${ev.start.slice(11, 16)} – ${ev.end.slice(11, 16)}`;
        const loc = ev.location ? `  📍 ${ev.location.slice(0, 50)}` : "";
        console.log(`  • ${timeStr.padEnd(13)} ${ev.title}${loc}`);
        if (ev.attendees.length > 0) {
          console.log(
            `                 👥 ${ev.attendees.slice(0, 3).join(", ")}${ev.attendees.length > 3 ? ` +${ev.attendees.length - 3} more` : ""}`
          );
        }
      }
    }

    console.log("\n" + "─".repeat(60));

    // Bonus: surface any same-day overlaps immediately
    const overlaps: Array<[CalendarEvent, CalendarEvent]> = [];
    for (const events of byDay.values()) {
      for (let i = 0; i < events.length; i++) {
        for (let j = i + 1; j < events.length; j++) {
          if (eventsOverlap(events[i]!, events[j]!)) {
            overlaps.push([events[i]!, events[j]!]);
          }
        }
      }
    }

    if (overlaps.length > 0) {
      console.log(`\n⚠  ${overlaps.length} overlap(s) detected:`);
      for (const [a, b] of overlaps) {
        console.log(`   "${a.title}" (${a.start.slice(11, 16)}) ↔ "${b.title}" (${b.start.slice(11, 16)})`);
      }
    } else {
      console.log("\n✓ No overlaps in this window.");
    }

    console.log("\n✓ SPIKE PASSED — proceed to Day 3 (DB Schema)");
  })().catch((err: unknown) => {
    console.error("Unhandled:", err);
    process.exit(1);
  });
}
