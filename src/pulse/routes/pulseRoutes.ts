/**
 * src/pulse/routes/pulseRoutes.ts
 * HTTP routes that expose the Pulse approval queue to the frontend.
 *
 * Registered in pulsePlugin.routes — ElizaOS mounts these on the same
 * Express server at port 3000.
 *
 * IMPORTANT — path registration:
 *   ElizaOS auto-prefixes every route with "/{plugin.name}/". Because our
 *   plugin is named "pulse", a path of "/queue" is stored as "/pulse/queue".
 *   Define paths WITHOUT the plugin-name prefix or they double-up.
 *
 * Actual URLs after registration:
 *   GET  localhost:3000/pulse/dashboard          ← React SPA entry point
 *   GET  localhost:3000/pulse/dashboard/assets/* ← Vite-built static assets
 *   GET  localhost:3000/pulse/queue
 *   POST localhost:3000/pulse/approve/:id
 *   POST localhost:3000/pulse/reject/:id
 *   GET  localhost:3000/pulse/decisions
 *   GET  localhost:3000/pulse/status
 *
 * Also accessible via the agent-scoped prefix:
 *   GET  localhost:3000/api/agents/{agentId}/plugins/pulse/queue
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryType, ModelType, type Route, type RouteRequest, type RouteResponse, type IAgentRuntime } from "@elizaos/core";
import { PDFParse } from "pdf-parse";
import { getMetrics } from "../lib/nosanaMetrics.js";
import { saveRefreshToken, isGoogleAuthConfigured } from "../lib/authStore.js";
import {
  getQueue,
  getActionItem,
  setActionItemStatus,
  insertDecision,
  insertActionItem,
  insertCommitment,
  getDecisions,
  countAllStatuses,
  countDecisions,
  getDecisionPatterns,
  getCommitmentStats,
  getWeeklyDecisions,
} from "../db/queries.js";
import {
  extractCommitments,
  hasCommitmentPattern,
  computeRemindAt,
} from "../lib/commitmentParser.js";
import type { Db } from "../db/schema.js";
import type { ActionItem } from "../types.js";
import { GmailMcpService } from "../services/GmailMcpService.js";
import { CalendarMcpService } from "../services/CalendarMcpService.js";
import { PulseBackgroundService } from "../services/PulseBackgroundService.js";
import { MorningBriefingService } from "../services/MorningBriefingService.js";
import { updateEvent, listEvents, deleteEvent } from "../lib/calendarClient.js";
import { useModelWithFallback } from "../lib/llmFallback.js";
import {
  isValidEmail,
  sanitizeForPrompt,
  recordSentDraft as _recordSentDraft,
  type SentDraftEntry,
} from "../lib/routeHelpers.js";
import {
  setUserTimezone,
  getUserTimezone,
  localYMD,
  localDayOfWeek,
} from "../lib/userTimezone.js";

// ─── Timezone detection ───────────────────────────────────────────────────────

/**
 * Extract X-Timezone header from an incoming request and update the stored
 * user timezone so LLM date context and background services use the correct tz.
 */
function applyTimezoneHeader(req: RouteRequest): void {
  const raw = req.headers?.["x-timezone"] ?? req.headers?.["X-Timezone"];
  const tz = Array.isArray(raw) ? raw[0] : raw;
  if (tz) setUserTimezone(tz);
}

// ─── Shared calendar helpers ──────────────────────────────────────────────────

/**
 * True if [startA, endA) and [startB, endB) overlap.
 * Accepts any ISO 8601 string — uses Date.getTime() so timezone offsets
 * are handled correctly (e.g. "T11:00:00+02:00" vs "T09:00:00Z" are equal).
 */
function eventsOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  const sA = new Date(startA).getTime();
  const eA = new Date(endA).getTime();
  const sB = new Date(startB).getTime();
  const eB = new Date(endB).getTime();
  return sA < eB && eA > sB;
}

/**
 * Pre-built date/time context string for LLM prompts.
 * Provides today's date, weekday lookup, and common relative-time values so
 * small models never have to do calendar arithmetic themselves.
 * Uses the user's detected timezone (from X-Timezone header) so dates are
 * correct when the server runs in a different timezone than the user.
 */
function buildLlmDateContext(now: Date = new Date()): string {
  const DAY      = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const todayIdx = localDayOfWeek(now);

  // Build next-occurrence dates in user's timezone using UTC-safe arithmetic.
  // We use the user's local YMD to construct a noon-UTC anchor for each target day.
  const tz = getUserTimezone();
  const todayYmd = localYMD(now, tz);
  const [ty, tm, td] = todayYmd.split("-").map(Number);

  const nextDay = (target: number): string => {
    let delta = target - todayIdx;
    if (delta <= 0) delta += 7;
    const d = new Date(Date.UTC(ty, tm - 1, td + delta, 12));
    return localYMD(d, tz);
  };

  const tomorrowYmd = localYMD(new Date(Date.UTC(ty, tm - 1, td + 1, 12)), tz);

  return [
    `=== DATE/TIME REFERENCE (use these exact values — do NOT compute yourself) ===`,
    `today    = ${todayYmd}  (${DAY[todayIdx]})`,
    `tomorrow = ${tomorrowYmd}`,
    `--- Next occurrence of each weekday ---`,
    ...DAY.map((name, i) => `${name.padEnd(12)} = ${nextDay(i)}`),
    `--- Time-of-day defaults ---`,
    `morning = 09:00  noon/lunch = 12:00  afternoon = 14:00  evening = 18:00`,
    `=== END REFERENCE ===`,
  ].join("\n");
}

/**
 * Scan a just-sent email body for commitment language.
 * If found, persist each commitment and queue a slib_reminder action item.
 * Fire-and-forget — never throws, never blocks the send response.
 */
function scanSentEmailForCommitments(
  runtime: IAgentRuntime,
  db: Db,
  subject: string,
  body: string
): void {
  if (!hasCommitmentPattern(body)) return;

  void (async () => {
    try {
      const commitments = await extractCommitments(runtime, body);
      for (const c of commitments) {
        const saved = await insertCommitment(db, {
          sourceMessageId: `sent:${subject}`,
          text:            c.text,
          recipient:       c.recipient,
          deadline:        c.deadline,
          remindAt:        c.remindAt,
        });

        // Queue a slib_reminder immediately so it surfaces in the dashboard.
        const title = c.recipient
          ? `Commitment to ${c.recipient}: due ${c.deadline}`
          : `Commitment due ${c.deadline}`;

        const deadlineDate = new Date(c.deadline + "T12:00:00");
        const formatted = deadlineDate.toLocaleDateString("en-US", {
          weekday: "long", month: "long", day: "numeric", year: "numeric",
        });
        const recipientLine = c.recipient
          ? `You told **${c.recipient}** you would:`
          : "You committed to:";

        const itemBody =
          `${recipientLine}\n\n` +
          `> "${c.text}"\n\n` +
          `**Deadline:** ${formatted}\n\n` +
          `Approve to confirm this commitment is on track, or Reject to dismiss it.`;

        const actionItem = await insertActionItem(db, {
          type:     "slib_reminder",
          title,
          body:     itemBody,
          metadata: {
            commitmentId: saved.id,
            deadline:     c.deadline,
            recipient:    c.recipient,
            verbatim:     c.text,
            source:       `sent:${subject}`,
          },
          priority: 2,
        });

        // Mark commitment reminder as sent so the background cycle won't duplicate it.
        const { markReminderSent } = await import("../db/queries.js");
        await markReminderSent(db, saved.id, actionItem.id);

        console.log(`[Pulse:SlibGuard] Commitment detected in sent email "${subject}": "${c.text}" → ${c.deadline}`);
      }
    } catch (err) {
      console.warn("[Pulse:SlibGuard] Error scanning sent email for commitments:", err instanceof Error ? err.message : String(err));
    }
  })();
}

/** Display name used in outgoing email signatures. Configurable via env. */
const USER_DISPLAY_NAME =
  process.env.USER_NAME?.trim() ||
  process.env.USER_DISPLAY_NAME?.trim() ||
  "Pulse User";

// ─── In-memory document store ────────────────────────────────────────────────
// Uploaded PDFs are stored for the lifetime of the server process.
// docId → { filename, text (first 8000 chars), pageCount, summary }
interface DocEntry { filename: string; text: string; pageCount: number; summary: string; base64?: string }
const docStore = new Map<string, DocEntry>();

// ─── Sent-draft style memory ──────────────────────────────────────────────────
// Stores the last STYLE_MEMORY_MAX emails the user actually sent so that
// /draft-assist can inject them as style examples — teaching the agent
// to write drafts that sound like the user over time.
// Persisted to PGLite (pulse_sent_drafts singleton row) so memory survives
// process restarts — loaded lazily on first /draft-assist request.

const sentDraftMemory: SentDraftEntry[] = [];
let sentDraftsLoadedFromDb = false;

/** Load sentDraftMemory from PGLite on first use (lazy, runs once). */
async function ensureSentDraftsLoaded(db: Db): Promise<void> {
  if (sentDraftsLoadedFromDb) return;
  sentDraftsLoadedFromDb = true; // set early to prevent concurrent loads
  try {
    const { sql } = await import("drizzle-orm");
    const rows = await db.execute(
      sql`SELECT drafts_json FROM pulse_sent_drafts WHERE id = 'singleton'`
    );
    const row = rows.rows[0] as { drafts_json?: string } | undefined;
    if (row?.drafts_json) {
      const loaded = JSON.parse(row.drafts_json) as SentDraftEntry[];
      if (Array.isArray(loaded) && loaded.length > 0) {
        sentDraftMemory.push(...loaded);
      }
    }
  } catch {
    // Non-fatal: DB may not have the table yet (pre-v2 installs) — proceed with empty memory.
  }
}

