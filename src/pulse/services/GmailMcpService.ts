/**
 * src/pulse/services/GmailMcpService.ts
 * ElizaOS Service that wraps gmailClient.ts with two responsibilities:
 *
 *   1. Token refresh heartbeat — calls refreshAccessToken() every 30 minutes
 *      so the OAuth token never expires between processing cycles.
 *
 *   2. Fetch + classify emails — on first run does a full inbox fetch and
 *      stores the Gmail historyId as a cursor. Subsequent runs call
 *      history.list(startHistoryId) to get only new messages since the last
 *      sync, eliminating the need for a processed-IDs dedup set.
 *
 * PGLite Migrations:
 *   Tables are created on first start by calling runMigrations(runtime.db).
 *   Using runtime.db (the runtime's existing connection) avoids the
 *   "one writer per directory" constraint — no second PGLite instance is opened.
 *
 * Usage:
 *   const svc = runtime.getService<GmailMcpService>(GmailMcpService.serviceType);
 *   const items = await svc.fetchAndClassify();
 */

import { Service } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import {
  listMessages,
  refreshAccessToken,
  getProfile,
  listNewMessages,
  sendEmail as gmailSendEmail,
  HistoryExpiredError,
} from "../lib/gmailClient.js";
import type { GmailMessage } from "../lib/gmailClient.js";
import {
  classifyEmail,
  type ClassificationResult,
} from "../lib/emailClassifier.js";
import { runMigrations } from "../db/migrations.js";
import type { Db } from "../db/schema.js";

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface ClassifiedEmail {
  message: GmailMessage;
  classification: ClassificationResult;
}

interface GmailCache {
  messages: GmailMessage[];
  path: string;
  fetchedAt: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

const CACHE_KEY        = "pulse:gmail:last_fetch";
const HISTORY_ID_KEY   = "pulse:gmail:last_history_id";
const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 min

export class GmailMcpService extends Service {
  static readonly serviceType = "pulse-gmail";

  readonly capabilityDescription =
    "Fetches Gmail messages, classifies them for the approval queue, " +
    "and keeps the OAuth token alive with a 30-minute refresh heartbeat.";

  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new GmailMcpService(runtime);
    await service.onStart();
    return service;
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    const instance = runtime.getService<GmailMcpService>(
      GmailMcpService.serviceType
    );
    await instance?.stop();
  }

  async stop(): Promise<void> {
    if (this.refreshInterval !== null) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  // ─── Startup ────────────────────────────────────────────────────────────────

  private async onStart(): Promise<void> {
    try {
      const db = this.runtime.db as unknown as Db;
      await runMigrations(db);
    } catch (err) {
      console.error(
        "[Pulse:GmailMcpService] Migration error:",
        err instanceof Error ? err.message : String(err)
      );
    }

    void refreshAccessToken().catch(() => {
      /* no-op: env vars not set in dev */
    });

    this.refreshInterval = setInterval(() => {
      void refreshAccessToken().catch((err) => {
        console.error(
          "[Pulse:GmailMcpService] Token refresh heartbeat failed:",
          err instanceof Error ? err.message : String(err)
        );
      });
    }, TOKEN_REFRESH_INTERVAL_MS);

    console.log("[Pulse:Routes] GmailMcpService started — token refresh every 30 min.");
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetch and classify inbox messages using Gmail's incremental History API.
   *
   * First call: full inbox fetch (up to maxMessages), store historyId cursor.
   * Subsequent calls: history.list(lastHistoryId) — only new messages since
   *   the last sync. On HistoryExpiredError (cursor >30 days old), falls back
   *   to a full fetch and resets the cursor.
   */
  async fetchAndClassify(maxMessages = 20): Promise<ClassifiedEmail[]> {
    const storedHistoryId = await this.runtime.getCache<string>(HISTORY_ID_KEY);

    let messages: GmailMessage[];
    let newHistoryId: string;

    if (!storedHistoryId) {
      // ── Initial full fetch ───────────────────────────────────────────────
      messages = await this.fullFetch(maxMessages);
      if (messages.length === 0) return [];

      // Anchor the cursor at the current historyId so the next call is incremental.
      try {
        const profile = await getProfile();
        newHistoryId = profile.historyId;
      } catch (err) {
        console.error(
          "[Pulse:GmailMcpService] Could not fetch profile for historyId anchor:",
          err instanceof Error ? err.message : String(err)
        );
        // Classify what we have even if we can't store a cursor.
        return this.classifyMessages(messages);
      }
    } else {
      // ── Incremental fetch via History API ────────────────────────────────
      try {
        const result = await listNewMessages(storedHistoryId);
        messages = result.messages;
        newHistoryId = result.newHistoryId;
      } catch (err) {
        if (err instanceof HistoryExpiredError) {
          messages = await this.fullFetch(maxMessages);
          if (messages.length === 0) {
            // Still update cursor so next call doesn't re-expire immediately.
            try {
              const profile = await getProfile();
              await this.runtime.setCache(HISTORY_ID_KEY, profile.historyId);
            } catch { /* ignore */ }
            return [];
          }
          try {
            const profile = await getProfile();
            newHistoryId = profile.historyId;
          } catch {
            return this.classifyMessages(messages);
          }
        } else {
          throw err;
        }
      }
    }

    // Persist the updated history cursor.
    await this.runtime.setCache(HISTORY_ID_KEY, newHistoryId);

    if (messages.length === 0) return [];
    return this.classifyMessages(messages);
  }

  /**
   * Send an email via Gmail REST API.
   * Delegates to gmailClient.sendEmail — exposed here so routes have a single
   * service reference rather than importing the raw client directly.
   */
  async sendEmail(to: string, subject: string, body: string): Promise<string> {
    return gmailSendEmail(to, subject, body);
  }

  /**
   * Returns when the last successful fetch happened (for StatusBar display).
   * null if no fetch has completed yet.
   */
  async getLastFetchInfo(): Promise<{ fetchedAt: string; messageCount: number } | null> {
    const cached = await this.runtime.getCache<GmailCache>(CACHE_KEY);
    if (!cached) return null;
    return {
      fetchedAt: cached.fetchedAt,
      messageCount: cached.messages.length,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /** Full inbox fetch — used for first sync and expired-cursor recovery. */
  private async fullFetch(maxMessages: number): Promise<GmailMessage[]> {
    const result = await listMessages(maxMessages);

    if (result.messages.length > 0) {
      const cache: GmailCache = {
        messages: result.messages,
        path: result.path,
        fetchedAt: new Date().toISOString(),
      };
      await this.runtime.setCache<GmailCache>(CACHE_KEY, cache);
      console.log(`[Pulse:Routes] GmailMcpService fetched ${result.messages.length} messages via ${result.path}.`);
      return result.messages;
    }

    if (result.error) {
      const cached = await this.runtime.getCache<GmailCache>(CACHE_KEY);
      if (cached) {
        return cached.messages;
      }
      console.error(`[Pulse:GmailMcpService] Gmail unavailable (${result.error}) and no cache.`);
    }

    return [];
  }

  /** Classify a list of messages and return only those needing an action item. */
  private async classifyMessages(messages: GmailMessage[]): Promise<ClassifiedEmail[]> {
    const results: ClassifiedEmail[] = [];

    for (const msg of messages) {
      const classification = await classifyEmail(this.runtime, msg);
      if (classification.actionItemType !== null) {
        results.push({ message: msg, classification });
      }
    }

    return results;
  }
}
