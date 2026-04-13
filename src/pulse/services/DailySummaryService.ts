/**
 * src/pulse/services/DailySummaryService.ts
 * ElizaOS Service — sends a daily summary email at 18:00 local time.
 *
 * Checks every minute: if hour === 18 AND today's date hasn't been sent yet,
 * builds a plain-text HTML summary of the day's activity and sends it via
 * GmailMcpService.sendEmail().
 *
 * State: the last-sent date (YYYY-MM-DD) is stored in the runtime cache under
 * "pulse:daily-summary:last-sent-date" so it survives restarts within the same day.
 *
 * If Gmail credentials are not configured the send is silently skipped.
 */

import { Service } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { countAllStatuses } from "../db/queries.js";
import type { Db } from "../db/schema.js";
import { GmailMcpService } from "./GmailMcpService.js";
import { localYMD, localHour } from "../lib/userTimezone.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_TYPE        = "pulse-daily-summary";
const CACHE_KEY           = "pulse:daily-summary:last-sent-date";
const CHECK_INTERVAL_MS   = 60_000; // check every minute
const SEND_HOUR           = 18;     // local hour at which the summary fires

// ─── Service ──────────────────────────────────────────────────────────────────

export class DailySummaryService extends Service {
  static readonly serviceType = SERVICE_TYPE;

  readonly capabilityDescription =
    "Sends a daily summary email at 18:00 local time with pending queue counts " +
    "and today's activity via GmailMcpService.";

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const svc = new DailySummaryService(runtime);
    svc.startInterval();
    return svc;
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    const instance = runtime.getService<DailySummaryService>(SERVICE_TYPE);
    await instance?.stop();
  }

  async stop(): Promise<void> {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private startInterval(): void {
    this.intervalHandle = setInterval(() => {
      void this.checkAndSend().catch((err: unknown) => {
        console.error(
          "[Pulse:DailySummary] Error in check interval:",
          err instanceof Error ? err.message : String(err)
        );
      });
    }, CHECK_INTERVAL_MS);
  }

  private async checkAndSend(): Promise<void> {
    const now = new Date();
    if (localHour(now) !== SEND_HOUR) return;

    const todayStr = localYMD(now); // user's local YYYY-MM-DD

    const lastSent = await this.runtime.getCache<string>(CACHE_KEY);
    if (lastSent === todayStr) return; // already sent today

    // Mark as sent first to prevent double-sends if sendEmail() is slow
    await this.runtime.setCache(CACHE_KEY, todayStr);

    try {
      await this.sendSummary(now);
    } catch (err) {
      console.error(
        "[Pulse:DailySummary] Failed to send summary email:",
        err instanceof Error ? err.message : String(err)
      );
      // Roll back the sent flag so it retries within the same hour window
      await this.runtime.setCache(CACHE_KEY, "").catch(() => {/* ignore */});
    }
  }

  private async sendSummary(now: Date): Promise<void> {
    const gmailSvc = this.runtime.getService<GmailMcpService>(
      GmailMcpService.serviceType
    );
    if (!gmailSvc) return; // Gmail not configured — skip silently

    const senderEmail = process.env.GMAIL_SENDER_EMAIL?.trim();
    if (!senderEmail) return; // no recipient configured — skip silently

    const db = this.runtime.db as unknown as Db;
    const counts = await countAllStatuses(db);

    const dateLabel = now.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const subject = `Pulse Daily Summary — ${dateLabel}`;
    const body = buildSummaryBody(dateLabel, counts);

    await gmailSvc.sendEmail(senderEmail, subject, body);
    console.log(`[Pulse:Routes] DailySummaryService sent summary for ${now.toISOString().slice(0, 10)}`);
  }
}

// ─── Email Body Builder ───────────────────────────────────────────────────────

function buildSummaryBody(
  dateLabel: string,
  counts: { pending: number; approved: number; rejected: number }
): string {
  const total = counts.approved + counts.rejected;
  return [
    `Pulse — Daily Summary`,
    `${dateLabel}`,
    ``,
    `Queue Status`,
    `────────────`,
    `Pending decisions : ${counts.pending}`,
    `Approved today    : ${counts.approved}`,
    `Rejected today    : ${counts.rejected}`,
    `Total processed   : ${total}`,
    ``,
    `Open your dashboard at http://localhost:3000/pulse/dashboard`,
    ``,
    `— Pulse, your Chief of Staff`,
  ].join("\n");
}