/** Persist current sentDraftMemory to PGLite (fire-and-forget). */
function persistSentDrafts(db: Db): void {
  void (async () => {
    try {
      const { sql } = await import("drizzle-orm");
      const json = JSON.stringify(sentDraftMemory);
      const now  = new Date().toISOString();
      await db.execute(sql`
        INSERT INTO pulse_sent_drafts (id, drafts_json, updated_at)
        VALUES ('singleton', ${json}, ${now})
        ON CONFLICT (id) DO UPDATE SET drafts_json = ${json}, updated_at = ${now}
      `);
    } catch {
      // Non-fatal: persistence failure should never crash the route.
    }
  })();
}

/** Prepend a sent draft to the style-memory buffer and persist to DB. */
function recordSentDraft(subject: string, body: string, db?: Db): void {
  _recordSentDraft(sentDraftMemory, subject, body);
  if (db) persistSentDrafts(db);
}

// ─── Frontend static-file serving ────────────────────────────────────────────

// In Docker the frontend is built to /srv/pulse-frontend/ (outside /app so
// the Nosana volume mount doesn't wipe it).
// Locally Vite writes to dist-frontend/ (project root) — NOT dist/frontend/
// because elizaos dev wipes the TypeScript outDir (dist/) on startup.
const FRONTEND_DIR = existsSync("/srv/pulse-frontend")
  ? "/srv/pulse-frontend"
  : resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist-frontend");

/** Content-Type mapping for files emitted by Vite. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf":  "font/ttf",
  ".eot":  "application/vnd.ms-fontobject",
};

/**
 * Reads a file from the built frontend directory and writes it to the response.
 * Uses `res.setHeader` (available on Express Response) for Content-Type and
 * Cache-Control; falls back gracefully if the underlying object lacks it.
 */
