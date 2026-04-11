/**
 * src/pulse/services/CalendarMcpService.ts
 * ElizaOS Service — wraps calendarClient.listEvents() and caches results.
 *
 * Responsibilities:
 *   - Expose `getEvents(days?)` for other Pulse components.
 *   - Cache the last successful fetch in PGLite (key: "pulse:calendar:last_fetch").
 *   - On any fetch error, return cached events so the dashboard is never empty.
 *
 * Conflict detection is intentionally NOT done here — it lives in
 * conflictDetector.ts and is invoked by PulseBackgroundService and
 * DetectConflictsAction, both of which pass runtime to the LLM.
 */

import { Service } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { listEvents, createEvent, type CalendarEvent, type NewCalendarEvent } from "../lib/calendarClient.js";

// ─── Cache Shape ──────────────────────────────────────────────────────────────

interface CalendarCache {
  fetchedAt: string;      // ISO datetime
  events: CalendarEvent[];
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class CalendarMcpService extends Service {
  static readonly serviceType = "pulse-calendar";

  readonly capabilityDescription =
    "Fetches Google Calendar events for the next N days and caches them in " +
    "PGLite so the dashboard is never empty even when Google is unavailable.";

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const svc = new CalendarMcpService(runtime);
    return svc;
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    const instance = runtime.getService<CalendarMcpService>(
      CalendarMcpService.serviceType
    );
    await instance?.stop();
  }

  async stop(): Promise<void> {
    // No persistent resources to clean up.
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Fetch calendar events for the next `days` days.
   * Returns cached events if the live fetch fails.
   */
  async getEvents(days = 7): Promise<CalendarEvent[]> {
    try {
      const result = await listEvents(days);

      if (result.events.length > 0) {
        const cache: CalendarCache = {
          fetchedAt: new Date().toISOString(),
          events: result.events,
        };
        await this.runtime.setCache<CalendarCache>(
          "pulse:calendar:last_fetch",
          cache
        );
      }

      return result.events;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:CalendarMcpService] Live fetch failed (${msg}), using cache.`);
      return this.getCachedEvents();
    }
  }

  /** Metadata for the StatusBar — when was the last successful fetch? */
  async getLastFetchInfo(): Promise<{ fetchedAt: string | null; eventCount: number }> {
    const cache = await this.runtime.getCache<CalendarCache>(
      "pulse:calendar:last_fetch"
    );
    if (!cache) return { fetchedAt: null, eventCount: 0 };
    return { fetchedAt: cache.fetchedAt, eventCount: cache.events.length };
  }

  /**
   * Create a new calendar event via the REST API.
   * Invalidates the local cache so the next getEvents() reflects the new event.
   */
  async createEvent(event: NewCalendarEvent, calendarId?: string): Promise<CalendarEvent> {
    const created = await createEvent(event, calendarId);
    // Invalidate the cache so the next getEvents() does a fresh fetch.
    // Using deleteCache rather than setCache(key, null) — null causes a DB insert error.
    await this.runtime.deleteCache("pulse:calendar:last_fetch").catch(() => { /* ignore if key absent */ });
    console.log(`[Pulse:Routes] CalendarMcpService created event "${created.title}" (id=${created.id})`);
    return created;
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private async getCachedEvents(): Promise<CalendarEvent[]> {
    const cache = await this.runtime.getCache<CalendarCache>(
      "pulse:calendar:last_fetch"
    );
    return cache?.events ?? [];
  }
}
