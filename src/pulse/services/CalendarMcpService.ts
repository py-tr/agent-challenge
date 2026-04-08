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
import { listEvents, type CalendarEvent } from "../lib/calendarClient.js";

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
    console.log("[Pulse:CalendarMcpService] Service started.");
    return svc;
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    const instance = runtime.getService<CalendarMcpService>(
      CalendarMcpService.serviceType
    );
    await instance?.stop();
  }

  async stop(): Promise<void> {
    console.log("[Pulse:CalendarMcpService] Service stopped.");
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

      console.log(
        `[Pulse:CalendarMcpService] Fetched ${result.events.length} events ` +
        `via ${result.path.toUpperCase()}.`
      );

      return result.events;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Pulse:CalendarMcpService] Live fetch failed (${msg}), using cache.`
      );
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

  // ── Internal ─────────────────────────────────────────────────────────────────

  private async getCachedEvents(): Promise<CalendarEvent[]> {
    const cache = await this.runtime.getCache<CalendarCache>(
      "pulse:calendar:last_fetch"
    );
    return cache?.events ?? [];
  }
}