function serveFrontendFile(filePath: string, res: RouteResponse, cached = false): void {
  if (!existsSync(filePath)) {
    err(res, "Not found", 404);
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  // Hashed asset files are immutable; index.html must revalidate on each load.
  const cacheControl = cached
    ? "public, max-age=31536000, immutable"
    : "no-cache, no-store, must-revalidate";

  res.setHeader?.("Content-Type", mime);
  res.setHeader?.("Cache-Control", cacheControl);
  res.status(200).send(readFileSync(filePath));
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function ok(res: RouteResponse, data: unknown): void {
  res.status(200).json(data);
}

function err(res: RouteResponse, message: string, status = 500): void {
  res.status(status).json({ error: message });
}

/**
 * Persist an approval decision to the ElizaOS semantic memory store so the
 * agent can recall past decisions when asked (e.g. "Have you seen emails like
 * this before?"). We use the agent's own ID as the room since this is a
 * system/self log rather than a user conversation.
 *
 * Failures are intentionally non-fatal — a memory write error should never
 * prevent the HTTP response from succeeding.
 */
async function recordDecisionMemory(
  runtime: IAgentRuntime,
  params: {
    decision: "approved" | "rejected";
    actionItemId: string;
    actionItemType: string;
    title: string;
    reason: string | null;
  }
): Promise<void> {
  const { decision, actionItemId, actionItemType, title, reason } = params;
  const text =
    `Decision: ${decision.toUpperCase()} — [${actionItemType}] "${title}"` +
    (reason ? ` | Reason: ${reason}` : "");

  await runtime.createMemory(
    {
      entityId: runtime.agentId,
      agentId:  runtime.agentId,
      roomId:   runtime.agentId, // self-log room — no active conversation context
      content: {
        text,
        source: "pulse-approval-queue",
      },
      metadata: {
        type:           MemoryType.CUSTOM,
        source:         "pulse-approval-queue",
        scope:          "private",
        decision,
        actionItemId,
        actionItemType,
        title,
        reason:         reason ?? undefined,
        decidedAt:      new Date().toISOString(),
      },
    },
    "messages",
    false // non-unique: multiple decisions on different items can share similar text
  ).catch((e: unknown) => {
    console.warn(
      `[Pulse:Routes] Failed to persist decision memory for item ${actionItemId}:`,
      e instanceof Error ? e.message : String(e)
    );
  });
}

// ─── Email Draft Builders ─────────────────────────────────────────────────────

/**
 * Extract a named field from the item body written by buildReplyDraft().
 * Looks for "**FieldName:** value" or "FieldName: value" patterns.
 */
function extractField(body: string, fieldName: string): string | null {
  const re = new RegExp(`\\*{0,2}${fieldName}:\\*{0,2}\\s*(.+)`, "i");
  const m = body.match(re);
  return m?.[1]?.trim() ?? null;
}

/**
 * Build a reply scaffold for a conflict_resolution item that was just approved.
 * Creates a follow-up email to notify the other party of the resolution.
 */
function buildConflictResolutionDraft(item: ActionItem): string {
  const subject = extractField(item.body, "Subject") ?? item.title;
  return (
    `**From:** ${(item.metadata?.from as string | undefined) ?? ""}\n` +
    `**Subject:** Re: ${subject}\n\n` +
    `---\n\n` +
    `**Suggested reply scaffold:**\n\n` +
    `Hi,\n\n` +
    `I wanted to follow up on the scheduling conflict regarding "${subject}". ` +
    `I've reviewed the calendar and would like to propose a resolution:\n\n` +
    `[Describe your proposed resolution here]\n\n` +
    `Please let me know if this works for you.\n\n` +
    `Best,\n${USER_DISPLAY_NAME}\n\n` +
    `---\n\n` +
    `**Approve** to mark this as handled.\n` +
    `**Reject** to dismiss it from your queue.`
  );
}

/**
 * Build a follow-up email draft for a slib_reminder item that was just approved.
 * The approval indicates the commitment has been handled — draft notifies the recipient.
 */
function buildCommitmentFollowUpDraft(item: ActionItem): string {
  const from = (item.metadata?.from as string | undefined) ?? "";
  return (
    `**From:** ${from}\n` +
    `**Subject:** Follow-up: ${item.title}\n\n` +
    `---\n\n` +
    `**Suggested reply scaffold:**\n\n` +
    `Hi,\n\n` +
    `I wanted to follow up on my commitment: "${item.title}".\n\n` +
    `[Add your update here]\n\n` +
    `Best,\n${USER_DISPLAY_NAME}\n\n` +
    `---\n\n` +
    `**Approve** to mark this as handled.\n` +
    `**Reject** to dismiss it from your queue.`
  );
}

// ─── Routes ──────────────────────────────────────────────────────────────────
// Paths here are SUFFIXES only — ElizaOS prepends "/pulse/" automatically.

export const pulseRoutes: Route[] = [
  // ── GET /pulse/dashboard ─────────────────────────────────────────────────
  // Entry point for the React SPA.  The frontend is built with
  //   base: '/pulse/dashboard/'
  // so all asset <script>/<link> tags emit absolute URLs under that prefix.
  {
    type: "GET",
    path: "/dashboard",
    public: true,
    name: "Pulse Dashboard",
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const indexPath = join(FRONTEND_DIR, "index.html");
      if (!existsSync(indexPath)) {
        // Frontend has not been built yet — return a helpful error instead of a blank 404.
        res.status(503).send(
          "<!doctype html><html><body><h1>Dashboard not built</h1>" +
          "<p>Run <code>cd frontend &amp;&amp; pnpm build</code> then restart the agent.</p>" +
          "</body></html>"
        );
        return;
      }
      serveFrontendFile(indexPath, res, false);
    },
  },

  // ── GET /pulse/dashboard/assets/:file ────────────────────────────────────
  // Vite emits all JS, CSS, and other assets into dist/frontend/assets/ with
  // content-hashed filenames, so they can be cached indefinitely.
  // :file must be a single path segment (no slashes) — path-traversal safe.
  {
    type: "GET",
    path: "/dashboard/assets/:file",
    public: true,
    name: "Pulse Frontend Assets",
    handler: async (req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const file = req.params?.file;
      // Reject anything that could escape the assets directory.
      if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
        err(res, "Invalid asset path", 400);
        return;
      }
      serveFrontendFile(join(FRONTEND_DIR, "assets", file), res, true);
    },
  },

  // ── GET /pulse/queue ──────────────────────────────────────────────────────
  {
    type: "GET",
    path: "/queue",
    public: true,
    name: "Pulse Queue",
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const db = runtime.db as unknown as Db;
        const items = await getQueue(db);
        ok(res, { items, count: items.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] GET /pulse/queue: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/approve/:id ───────────────────────────────────────────────
  {
    type: "POST",
    path: "/approve/:id",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const db = runtime.db as unknown as Db;
        const id = req.params?.id;
        if (!id) { err(res, "Missing item id", 400); return; }

        const item = await getActionItem(db, id);
        if (!item) { err(res, "Item not found", 404); return; }
        if (item.status !== "pending") {
          err(res, `Item already ${item.status}`, 409); return;
        }

        const body = req.body as { reason?: string } | undefined;
        const reason = body?.reason ?? null;

        await setActionItemStatus(db, id, "approved");
        await insertDecision(db, { actionItemId: id, decision: "approved", reason });

        // Persist to ElizaOS semantic memory so the agent can recall this later.
        void recordDecisionMemory(runtime, {
          decision:       "approved",
          actionItemId:   id,
          actionItemType: item.type,
          title:          item.title,
          reason,
        });

        // Feature 4: conflict_resolution approval → follow-up email draft
        let draftCreated = false;
        let draftRecipient: string | null = null;

        if (item.type === "conflict_resolution") {
          const meta = item.metadata as Record<string, unknown> | null;
          const from = meta?.from as string | undefined;
          if (from) {
            console.log(`[Pulse:Routes] Auto-creating email draft after conflict approval for item ${id}`);
            try {
              await insertActionItem(db, {
                type:     "email_draft",
                title:    `Re: ${item.title}`,
                body:     buildConflictResolutionDraft(item),
                metadata: { from, sourceConflictId: id, sourceConflictTitle: item.title },
                priority: 2,
              });
              draftCreated = true;
              draftRecipient = from;
            } catch (draftErr) {
              console.error(
                `[Pulse:Routes] Failed to create conflict follow-up draft for ${id}:`,
                draftErr instanceof Error ? draftErr.message : String(draftErr)
              );
            }
          }
        }

        // Feature 5: slib_reminder approval → commitment follow-up email draft
        if (item.type === "slib_reminder") {
          const meta = item.metadata as Record<string, unknown> | null;
          const from = meta?.from as string | undefined;
          if (from) {
            try {
              await insertActionItem(db, {
                type:     "email_draft",
                title:    `Follow-up: ${item.title}`,
                body:     buildCommitmentFollowUpDraft(item),
                metadata: { from },
                priority: 3,
              });
              draftCreated = true;
              draftRecipient = from;
            } catch (draftErr) {
              console.error(
                `[Pulse:Routes] Failed to create commitment follow-up draft for ${id}:`,
                draftErr instanceof Error ? draftErr.message : String(draftErr)
              );
            }
          }
        }

        console.log(`[Pulse:Routes] Approved item ${id}${draftCreated ? " (draft email queued)" : ""}`);
        ok(res, { success: true, id, status: "approved", draftCreated, draftRecipient });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/approve: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/reject/:id ────────────────────────────────────────────────
  {
    type: "POST",
    path: "/reject/:id",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const db = runtime.db as unknown as Db;
        const id = req.params?.id;
        if (!id) { err(res, "Missing item id", 400); return; }

        const item = await getActionItem(db, id);
        if (!item) { err(res, "Item not found", 404); return; }
        if (item.status !== "pending") {
          err(res, `Item already ${item.status}`, 409); return;
        }

        const body = req.body as { reason?: string } | undefined;
        const reason = body?.reason ?? null;

        await setActionItemStatus(db, id, "rejected");
        await insertDecision(db, { actionItemId: id, decision: "rejected", reason });

        // Persist to ElizaOS semantic memory so the agent can recall this later.
        void recordDecisionMemory(runtime, {
          decision:       "rejected",
          actionItemId:   id,
          actionItemType: item.type,
          title:          item.title,
          reason,
        });

        console.log(`[Pulse:Routes] Rejected item ${id}`);
        ok(res, { success: true, id, status: "rejected" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/reject: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── GET /pulse/decisions ──────────────────────────────────────────────────
  {
    type: "GET",
    path: "/decisions",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const db = runtime.db as unknown as Db;
        const limitParam = req.query?.limit;
        const parsed = parseInt(String(limitParam ?? ""), 10);
        const limit  = limitParam ? Math.min(Number.isNaN(parsed) ? 20 : parsed, 100) : 20;

        const [decisionList, total, patterns] = await Promise.all([
          getDecisions(db, limit),
          countDecisions(db),
          getDecisionPatterns(db),
        ]);

        ok(res, { decisions: decisionList, total, patterns });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] GET /pulse/decisions: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/summarize-email ───────────────────────────────────────────
  // Lightweight LLM call: summarize an email body in 1-2 sentences.
  // Used by the frontend to show a quick-read chip on email_draft cards.
  {
    type: "POST",
    path: "/summarize-email",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const { subject, from, body } = req.body as {
          subject?: string;
          from?: string;
          body?: string;
        };

        if (!body) { err(res, "body is required", 400); return; }

        const prompt =
          `Summarize this email in 1-2 plain sentences (max 30 words). ` +
          `Focus on what the sender wants or needs. No preamble.\n\n` +
          `From: ${sanitizeForPrompt(from ?? "unknown", 100)}\n` +
          `Subject: ${sanitizeForPrompt(subject ?? "(no subject)", 200)}\n\n` +
          `${sanitizeForPrompt(body, 1200)}`;

        const summary = await useModelWithFallback(runtime, ModelType.TEXT_SMALL, { prompt });
        ok(res, { summary: summary.trim() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err(res, msg);
      }
    },
  },

  // ── GET /pulse/analytics ──────────────────────────────────────────────────
  {
    type: "GET",
    path: "/analytics",
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const db = runtime.db as unknown as Db;
        const [weekly, patterns] = await Promise.all([
          getWeeklyDecisions(db, 7),
          getDecisionPatterns(db),
        ]);
        ok(res, { weekly, patterns });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] GET /pulse/analytics: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── GET /pulse/status ─────────────────────────────────────────────────────
  {
    type: "GET",
    path: "/status",
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const db = runtime.db as unknown as Db;

        const gmailSvc = runtime.getService(
          GmailMcpService.serviceType
        ) as GmailMcpService | null;
        const calSvc = runtime.getService(
          CalendarMcpService.serviceType
        ) as CalendarMcpService | null;

        const [counts, gmailInfo, calInfo, commitmentStats] =
          await Promise.all([
            countAllStatuses(db),
            gmailSvc?.getLastFetchInfo() ??
              Promise.resolve({ fetchedAt: null, messageCount: 0 }),
            calSvc?.getLastFetchInfo() ??
              Promise.resolve({ fetchedAt: null, eventCount: 0 }),
            getCommitmentStats(db),
          ]);

        ok(res, {
          queue: counts,
          gmail: gmailInfo,
          calendar: calInfo,
          agentName: runtime.character?.name ?? "Pulse",
          userDisplayName: USER_DISPLAY_NAME,
          score: computeInboxScore(counts, commitmentStats),
          nosana: getMetrics(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] GET /pulse/status: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/process ───────────────────────────────────────────────────
  // Manually trigger a full Pulse processing cycle: emails, calendar conflicts,
  // and Slib Guard reminders. Called by the "Check for New Emails" button.
  {
    type: "POST",
    path: "/process",
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const bgSvc = runtime.getService(
          PulseBackgroundService.serviceType
        ) as PulseBackgroundService | null;

        if (!bgSvc) {
          err(res, "PulseBackgroundService not available", 503);
          return;
        }

        console.log("[Pulse:Routes] POST /pulse/process — running full processing cycle…");
        const result = await bgSvc.runProcessingCycle();

        // Refresh briefing after cycle so BriefingPanel reflects the new queue state.
        void (runtime.getService(MorningBriefingService.serviceType) as MorningBriefingService | null)
          ?.generateBriefing()
          .catch(() => { /* non-fatal */ });

        ok(res, {
          success: true,
          processed:  result.emails.processed,
          inserted:   result.emails.inserted + result.conflicts.inserted + result.reminders.inserted,
          emails:     result.emails,
          conflicts:  result.conflicts,
          reminders:  result.reminders,
          durationMs: result.durationMs,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/process: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/send-email ────────────────────────────────────────────────
  // Send an edited email draft via Gmail and mark the action item approved.
  // Body: { to: string, subject: string, body: string, itemId: string }
  {
    type: "POST",
    path: "/send-email",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const body = req.body as {
          to?: string;
          subject?: string;
          body?: string;
          itemId?: string;
          /** Optional list of docIds to attach. base64 is resolved from docStore. */
          attachDocIds?: string[];
        } | undefined;

        const to       = body?.to?.trim();
        const subject  = body?.subject?.trim();
        const emailBody = body?.body?.trim();
        const itemId   = body?.itemId?.trim();

        if (!to || !subject || !emailBody || !itemId) {
          err(res, "Missing required fields: to, subject, body, itemId", 400);
          return;
        }
        if (!isValidEmail(to)) {
          err(res, "Invalid recipient email address", 400);
          return;
        }

        const db = runtime.db as unknown as Db;
        const item = await getActionItem(db, itemId);
        if (!item) { err(res, "Item not found", 404); return; }
        if (item.status !== "pending") {
          err(res, `Item already ${item.status}`, 409); return;
        }

        const gmailSvc = runtime.getService(
          GmailMcpService.serviceType
        ) as GmailMcpService | null;

        if (!gmailSvc) {
          err(res, "GmailMcpService not available", 503);
          return;
        }

        // Resolve any PDF attachments from the in-memory doc store.
        const attachments = (body?.attachDocIds ?? [])
          .map((id) => docStore.get(id))
          .filter((d): d is DocEntry & { base64: string } => d !== undefined && d.base64 !== undefined)
          .map((d) => ({ filename: d.filename, base64: d.base64, mimeType: "application/pdf" }));

        const messageId = await gmailSvc.sendEmail(to, subject, emailBody, attachments.length ? attachments : undefined);

        await setActionItemStatus(db, itemId, "approved");
        await insertDecision(db, {
          actionItemId: itemId,
          decision: "approved",
          reason: "Email sent",
        });

        void recordDecisionMemory(runtime, {
          decision:       "approved",
          actionItemId:   itemId,
          actionItemType: item.type,
          title:          item.title,
          reason:         "Email sent",
        });

        recordSentDraft(subject, emailBody, db);
        scanSentEmailForCommitments(runtime, db, subject, emailBody);
        console.log(`[Pulse:Routes] Sent email for item ${itemId}, messageId=${messageId}`);
        ok(res, { success: true, messageId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/send-email: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── GET /pulse/briefing ───────────────────────────────────────────────────
  // Returns the cached morning briefing data (pending items, calendar, commitments).
  // null body when the briefing hasn't fired yet (< 5s after startup).
  {
    type: "GET",
    path: "/briefing",
    public: true,
    name: "Pulse Briefing",
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      ok(res, { briefing: MorningBriefingService.lastBriefingData });
    },
  },

  // ── POST /pulse/weather ──────────────────────────────────────────────────
  // Fetches a real weather forecast from wttr.in so the frontend never has to
  // rely on the LLM hallucinating weather data. Extracts city name with regex
  // (defaults to "Prague" for the demo). Returns a formatted multi-day forecast.
  {
    type: "POST" as const,
    path: "/weather",
    handler: async (req: RouteRequest, res: RouteResponse) => {
      try {
        const { message } = (req.body as { message?: string }) ?? {};

        // Extract city from the message — e.g. "weather in Prague this week"
        const cityMatch = (message ?? "").match(
          /\b(?:in|at|for)\s+([A-Z][a-zA-ZÀ-ž\s-]{1,30})(?:\s+this|\s+today|\s+tomorrow|\s+next|[?!.,]|$)/i
        );
        const city = cityMatch?.[1]?.trim() ?? "Prague";

        const wttrUrl = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const wttrRes = await fetch(wttrUrl, {
          headers: { "User-Agent": "Pulse-Agent/1.0 (weather-fetch)" },
          signal: AbortSignal.timeout(8_000),
        });

        if (!wttrRes.ok) {
          err(res, `Weather service returned ${wttrRes.status}`, 502);
          return;
        }

        interface WttrHourly { time: string; tempC: string; weatherDesc: Array<{ value: string }>; chanceofrain: string; }
        interface WttrDay { date: string; maxtempC: string; mintempC: string; hourly: WttrHourly[]; }
        interface WttrResponse { weather: WttrDay[]; }

        const data = (await wttrRes.json()) as WttrResponse;
        const days = data.weather ?? [];

        const lines: string[] = [`**Weather in ${city}**\n`];
        for (const day of days.slice(0, 4)) {
          const date = new Date(day.date).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
          const desc = day.hourly
            .find((h) => parseInt(h.time) >= 900)
            ?.weatherDesc[0]?.value ?? day.hourly[0]?.weatherDesc[0]?.value ?? "—";
          const rain = day.hourly.reduce((max, h) => Math.max(max, parseInt(h.chanceofrain ?? "0")), 0);
          lines.push(`**${date}**: ${desc}, ${day.mintempC}–${day.maxtempC}°C, ${rain}% chance of rain`);
        }

        ok(res, { forecast: lines.join("\n"), city });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/weather: ${msg}`);
        err(res, `Couldn't fetch weather: ${msg}`, 502);
      }
    },
  },

  // ── POST /pulse/log-commitment ───────────────────────────────────────────
  // Saves a commitment typed directly in chat (not from a sent email).
  // Uses the same extractCommitments + insertCommitment + slib_reminder path
  // as the sent-email scanner — so it shows up in the queue immediately.
  {
    type: "POST" as const,
    path: "/log-commitment",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const { text } = (req.body as { text?: string }) ?? {};
        if (!text?.trim()) { err(res, "text required", 400); return; }

        const db = (runtime as unknown as { db: Db }).db as Db;
        if (!db) { err(res, "Database unavailable", 503); return; }

        const commitments = await extractCommitments(runtime, text.trim());
        if (commitments.length === 0) {
          ok(res, { saved: false, deadline: null, reminderText: "No commitment found in that message." });
          return;
        }

        const c = commitments[0];
        const saved = await insertCommitment(db, {
          sourceMessageId: `chat:${Date.now()}`,
          text:            c.text,
          recipient:       c.recipient,
          deadline:        c.deadline,
          remindAt:        c.remindAt,
        });

        const title = c.recipient
          ? `Commitment to ${c.recipient}: due ${c.deadline}`
          : `Commitment due ${c.deadline}`;

        const deadlineDate = new Date(c.deadline + "T12:00:00");
        const formatted = deadlineDate.toLocaleDateString("en-US", {
          weekday: "long", month: "long", day: "numeric", year: "numeric",
        });
        const recipientLine = c.recipient
          ? `You told **${c.recipient}** you would:`
          : "You committed to:";

        const itemBody =
          `${recipientLine}\n\n` +
          `> "${c.text}"\n\n` +
          `**Deadline:** ${formatted}\n\n` +
          `Approve to confirm this commitment is on track, or Reject to dismiss it.`;

        const actionItem = await insertActionItem(db, {
          type:     "slib_reminder",
          title,
          body:     itemBody,
          metadata: {
            commitmentId: saved.id,
            deadline:     c.deadline,
            recipient:    c.recipient,
            verbatim:     c.text,
            source:       "chat",
          },
          priority: 2,
        });

        const { markReminderSent } = await import("../db/queries.js");
        await markReminderSent(db, saved.id, actionItem.id);

        console.log(`[Pulse:SlibGuard] Chat commitment logged — deadline=${c.deadline}, item=${actionItem.id}`);
        ok(res, { saved: true, deadline: c.deadline, reminderText: title });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/log-commitment: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/briefing/refresh ─────────────────────────────────────────
  // Re-generates the morning briefing from current queue/calendar state.
  // Called automatically after every Sync Now cycle.
  {
    type: "POST" as const,
    path: "/briefing/refresh",
    handler: async (_req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const svc = runtime.getService(
          MorningBriefingService.serviceType
        ) as MorningBriefingService | null;
        if (!svc) { err(res, "MorningBriefingService not available", 503); return; }
        await svc.generateBriefing();
        ok(res, { briefing: MorningBriefingService.lastBriefingData });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err(res, msg);
      }
    },
  },

  // ── GET /pulse/calendar-context ───────────────────────────────────────────
  // Returns a plain-text summary of calendar events for the next 7 days.
  // Used by ChatDrawer to inject real event data before sending calendar
  // questions to the ElizaOS agent, preventing hallucinated responses.
  {
    type: "GET",
    path: "/calendar-context",
    public: true,
    name: "Pulse Calendar Context",
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      try {
        const result = await listEvents(7);

        if (result.error || result.events.length === 0) {
          ok(res, { context: "No calendar events found for the next 7 days.", events: [] });
          return;
        }

        // Format events as a compact human-readable block for LLM context injection.
        const now = new Date();
        const lines: string[] = [`Your calendar — next 7 days (as of ${now.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}):`, ""];

        // Group by date
        const byDay = new Map<string, typeof result.events>();
        for (const ev of result.events) {
          const day = ev.start.slice(0, 10);
          if (!byDay.has(day)) byDay.set(day, []);
          byDay.get(day)!.push(ev);
        }

        for (const [day, events] of byDay) {
          const label = new Date(day + "T12:00:00").toLocaleDateString("en-US", {
            weekday: "short", month: "short", day: "numeric",
          });
          lines.push(`${label}:`);
          for (const ev of events) {
            const time = ev.allDay
              ? "all-day"
              : `${ev.start.slice(11, 16)}–${ev.end.slice(11, 16)}`;
            const who = ev.attendees.length > 0
              ? ` [${ev.attendees.slice(0, 3).join(", ")}${ev.attendees.length > 3 ? ` +${ev.attendees.length - 3}` : ""}]`
              : "";
            lines.push(`  • ${time} — ${ev.title}${who}`);
          }
          lines.push("");
        }

        ok(res, { context: lines.join("\n"), events: result.events });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] GET /pulse/calendar-context: ${msg}`);
        ok(res, { context: "Calendar unavailable — Google Calendar not connected.", events: [] });
      }
    },
  },

  // ── POST /pulse/dismiss/:id ───────────────────────────────────────────────
  // Skip an email_draft without rejecting it as "bad". Records decision as
  // rejected with reason "skipped" — semantically: "I'll handle this elsewhere."
  {
    type: "POST",
    path: "/dismiss/:id",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const db = runtime.db as unknown as Db;
        const id = req.params?.id;
        if (!id) { err(res, "Missing item id", 400); return; }

        const item = await getActionItem(db, id);
        if (!item) { err(res, "Item not found", 404); return; }
        if (item.status !== "pending") {
          err(res, `Item already ${item.status}`, 409); return;
        }

        await setActionItemStatus(db, id, "rejected");
        await insertDecision(db, { actionItemId: id, decision: "rejected", reason: "skipped" });
        void recordDecisionMemory(runtime, {
          decision:       "rejected",
          actionItemId:   id,
          actionItemType: item.type,
          title:          item.title,
          reason:         "skipped",
        });

        console.log(`[Pulse:Routes] Dismissed item ${id}`);
        ok(res, { success: true, id, status: "rejected" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/dismiss: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/draft-assist ──────────────────────────────────────────────
  // Calls the LLM directly — bypassing all ElizaOS providers — with a focused
  // email-editor system prompt. Prevents queue/calendar provider context from
  // leaking into draft rewrites and causing the model to respond to other tasks.
  {
    type: "POST" as const,
    path: "/draft-assist",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const {
          subject = "",
          to = "",
          currentBody = "",
          instruction = "",
          originalFrom = "",
          originalSnippet = "",
        } = (req.body as {
          subject?: string;
          to?: string;
          currentBody?: string;
          instruction?: string;
          originalFrom?: string;
          originalSnippet?: string;
        }) ?? {};

        if (!instruction.trim()) {
          err(res, "instruction is required", 400);
          return;
        }

        // Load persisted draft memory from DB on first request (lazy, once per process).
        const db = runtime.db as unknown as Db;
        await ensureSentDraftsLoaded(db);

        // Build a self-contained prompt that instructs the model to act as a
        // focused email editor. All context is in the user message so the
        // character's system prompt does not pollute it with queue/calendar state.
        // Inject up to 2 of the user's recently sent emails as style examples so
        // the model learns to match their tone and writing style over time.
        const styleExamples = sentDraftMemory.slice(0, 2);
        const styleBlock = styleExamples.length > 0
          ? [
              "WRITING STYLE — match the tone, length, and phrasing of these emails the user has sent:",
              ...styleExamples.map((e, i) =>
                `Example ${i + 1} (subject: "${e.subject}"):\n${e.body.slice(0, 300)}${e.body.length > 300 ? "…" : ""}`
              ),
              "",
            ]
          : [];

        const prompt = [
          "You are acting as a focused email writing assistant. Your only task is to",
          "edit the email draft below according to the user's instruction.",
          "",
          ...styleBlock,
          "STRICT RULES:",
          "- Ignore any pending action items, queue entries, or calendar events in your context.",
          "- Never invent meeting times, dates, deadlines, or commitments not present in the original email.",
          "- Wrap the complete rewritten email body between --- separators on their own lines.",
          "- Do not add commentary, explanations, or text outside the --- separators.",
          "- If the user asks to add something to their calendar or schedule a meeting, include",
          "  ONLY the single line [CALENDAR_INTENT] at the very end of your response (after the",
          "  closing ---). Never say 'Meeting added', 'Calendar updated', or pretend to create",
          "  events — you cannot do that. Just mark it and update the email text as requested.",
          "",
          `Email context:`,
          `To: ${sanitizeForPrompt(to || "(unknown)", 200)}`,
          `Subject: ${sanitizeForPrompt(subject || "(no subject)", 200)}`,
          originalFrom ? `From: ${sanitizeForPrompt(originalFrom, 200)}` : "",
          originalSnippet ? `Original message:\n${sanitizeForPrompt(originalSnippet, 400)}` : "",
          "",
          "Current draft:",
          currentBody || "(empty)",
          "",
          "---",
          "",
          `User instruction: ${instruction}`,
          "",
          "Rewrite the draft and wrap it in --- separators.",
        ]
          .filter((l) => l !== null)
          .join("\n");

        const TIMEOUT_MS = 90_000;
        const raw = await Promise.race([
          useModelWithFallback(runtime, ModelType.TEXT_SMALL, {
            prompt,
            maxTokens: 1024,
            temperature: 0.4,
          }) as Promise<string>,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("LLM timeout after 90s")), TIMEOUT_MS)
          ),
        ]);

        ok(res, { reply: (raw as string).trim() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/draft-assist: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/classify-intent ──────────────────────────────────────────
  // Lightweight intent classifier. Returns structured JSON so the frontend can
  // route to the right handler without regex. Bypasses ElizaOS sessions entirely.
  // Intents: "doc_email" | "general"
  {
    type: "POST" as const,
    path: "/classify-intent",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const {
          message = "",
          hasDoc = false,
          docFilename = "",
        } = (req.body as { message?: string; hasDoc?: boolean; docFilename?: string }) ?? {};

        if (!message.trim()) {
          ok(res, { intent: "general", params: {} });
          return;
        }

        const docContext = hasDoc
          ? `The user has a document attached: "${docFilename}".`
          : "No document is attached.";

        const prompt = [
          "You are an intent classifier. Reply with a single line of JSON only — no markdown, no explanation.",
          "",
          docContext,
          `User message: "${message.slice(0, 300)}"`,
          "",
          "Classify the intent into exactly one of these:",
          '- "doc_email": user wants to email the document (or its summary/content) to someone.',
          '  If an email address is present, include it as "to". Otherwise "to" is null.',
          '- "general": anything else (questions, commands, greetings, etc).',
          "",
          'Reply format (one line, valid JSON):',
          '{"intent":"doc_email","to":"someone@example.com"}',
          'or {"intent":"doc_email","to":null}',
          'or {"intent":"general"}',
        ].join("\n");

        const raw = await Promise.race([
          useModelWithFallback(runtime, ModelType.TEXT_SMALL, {
            prompt,
            maxTokens: 40,
            temperature: 0,
          }) as Promise<string>,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("classifier timeout")), 15_000)
          ),
        ]);

        // Extract JSON from the response — model may add extra whitespace or quotes
        const jsonMatch = (raw as string).match(/\{[^}]+\}/);
        if (!jsonMatch) {
          ok(res, { intent: "general", params: {} });
          return;
        }

        let parsed: { intent?: string; to?: string | null };
        try {
          parsed = JSON.parse(jsonMatch[0]) as { intent?: string; to?: string | null };
        } catch {
          ok(res, { intent: "general", params: {} });
          return;
        }

        const intent = parsed.intent === "doc_email" ? "doc_email" : "general";
        const params: { to?: string } = {};
        if (intent === "doc_email" && parsed.to) params.to = parsed.to;

        ok(res, { intent, params });
      } catch (e) {
        // On any error, fall back to general so the chat still works
        console.error(`[Pulse:Routes] POST /pulse/classify-intent: ${e instanceof Error ? e.message : e}`);
        ok(res, { intent: "general", params: {} });
      }
    },
  },

  // ── POST /pulse/create-calendar-event ────────────────────────────────────
  // Directly creates a Google Calendar event from a natural-language message.
  // Bypasses ElizaOS action selection (which is unreliable for tool invocation)
  // by calling the LLM for extraction and the Calendar REST API directly.
  {
    type: "POST" as const,
    path: "/create-calendar-event",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      applyTimezoneHeader(req);
      try {
        const { message } = (req.body as { message?: string }) ?? {};
        if (!message?.trim()) { err(res, "message is required", 400); return; }

        const calSvc = runtime.getService(
          CalendarMcpService.serviceType
        ) as CalendarMcpService | null;
        if (!calSvc) { err(res, "CalendarMcpService not available", 503); return; }

        const extractPrompt =
          `${buildLlmDateContext()}\n\n` +
          `Extract calendar event details from the user message and return ONLY a JSON object:\n` +
          `{"title":"...","date":"YYYY-MM-DD","startTime":"HH:MM","durationMinutes":60,"timeZone":null}\n\n` +
          `User message: "${message}"\n\n` +
          `Rules:\n` +
          `- Use EXACT dates from the reference table above — never compute day names yourself.\n` +
          `- timeZone: IANA string only if explicitly mentioned, otherwise null.\n` +
          `- Return ONLY raw JSON, no markdown fences, no extra text.`;

        const raw = await Promise.race([
          useModelWithFallback(runtime, ModelType.TEXT_SMALL, {
            prompt: extractPrompt,
            maxTokens: 256,
            temperature: 0.1,
          }) as Promise<string>,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("LLM timeout after 30s")), 30_000)
          ),
        ]);

        const cleaned = (raw as string)
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```\s*$/, "")
          .trim();

        let details: {
          title: string;
          date: string;
          startTime: string;
          durationMinutes?: number;
          timeZone?: string | null;
        };
        try {
          details = JSON.parse(cleaned) as typeof details;
          if (!details.title || !details.date || !details.startTime) {
            throw new Error("incomplete JSON");
          }
        } catch {
          console.warn("[Pulse:Routes] create-calendar-event: LLM extraction failed:", cleaned.slice(0, 200));
          err(res, "Could not extract event details — try: \"Schedule golf tomorrow at 13:00\"", 422);
          return;
        }

        // Build ISO datetime strings (naive, no UTC conversion)
        const pad = (n: number) => String(n).padStart(2, "0");
        const normalTime = details.startTime.slice(0, 5).padStart(5, "0");
        const startIso   = `${details.date}T${normalTime}:00`;
        const [hhStr, mmStr] = normalTime.split(":");
        const durMins   = details.durationMinutes ?? 60;
        const totalMins = Number(hhStr) * 60 + Number(mmStr) + durMins;
        const endHh     = Math.floor(totalMins / 60) % 24;
        const endMm     = totalMins % 60;
        const endIso    = `${details.date}T${pad(endHh)}:${pad(endMm)}:00`;
        const timeZone  = details.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

        // ── Conflict pre-check ──────────────────────────────────────────────
        // Fetch existing events and block creation if the slot is already taken.
        // Skip check if user explicitly overrides.
        const isForced = /schedule\s+anyway|force\s+it|override|ignore\s+conflict/i.test(message);
        if (!isForced) {
          try {
            const existingEvents = await calSvc.getEvents(14);
            const overlapping = existingEvents.filter((ev) =>
              eventsOverlap(ev.start, ev.end, startIso, endIso)
            );
            if (overlapping.length > 0) {
              const conflictList = overlapping
                .map((ev) => `**${ev.title}** (${ev.start.slice(11, 16)}–${ev.end.slice(11, 16)})`)
                .join(", ");
              err(
                res,
                `You already have ${conflictList} at that time. Event not created. ` +
                `Choose a different time or say "schedule anyway" to override.`,
                409
              );
              return;
            }
          } catch (checkErr) {
            // Non-fatal — if we can't fetch events, proceed with creation.
            console.warn("[Pulse:Routes] Conflict pre-check failed (proceeding):", checkErr instanceof Error ? checkErr.message : String(checkErr));
          }
        }

        console.log(`[Pulse:Routes] Creating calendar event: "${details.title}" ${startIso} tz=${timeZone}`);

        const created = await calSvc.createEvent({
          title:    details.title,
          start:    startIso,
          end:      endIso,
          timeZone,
        });

        const startReadable = new Date(`${details.date}T${normalTime}`).toLocaleString("en-US", {
          weekday: "short", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit",
        });

        ok(res, {
          success: true,
          title:       details.title,
          start:       created.start,
          end:         created.end,
          eventId:     created.id,
          confirmText: `Done! **${details.title}** added to your calendar for ${startReadable}.`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/create-calendar-event: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/find-free-slots ──────────────────────────────────────────
  // Given an ISO date and duration in minutes, returns up to 3 available time
  // slots for that day by scanning existing events for gaps.
  {
    type: "POST" as const,
    path: "/find-free-slots",
    handler: async (req: RouteRequest, res: RouteResponse) => {
      try {
        const { date, durationMinutes = 60, excludeEventIds = [] } =
          (req.body as { date?: string; durationMinutes?: number; excludeEventIds?: string[] }) ?? {};

        if (!date) { err(res, "date required", 400); return; }

        // Fetch a 3-day window centred on the target date so we capture all events.
        const result = await listEvents(3);
        const events = result.events.filter((e) => {
          if (e.allDay) return false;
          if ((excludeEventIds as string[]).includes(e.id)) return false;
          return e.start.startsWith(date);
        });

        // Build busy windows for the day.
        const busy = events.map((e) => ({
          start: new Date(e.start).getTime(),
          end:   new Date(e.end).getTime(),
        })).sort((a, b) => a.start - b.start);

        // Search for free slots between 08:00 and 19:00 local time.
        const dayStart = new Date(`${date}T08:00:00`).getTime();
        const dayEnd   = new Date(`${date}T19:00:00`).getTime();
        const slotMs   = durationMinutes * 60_000;
        const slots: Array<{ start: string; end: string; label: string }> = [];

        let cursor = dayStart;
        while (cursor + slotMs <= dayEnd && slots.length < 3) {
          const slotEnd = cursor + slotMs;
          const blocked = busy.some(
            (b) => cursor < b.end && slotEnd > b.start
          );
          if (!blocked) {
            const fmt = (ms: number) =>
              new Date(ms).toLocaleTimeString("en-US", {
                hour: "numeric", minute: "2-digit", hour12: true,
              });
            slots.push({
              start: new Date(cursor).toISOString(),
              end:   new Date(slotEnd).toISOString(),
              label: `${fmt(cursor)} – ${fmt(slotEnd)}`,
            });
            cursor = slotEnd;
          } else {
            // Jump past the blocking event.
            const blocker = busy.find((b) => cursor < b.end && slotEnd > b.start);
            cursor = blocker ? blocker.end : cursor + slotMs;
          }
        }

        ok(res, { slots });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/find-free-slots: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/reschedule-event ─────────────────────────────────────────
  // Move a Google Calendar event to a new time slot.
  // Approval of the action item is handled separately by the frontend via
  // the normal /approve/:id flow (so the email draft gets created too).
  {
    type: "POST" as const,
    path: "/reschedule-event",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const { eventId, newStart, newEnd, timeZone } =
          (req.body as {
            eventId?: string;
            newStart?: string;
            newEnd?: string;
            timeZone?: string;
          }) ?? {};

        if (!eventId || !newStart || !newEnd) {
          err(res, "eventId, newStart, newEnd required", 400);
          return;
        }

        // Conflict pre-check — ensure target slot is free.
        const calSvc = runtime.getService(CalendarMcpService.serviceType) as CalendarMcpService | null;
        if (calSvc) {
          try {
            const existing = await calSvc.getEvents(14);
            const clashes = existing.filter((ev) => {
              if (ev.id === eventId) return false;
              return eventsOverlap(ev.start, ev.end, newStart, newEnd);
            });
            if (clashes.length > 0) {
              const list = clashes
                .map((ev) => `**${ev.title}** (${new Date(ev.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}–${new Date(ev.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })})`)
                .join(", ");
              err(res, `That slot is already taken by ${list}. Choose a different time.`, 409);
              return;
            }
          } catch {
            // Non-fatal — proceed if check fails.
          }
        }

        const updated = await updateEvent(eventId, {
          start: newStart,
          end:   newEnd,
          timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        });

        const startReadable = new Date(newStart).toLocaleString("en-US", {
          weekday: "short", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit",
        });

        ok(res, {
          success:  true,
          eventId:  updated.id,
          title:    updated.title,
          newStart: updated.start,
          label:    startReadable,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/reschedule-event: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/delete-event ─────────────────────────────────────────────
  {
    type: "POST" as const,
    path: "/delete-event",
    handler: async (req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const { eventId, title } = (req.body ?? {}) as { eventId?: string; title?: string };
      if (!eventId) { err(res, "eventId is required"); return; }
      try {
        await deleteEvent(eventId);
        console.log(`[Pulse:Routes] Deleted calendar event: ${title ?? eventId}`);
        ok(res, { success: true, eventId, title: title ?? eventId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/delete-event: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/suggest-replies ───────────────────────────────────────────
  // Generates 3 short reply suggestions via LLM for a given email context.
  // Falls back to keyword-based suggestions if the LLM fails or times out.
  {
    type: "POST" as const,
    path: "/suggest-replies",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const { subject = "", from = "", bodySnippet = "" } =
          (req.body as { subject?: string; from?: string; bodySnippet?: string }) ?? {};

        const suggestions = await generateReplySuggestions(runtime, subject, from, bodySnippet);
        ok(res, { suggestions });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/suggest-replies: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/resolve-conflict ─────────────────────────────────────────
  // Chat-driven conflict resolution. Given a natural-language message and
  // conflict context, uses LLM to extract intent (which event + target time),
  // then either reschedules immediately or returns free-slot suggestions.
  {
    type: "POST" as const,
    path: "/resolve-conflict",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      applyTimezoneHeader(req);
      try {
        const {
          message,
          eventAId, eventBId,
          eventATitle, eventBTitle,
          eventAStart, eventAEnd,
          eventBStart, eventBEnd,
          date,
        } = (req.body as {
          message?: string;
          eventAId?: string; eventBId?: string;
          eventATitle?: string; eventBTitle?: string;
          eventAStart?: string; eventAEnd?: string;
          eventBStart?: string; eventBEnd?: string;
          date?: string;
        }) ?? {};

        if (!message) { err(res, "message required", 400); return; }

        const hasIds = !!(eventAId && eventBId);

        // Step 1: LLM extracts which event to reschedule, target time, and target date.
        const dateCtx = buildLlmDateContext();
        const extractionPrompt =
          `${dateCtx}\n\n` +
          `You are a scheduling assistant. Extract rescheduling intent from a user message.\n\n` +
          `Context:\n` +
          `  Event A: "${eventATitle ?? "Event A"}" (${eventAStart?.slice(11, 16) ?? "?"}–${eventAEnd?.slice(11, 16) ?? "?"})\n` +
          `  Event B: "${eventBTitle ?? "Event B"}" (${eventBStart?.slice(11, 16) ?? "?"}–${eventBEnd?.slice(11, 16) ?? "?"})\n` +
          `  Conflict date: ${date ?? eventAStart?.slice(0, 10) ?? "unknown"}\n\n` +
          `User message: "${message}"\n\n` +
          `Reply with ONLY valid JSON, no markdown:\n` +
          `{"targetEvent":"A"|"B"|"unknown","targetTime":"HH:MM"|null,"targetDate":"YYYY-MM-DD"|null,"reasoning":"..."}\n` +
          `Rules:\n` +
          `- targetTime: 24h format. Convert "3pm"→"15:00", "2pm"→"14:00", "11am"→"11:00". null if not mentioned.\n` +
          `- targetDate: use the reference table above to resolve day names. null if same day as conflict.\n` +
          `- If user says "reschedule to Thursday", use the thursday date from the table.\n` +
          `- Return ONLY raw JSON, no markdown.`;

        const raw = await useModelWithFallback(runtime, ModelType.TEXT_SMALL, {
          prompt: extractionPrompt,
          maxTokens: 150,
          temperature: 0.1,
        });

        let extracted: { targetEvent: "A" | "B" | "unknown"; targetTime: string | null; targetDate: string | null } = {
          targetEvent: "unknown",
          targetTime: null,
          targetDate: null,
        };
        try {
          const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
          const parsed = JSON.parse(cleaned) as typeof extracted;
          extracted.targetEvent = parsed.targetEvent ?? "unknown";
          extracted.targetTime  = parsed.targetTime ?? null;
          extracted.targetDate  = parsed.targetDate ?? null;
        } catch {
          // Keep defaults — fall through to suggestions.
        }

        // Step 2: Act on extracted intent.
        const chosenId    = extracted.targetEvent === "A" ? eventAId
                          : extracted.targetEvent === "B" ? eventBId
                          : undefined;
        const chosenTitle = extracted.targetEvent === "A" ? (eventATitle ?? "Event A")
                          : extracted.targetEvent === "B" ? (eventBTitle ?? "Event B")
                          : undefined;
        const sourceDurationMs = (() => {
          const start = extracted.targetEvent === "A" ? eventAStart : eventBStart;
          const end   = extracted.targetEvent === "A" ? eventAEnd   : eventBEnd;
          if (!start || !end) return 3_600_000;
          return new Date(end).getTime() - new Date(start).getTime();
        })();
        const durationMinutes = Math.max(15, Math.round(sourceDurationMs / 60_000));

        // If we have a specific time, reschedule immediately.
        if (extracted.targetTime && chosenId && hasIds) {
          // Use LLM-extracted date if provided (e.g. "move to Thursday"), else same day as conflict.
          const targetDate = extracted.targetDate
            ?? date
            ?? eventAStart?.slice(0, 10)
            ?? localYMD();
          const newStart = `${targetDate}T${extracted.targetTime}:00`;

          // Build end time with pure arithmetic — never use toISOString() which converts to UTC.
          const [startH, startM] = extracted.targetTime.split(":").map(Number);
          const endTotalMin = startH * 60 + startM + durationMinutes;
          const endH = Math.floor(endTotalMin / 60) % 24;
          const endM = endTotalMin % 60;
          const newEnd = `${targetDate}T${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00`;

          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

          // Pre-check: make sure the target slot isn't already occupied by another event.
          const calSvcForCheck = runtime.getService(CalendarMcpService.serviceType) as CalendarMcpService | null;
          if (calSvcForCheck) {
            try {
              const allEvents = await calSvcForCheck.getEvents(14);
              const clashes = allEvents.filter((ev) => {
                if (ev.id === chosenId) return false; // ignore the event being moved
                return eventsOverlap(ev.start, ev.end, newStart, newEnd);
              });
              if (clashes.length > 0) {
                const clashList = clashes
                  .map((ev) => `**${ev.title}** (${ev.start.slice(11, 16)}–${ev.end.slice(11, 16)})`)
                  .join(", ");
                ok(res, {
                  action: "suggestions",
                  text:   `⚠ That slot is already taken by ${clashList}. Please choose a different time.`,
                });
                return;
              }
            } catch {
              // Non-fatal — proceed with the move if the check fails.
            }
          }

          const updated = await updateEvent(chosenId, { start: newStart, end: newEnd, timeZone: tz });

          const readable = new Date(newStart).toLocaleString("en-US", {
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
          });

          // Check if the new time still overlaps with the OTHER conflicting event.
          const otherStart = extracted.targetEvent === "A" ? eventBStart : eventAStart;
          const otherEnd   = extracted.targetEvent === "A" ? eventBEnd   : eventAEnd;
          const newStartMs = new Date(newStart).getTime();
          const newEndMs   = new Date(newEnd).getTime();
          const stillConflicts = otherStart && otherEnd
            ? newStartMs < new Date(otherEnd).getTime() && newEndMs > new Date(otherStart).getTime()
            : false;

          const responseText = stillConflicts
            ? `**${updated.title}** moved to **${readable}**, but it still overlaps with the other event. Please choose a different time.`
            : `Done! **${updated.title}** moved to **${readable}**. The conflict is resolved — mark it as resolved to dismiss it from your queue.`;

          ok(res, {
            action:   stillConflicts ? "suggestions" : "rescheduled",
            text:     responseText,
            newStart: updated.start,
            eventId:  updated.id,
          });
          return;
        }

        // If we know which event but no time, suggest free slots.
        const slotsDate = date ?? (eventAStart?.slice(0, 10) ?? localYMD());
        const slotsResult = await listEvents(3);
        const dayEvents = slotsResult.events.filter((e) => {
          if (e.allDay) return false;
          if (eventAId && e.id === eventAId) return false;
          if (eventBId && e.id === eventBId) return false;
          return e.start.startsWith(slotsDate);
        });

        const busy = dayEvents
          .map((e) => ({ start: new Date(e.start).getTime(), end: new Date(e.end).getTime() }))
          .sort((a, b) => a.start - b.start);

        const dayStart = new Date(`${slotsDate}T08:00:00`).getTime();
        const dayEnd   = new Date(`${slotsDate}T19:00:00`).getTime();
        const slotMs   = durationMinutes * 60_000;
        const slots: string[] = [];
        let cursor = dayStart;

        while (cursor + slotMs <= dayEnd && slots.length < 3) {
          const slotEnd = cursor + slotMs;
          const blocked = busy.some((b) => cursor < b.end && slotEnd > b.start);
          if (!blocked) {
            slots.push(new Date(cursor).toLocaleTimeString("en-US", {
              hour: "numeric", minute: "2-digit", hour12: true,
            }));
            cursor = slotEnd;
          } else {
            const blocker = busy.find((b) => cursor < b.end && slotEnd > b.start)!;
            cursor = blocker.end;
          }
        }

        const target = chosenTitle ? `**${chosenTitle}**` : "that event";
        const slotList = slots.length > 0
          ? `Available slots on the same day: ${slots.join(", ")}.`
          : "No free slots found for that day — try a different day.";

        ok(res, {
          action: "suggestions",
          text:   `To reschedule ${target}, just tell me a time — e.g. "move it to 3pm". ${slotList}`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/resolve-conflict: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/reschedule-by-title ──────────────────────────────────────
  // Natural-language reschedule without requiring event IDs up front.
  // Used when the user types "reschedule Meeting X to 3pm" from any context
  // (including while a draft is open). LLM extracts title + target time,
  // we fuzzy-match against the user's upcoming events, then delegate to the
  // same conflict-checked update path used by /reschedule-event.
  {
    type: "POST" as const,
    path: "/reschedule-by-title",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      applyTimezoneHeader(req);
      try {
        const { message } = (req.body as { message?: string }) ?? {};
        if (!message) { err(res, "message required", 400); return; }

        const dateCtx = buildLlmDateContext();
        const extractPrompt =
          `${dateCtx}\n\n` +
          `You are a scheduling assistant. The user wants to reschedule a calendar event.\n` +
          `Extract the event title to move, and the target time/date.\n\n` +
          `User message: "${message}"\n\n` +
          `Reply with ONLY valid JSON, no markdown:\n` +
          `{"eventTitle":"<string or null>","targetTime":"HH:MM or null","targetDate":"YYYY-MM-DD or null"}\n` +
          `Rules:\n` +
          `- eventTitle: the name/title of the event to reschedule (or null if unclear).\n` +
          `- targetTime: 24h format. Convert "3pm" → "15:00", "11am" → "11:00".\n` +
          `- targetDate: use the reference table above. null means same day or today.\n` +
          `- Return ONLY raw JSON.`;

        const raw = await useModelWithFallback(runtime, ModelType.TEXT_SMALL, {
          prompt: extractPrompt,
          maxTokens: 100,
          temperature: 0.1,
        });

        let extracted: { eventTitle: string | null; targetTime: string | null; targetDate: string | null } = {
          eventTitle: null, targetTime: null, targetDate: null,
        };
        try {
          const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
          const parsed = JSON.parse(cleaned) as typeof extracted;
          extracted.eventTitle  = parsed.eventTitle  ?? null;
          extracted.targetTime  = parsed.targetTime  ?? null;
          extracted.targetDate  = parsed.targetDate  ?? null;
        } catch {
          // Fall through to error response.
        }

        if (!extracted.eventTitle || !extracted.targetTime) {
          ok(res, {
            success: false,
            text: "I couldn't figure out which event to reschedule or what time to move it to. Try something like: \"Reschedule the Daily Stand-up to 3pm Tuesday\".",
          });
          return;
        }

        // Fuzzy-match: find the event by title in the next 14 days.
        const calSvc = runtime.getService(CalendarMcpService.serviceType) as CalendarMcpService | null;
        if (!calSvc) {
          ok(res, { success: false, text: "Calendar service unavailable." });
          return;
        }

        const upcoming = await calSvc.getEvents(14);
        const needle = extracted.eventTitle.toLowerCase();
        const match = upcoming
          .filter((ev) => !ev.allDay)
          .sort((a, b) => {
            const scoreA = a.title.toLowerCase().includes(needle) ? -1 : 0;
            const scoreB = b.title.toLowerCase().includes(needle) ? -1 : 0;
            return scoreA - scoreB;
          })
          .find((ev) => ev.title.toLowerCase().includes(needle));

        if (!match) {
          ok(res, {
            success: false,
            text: `I couldn't find an upcoming event matching "${extracted.eventTitle}". Check the exact event name in your calendar.`,
          });
          return;
        }

        const targetDate = extracted.targetDate ?? match.start.slice(0, 10);
        const newStart   = `${targetDate}T${extracted.targetTime}:00`;
        const durationMs = new Date(match.end).getTime() - new Date(match.start).getTime();
        const durationMin = Math.max(15, Math.round(durationMs / 60_000));
        const [h, m] = extracted.targetTime.split(":").map(Number);
        const endMin = h * 60 + m + durationMin;
        const newEnd = `${targetDate}T${String(Math.floor(endMin / 60) % 24).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}:00`;

        // Conflict pre-check.
        const clashes = upcoming.filter((ev) => {
          if (ev.id === match.id) return false;
          return eventsOverlap(ev.start, ev.end, newStart, newEnd);
        });
        if (clashes.length > 0) {
          const list = clashes
            .map((ev) => `**${ev.title}** (${new Date(ev.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })})`)
            .join(", ");
          ok(res, { success: false, text: `⚠ That slot is already taken by ${list}. Choose a different time.` });
          return;
        }

        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const updated = await updateEvent(match.id, { start: newStart, end: newEnd, timeZone: tz });

        const readable = new Date(newStart).toLocaleString("en-US", {
          weekday: "short", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit",
        });

        ok(res, {
          success: true,
          text: `Done! **${updated.title}** moved to **${readable}**.`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/reschedule-by-title: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/send-direct ──────────────────────────────────────────────
  // Send an email without requiring an existing action item in the queue.
  // Used for document-summary emails drafted inline from chat.
  // Body: { to: string, subject: string, body: string, attachDocIds?: string[] }
  {
    type: "POST" as const,
    path: "/send-direct",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const { to, subject, body: emailBody, attachDocIds } =
          (req.body as { to?: string; subject?: string; body?: string; attachDocIds?: string[] }) ?? {};

        if (!to?.trim() || !subject?.trim() || !emailBody?.trim()) {
          err(res, "to, subject, and body are required", 400);
          return;
        }
        if (!isValidEmail(to)) {
          err(res, "Invalid recipient email address", 400);
          return;
        }

        const gmailSvc = runtime.getService(
          GmailMcpService.serviceType
        ) as GmailMcpService | null;

        if (!gmailSvc) {
          err(res, "GmailMcpService not available", 503);
          return;
        }

        const attachments = (attachDocIds ?? [])
          .map((id) => docStore.get(id))
          .filter((d): d is DocEntry & { base64: string } => d !== undefined && d.base64 !== undefined)
          .map((d) => ({ filename: d.filename, base64: d.base64, mimeType: "application/pdf" }));

        const db = runtime.db as unknown as Db;
        const messageId = await gmailSvc.sendEmail(to.trim(), subject.trim(), emailBody.trim(), attachments.length ? attachments : undefined);
        recordSentDraft(subject.trim(), emailBody.trim(), db);
        scanSentEmailForCommitments(runtime, db, subject.trim(), emailBody.trim());
        console.log(`[Pulse:Routes] send-direct → ${to}, messageId=${messageId}`);
        ok(res, { success: true, messageId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/send-direct: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/upload ────────────────────────────────────────────────────
  // Accept a base64-encoded PDF, extract text with pdf-parse, summarize with
  // the LLM, store in the in-memory docStore, and return a docId the frontend
  // can attach to subsequent chat messages for document-grounded Q&A.
  //
  // Body: { filename: string, data: string (base64 PDF) }
  // Response: { docId, filename, summary, pageCount }
  {
    type: "POST" as const,
    path: "/upload",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const { filename = "document.pdf", data } =
          (req.body as { filename?: string; data?: string }) ?? {};

        if (!data) { err(res, "data (base64 PDF) is required", 400); return; }

        // Decode base64 → Buffer
        let buf: Buffer;
        try {
          buf = Buffer.from(data, "base64");
        } catch {
          err(res, "Invalid base64 data", 400);
          return;
        }

        if (buf.length === 0) { err(res, "Empty file", 400); return; }

        // Parse PDF — extract raw text and page count
        let pdfText = "";
        let pageCount = 0;
        try {
          const parser = new PDFParse({ data: buf });
          const parsed = await parser.getText();
          pdfText   = parsed.text ?? "";
          pageCount = parsed.total ?? 0;
          await parser.destroy();
        } catch (parseErr) {
          const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          console.warn("[Pulse:Routes] pdf-parse failed:", parseMsg);
          err(res, `Could not parse PDF: ${parseMsg}`, 422);
          return;
        }

        if (!pdfText.trim()) {
          err(res, "PDF contains no extractable text (may be a scanned image)", 422);
          return;
        }

        // Truncate to first 6000 chars for LLM context (keeps well within small model limits)
        const textForLlm   = pdfText.slice(0, 6_000);
        const textForStore = pdfText.slice(0, 8_000);

        // Single LLM call: produce a short summary AND a structured analysis.
        // Bypasses ElizaOS sessions entirely — same pattern as /pulse/draft-assist.
        const analysisPrompt =
          `You are a document analyst. Analyze the following document and respond in this exact format:\n\n` +
          `SUMMARY: <1-2 sentences describing what the document is>\n\n` +
          `ACTION ITEMS:\n` +
          `<bullet list of specific tasks, decisions, or approvals needed — with owner and deadline if present>\n\n` +
          `DEADLINES:\n` +
          `<bullet list of dates and what is due — or "None found" if absent>\n\n` +
          `RISKS OR BLOCKERS:\n` +
          `<bullet list of risks or blockers — or "None identified">\n\n` +
          `Document: "${filename}" (${pageCount} pages)\n\n${textForLlm}`;

        let summary  = `Document uploaded: ${filename} (${pageCount} pages).`;
        let analysis = summary;
        try {
          const raw = await Promise.race([
            useModelWithFallback(runtime, ModelType.TEXT_SMALL, {
              prompt: analysisPrompt,
              maxTokens: 600,
              temperature: 0.2,
            }) as Promise<string>,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("LLM timeout")), 90_000)
            ),
          ]);
          analysis = (raw as string).trim();
          // Extract the SUMMARY line for the short preview
          const summaryMatch = analysis.match(/SUMMARY:\s*(.+)/i);
          if (summaryMatch) summary = summaryMatch[1].trim();
        } catch (llmErr) {
          console.warn("[Pulse:Routes] upload: LLM analysis failed:", llmErr instanceof Error ? llmErr.message : String(llmErr));
        }

        const docId = crypto.randomUUID();
        docStore.set(docId, { filename, text: textForStore, pageCount, summary, base64: data });

        console.log(`[Pulse:Routes] PDF uploaded: ${filename} (${pageCount}p, ${pdfText.length} chars) → docId=${docId}`);
        ok(res, { docId, filename, summary, analysis, pageCount, text: textForStore.slice(0, 4_000) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] POST /pulse/upload: ${msg}`);
        err(res, msg);
      }
    },
  },

  // ── POST /pulse/auth/token ───────────────────────────────────────────────
  // Accepts a refresh token pasted directly by the user (fallback for Nosana
  // deployments where the OAuth redirect URI can't be pre-registered).
  {
    type: "POST" as const,
    path: "/auth/token",
    handler: async (req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };
      if (!refreshToken?.trim()) {
        (res as unknown as { status: (c: number) => { json: (b: unknown) => void } })
          .status(400).json({ error: "refreshToken is required" });
        return;
      }
      await saveRefreshToken(refreshToken.trim());
      ok(res, { success: true });
    },
  },

  // ── GET /pulse/auth/status ────────────────────────────────────────────────
  {
    type: "GET" as const,
    path: "/auth/status",
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const configured = await isGoogleAuthConfigured();
      const hasClientId = Boolean(process.env.GOOGLE_CLIENT_ID);
      const hasClientSecret = Boolean(process.env.GOOGLE_CLIENT_SECRET);
      ok(res, {
        configured,
        canStartOAuth: hasClientId && hasClientSecret,
        hasClientId,
        hasClientSecret,
        relayUri: "https://py-tr.github.io/agent-challenge/oauth-relay.html",
      });
    },
  },

  // ── GET /pulse/auth/google ────────────────────────────────────────────────
  // Builds the Google OAuth consent URL and redirects the browser to it.
  // Uses the static GitHub Pages relay as redirect_uri so any Pulse deployment
  // (local or Nosana dynamic node) works with a single pre-registered URI.
  {
    type: "GET" as const,
    path: "/auth/google",
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        (res as unknown as { status: (c: number) => { send: (s: string) => void } })
          .status(400)
          .send("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set before starting OAuth.");
        return;
      }

      const port = process.env.SERVER_PORT ?? "3000";
      const pulseOrigin = process.env.PULSE_PUBLIC_URL ?? `http://localhost:${port}`;

      // Static relay hosted on GitHub Pages — registered once in Google Cloud Console.
      // Receives the callback and forwards the code back to this Pulse instance via state.
      const RELAY_URI = "https://py-tr.github.io/agent-challenge/oauth-relay.html";
      const state = Buffer.from(pulseOrigin).toString("base64");

      const scopes = [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
      ].join(" ");

      const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  RELAY_URI,
        response_type: "code",
        scope:         scopes,
        access_type:   "offline",
        prompt:        "consent",
        state,
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
      console.log(`[Pulse:Auth] Redirecting to Google OAuth via relay (origin=${pulseOrigin})`);
      (res as unknown as { redirect: (url: string) => void }).redirect(authUrl);
    },
  },

  // ── GET /pulse/auth/google/callback ──────────────────────────────────────
  // Called directly by Google (localhost) OR forwarded by the GitHub Pages relay
  // (?relay=1). Exchanges the code using the correct redirect_uri for each case.
  {
    type: "GET" as const,
    path: "/auth/google/callback",
    handler: async (req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const port = process.env.SERVER_PORT ?? "3000";
      const baseUrl = process.env.PULSE_PUBLIC_URL ?? `http://localhost:${port}`;

      const { code, error, relay } = (req.query ?? {}) as {
        code?: string; error?: string; relay?: string;
      };

      // Use relay URI when the code was forwarded by the GitHub Pages relay page.
      const RELAY_URI = "https://py-tr.github.io/agent-challenge/oauth-relay.html";
      const redirectUri = relay === "1" ? RELAY_URI : `${baseUrl}/pulse/auth/google/callback`;

      if (error || !code) {
        console.error(`[Pulse:Auth] OAuth error: ${error ?? "no code"}`);
        (res as unknown as { redirect: (url: string) => void })
          .redirect("/pulse/dashboard?auth=error");
        return;
      }

      try {
        const clientId     = process.env.GOOGLE_CLIENT_ID!;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;

        const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id:     clientId,
            client_secret: clientSecret,
            redirect_uri:  redirectUri,
            grant_type:    "authorization_code",
          }),
        });

        if (!tokenResp.ok) {
          const body = await tokenResp.text();
          throw new Error(`Token exchange failed ${tokenResp.status}: ${body}`);
        }

        const tokens = (await tokenResp.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
        };

        if (!tokens.refresh_token) {
          throw new Error("No refresh_token in response — re-authorize with prompt=consent");
        }

        await saveRefreshToken(tokens.refresh_token);
        console.log("[Pulse:Auth] Refresh token saved to .eliza/pulse-auth.json");

        (res as unknown as { redirect: (url: string) => void })
          .redirect("/pulse/dashboard?auth=success");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Auth] Callback error: ${msg}`);
        // Log full error server-side only — never expose internal error details in URL.
        (res as unknown as { redirect: (url: string) => void })
          .redirect("/pulse/dashboard?auth=error");
      }
    },
  },
];

/** Retrieve stored document text by docId (called from ChatDrawer context injection). */
export function getDocText(docId: string): string | null {
  return docStore.get(docId)?.text ?? null;
}

// ─── Inbox health score ───────────────────────────────────────────────────────

/**
 * Compute a 0–100 inbox health score from DB snapshots:
 *   approval_rate  * 40  — how decisive the user is
 *   (1 - pending_ratio) * 35 — how clear the queue is
 *   commitment_rate * 25 — how reliable they are
 *
 * Neutral defaults are used when there is no data yet (new installation).
 */
function computeInboxScore(
  counts: { pending: number; approved: number; rejected: number },
  commitmentStats: { total: number; handled: number }
): number {
  const totalDecided = counts.approved + counts.rejected;
  const approvalRate = totalDecided > 0 ? counts.approved / totalDecided : 0.75;

  const totalItems = counts.pending + counts.approved + counts.rejected;
  const pendingRatio = totalItems > 0 ? counts.pending / totalItems : 0;

  const commitmentRate =
    commitmentStats.total > 0
      ? commitmentStats.handled / commitmentStats.total
      : 1.0; // no commitments ⇒ nothing missed

  const raw = approvalRate * 40 + (1 - pendingRatio) * 35 + commitmentRate * 25;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

// ─── Reply suggestion helpers ─────────────────────────────────────────────────

/** Keyword-based fallback suggestions when the LLM is unavailable. */
function fallbackSuggestions(subject: string): string[] {
  const s = subject.toLowerCase();
  if (["meeting", "call", "reschedule", "schedule"].some((k) => s.includes(k))) {
    return ["Yes, let's meet", "Can we reschedule?", "I'll check my calendar"];
  }
  if (["proposal", "pricing", "contract", "quote"].some((k) => s.includes(k))) {
    return ["Sounds good, let's proceed", "Need more time to review", "Can we discuss on a call?"];
  }
  return ["Sounds good", "Need more time", "Let me get back to you"];
}

async function generateReplySuggestions(
  runtime: IAgentRuntime,
  subject: string,
  from: string,
  bodySnippet: string,
): Promise<string[]> {
  const prompt = `Generate exactly 3 short email reply suggestions (max 8 words each) for this email:
From: ${sanitizeForPrompt(from || "(unknown)", 100)}
Subject: ${sanitizeForPrompt(subject || "(no subject)", 200)}
Preview: ${sanitizeForPrompt(bodySnippet, 200) || "(no preview)"}

Return ONLY a JSON array: ["suggestion1","suggestion2","suggestion3"]
Nothing else.`;

  try {
    const timeoutMs = 5_000;
    const raw = await Promise.race([
      useModelWithFallback(runtime, ModelType.TEXT_SMALL, { prompt, maxTokens: 80, temperature: 0.3 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM timeout")), timeoutMs),
      ),
    ]);

    if (!(raw as string).trim()) {
      console.warn("[Pulse:Routes] suggest-replies: LLM returned empty response, using fallback");
      throw new Error("LLM returned empty response");
    }

    // Extract JSON array from the response (LLM may wrap it in markdown/prose)
    const jsonMatch = (raw as string).match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      console.warn("[Pulse:Routes] suggest-replies: No JSON array in LLM response, using fallback");
      throw new Error("No JSON array found in LLM response");
    }

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((s) => typeof s === "string" && s.trim().length > 0)
    ) {
      return (parsed as string[]).map((s) => s.trim());
    }
    console.warn("[Pulse:Routes] suggest-replies: LLM returned unexpected JSON shape, using fallback");
    throw new Error("LLM returned unexpected JSON shape");
  } catch {
    return fallbackSuggestions(subject);
  }
}
