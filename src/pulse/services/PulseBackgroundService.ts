/**
 * src/pulse/services/PulseBackgroundService.ts
 * Core ElizaOS Service — background processing at 6-hour intervals.
 *
 * Lifecycle managed by ElizaOS runtime:
 *   1. Runtime calls PulseBackgroundService.start(runtime) on plugin init.
 *   2. Static start() creates the instance and calls onStart().
 *   3. Runtime calls instance.stop() (via static stop()) on shutdown.
 *
 * Processing cycle is a placeholder on Day 4.
 * Filled in on Day 5 (email), Day 6 (Slib Guard), Day 7 (calendar).
 */

import { Service, type IAgentRuntime } from "@elizaos/core";

const CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class PulseBackgroundService extends Service {
  // Custom service type — a string not in the built-in ServiceTypeRegistry.
  // Registered in the runtime's service map under this key.
  static readonly serviceType = "pulse";

  readonly capabilityDescription =
    "Processes Gmail and Google Calendar events on a 6-hour schedule. " +
    "Classifies emails, detects calendar conflicts, tracks commitments via " +
    "Slib Guard, and populates the action approval queue in PGLite.";

  private cycleInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Called by ElizaOS runtime when the plugin is registered.
   * Must return a fully initialised Service instance.
   */
  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new PulseBackgroundService(runtime);
    await service.onStart();
    return service;
  }

  /**
   * Called by ElizaOS runtime on agent shutdown.
   * Delegates to the running instance's stop().
   */
  static override async stop(runtime: IAgentRuntime): Promise<void> {
    const instance = runtime.getService<PulseBackgroundService>(
      PulseBackgroundService.serviceType
    );
    await instance?.stop();
  }

  /** Instance stop — clears the scheduled interval. */
  async stop(): Promise<void> {
    if (this.cycleInterval !== null) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
    console.log("[Pulse] Background service stopped.");
  }

  // ─── Startup ────────────────────────────────────────────────────────────────

  private async onStart(): Promise<void> {
    console.log("[Pulse] Pulse background service started");

    // Run one cycle immediately so the queue is populated on first launch,
    // then repeat every CYCLE_INTERVAL_MS.
    void this.processEmailsAndCalendar();

    this.cycleInterval = setInterval(() => {
      void this.processEmailsAndCalendar();
    }, CYCLE_INTERVAL_MS);
  }

  // ─── Processing Cycle ───────────────────────────────────────────────────────

  /**
   * Main processing cycle. Public so ProcessEmailsAction can trigger it
   * manually (e.g. during judging if the scheduled run hasn't fired yet).
   *
   * Day 5: fetch + classify emails via GmailMcpService
   * Day 6: run Slib Guard commitment scan via SlibGuardEvaluator helper
   * Day 7: detect calendar conflicts via CalendarMcpService
   */
  async processEmailsAndCalendar(): Promise<void> {
    const jobType = process.env.PULSE_JOB_TYPE ?? "scheduled";
    const startedAt = new Date().toISOString();

    console.log(
      `[Pulse] Processing cycle started — job_type=${jobType} at=${startedAt}`
    );

    // ── Day 5 placeholder ───────────────────────────────────────────────────
    // const gmailResult = await GmailMcpService.getInstance(this.runtime).fetchAndClassify();

    // ── Day 6 placeholder ───────────────────────────────────────────────────
    // await scanPendingReminders(this.runtime);

    // ── Day 7 placeholder ───────────────────────────────────────────────────
    // const conflicts = await CalendarMcpService.getInstance(this.runtime).detectConflicts();

    console.log("[Pulse] Processing cycle complete.");
  }
}
