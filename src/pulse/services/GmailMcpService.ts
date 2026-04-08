/**
 * src/pulse/services/GmailMcpService.ts
 * ElizaOS Service that wraps gmailClient.ts with two responsibilities:
 *
 *   1. Token refresh heartbeat — calls refreshAccessToken() every 30 minutes
 *      so the OAuth token never expires between processing cycles.
 *
 *   2. Fetch + classify emails — fetches the inbox via gmailClient,
 *      classifies each message via emailClassifier, caches the raw messages
 *      in PGLite (via runtime.setCache), and returns classified results
 *      with a skipped-IDs dedup guard.
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
import { listMessages, refreshAccessToken } from "../lib/gmailClient.js";
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

const CACHE_KEY = "pulse:gmail:last_fetch";
const PROCESSED_IDS_KEY = "pulse:gmail:processed_ids";
const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const MAX_PROCESSED_ID_HISTORY = 200; // keep last 200 processed IDs

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
    console.log("[Pulse:GmailMcpService] Stopped.");
  }

  // ─── Startup ────────────────────────────────────────────────────────────────

  private async onStart(): Promise<void> {
    // Ensure Pulse tables exist in the runtime's shared PGLite database.
    // runtime.db is the Drizzle-over-PGLite instance registered by plugin-sql.
    // Casting to Db is safe: same underlying class, schema type is erased at runtime.
    try {
      const db = this.runtime.db as unknown as Db;
      await runMigrations(db);
      console.log("[Pulse:GmailMcpService] DB migrations verified.");
    } catch (err) {
      // Non-fatal: tables might already exist from a prior standalone run.
      console.warn(
        "[Pulse:GmailMcpService] Migration warning:",
        err instanceof Error ? err.message : String(err)
      );
    }

    // Kick off an initial token refresh (fire-and-forget — no env vars → silent fail).
    void refreshAccessToken().catch(() => {
      /* no-op: env vars not set in dev */
    });

    // Heartbeat: keep the access token alive.
    this.refreshInterval = setInterval(() => {
      void refreshAccessToken().catch((err) => {
        console.warn(
          "[Pulse:GmailMcpService] Token refresh heartbeat failed:",
          err instanceof Error ? err.message : String(err)
        );
      });
    }, TOKEN_REFRESH_INTERVAL_MS);

    console.log(
      "[Pulse:GmailMcpService] Started — token refresh every 30 min."
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetch inbox, classify each message, cache raw messages, return only
   * new (not-yet-processed) messages with a non-null actionItemType.
   *
   * Falls back to cached messages if the network call fails.
   */
  async fetchAndClassify(maxMessages = 20): Promise<ClassifiedEmail[]> {
    const messages = await this.getMessages(maxMessages);
    if (messages.length === 0) return [];

    // Load the set of already-processed Gmail message IDs.
    const processedIds = await this.getProcessedIds();

    const results: ClassifiedEmail[] = [];
    const newlyProcessedIds: string[] = [];

    for (const msg of messages) {
      // Skip messages already in the queue to prevent duplicates on re-runs.
      if (processedIds.has(msg.id)) continue;

      const classification = await classifyEmail(this.runtime, msg);

      // Only return messages that need an action item (skip noise/commitment).
      if (classification.actionItemType !== null) {
        results.push({ message: msg, classification });
      }

      // Mark as processed regardless of category — even noise shouldn't re-appear.
      newlyProcessedIds.push(msg.id);
    }

    // Persist updated processed IDs set.
    if (newlyProcessedIds.length > 0) {
      await this.appendProcessedIds(processedIds, newlyProcessedIds);
    }

    return results;
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

  /** Fetch from Gmail or fall back to the PGLite cache. */
  private async getMessages(maxMessages: number): Promise<GmailMessage[]> {
    const result = await listMessages(maxMessages);

    if (result.messages.length > 0) {
      // Cache fresh messages for offline fallback.
      const cache: GmailCache = {
        messages: result.messages,
        path: result.path,
        fetchedAt: new Date().toISOString(),
      };
      await this.runtime.setCache<GmailCache>(CACHE_KEY, cache);
      console.log(
        `[Pulse:GmailMcpService] Fetched ${result.messages.length} messages via ${result.path}.`
      );
      return result.messages;
    }

    if (result.error) {
      console.warn(
        `[Pulse:GmailMcpService] Gmail unavailable (${result.error}). Trying cache…`
      );
      const cached = await this.runtime.getCache<GmailCache>(CACHE_KEY);
      if (cached) {
        console.log(
          `[Pulse:GmailMcpService] Using cached messages from ${cached.fetchedAt}.`
        );
        return cached.messages;
      }
      console.warn("[Pulse:GmailMcpService] No cache available — returning empty.");
    }

    return [];
  }

  /** Load the set of already-processed Gmail message IDs from cache. */
  private async getProcessedIds(): Promise<Set<string>> {
    const ids = await this.runtime.getCache<string[]>(PROCESSED_IDS_KEY);
    return new Set(ids ?? []);
  }

  /** Append newly processed IDs to the persisted set, capped at MAX history. */
  private async appendProcessedIds(
    existing: Set<string>,
    toAdd: string[]
  ): Promise<void> {
    const merged = [...existing, ...toAdd];
    // Keep only the most recent MAX_PROCESSED_ID_HISTORY IDs to bound storage.
    const capped = merged.slice(-MAX_PROCESSED_ID_HISTORY);
    await this.runtime.setCache<string[]>(PROCESSED_IDS_KEY, capped);
  }
}
