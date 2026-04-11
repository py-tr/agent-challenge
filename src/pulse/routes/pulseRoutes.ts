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
import { getMetrics } from "../lib/nosanaMetrics.js";
import {
  getQueue,
  getActionItem,
  setActionItemStatus,
  insertDecision,
  insertActionItem,
  getDecisions,
  countAllStatuses,
  countDecisions,
  getDecisionPatterns,
  getCommitmentStats,
} from "../db/queries.js";
import type { Db } from "../db/schema.js";
import type { ActionItem } from "../types.js";
import { GmailMcpService } from "../services/GmailMcpService.js";
import { CalendarMcpService } from "../services/CalendarMcpService.js";
import { MorningBriefingService } from "../services/MorningBriefingService.js";
import { updateEvent, listEvents } from "../lib/calendarClient.js";

/** Display name used in outgoing email signatures. Configurable via env. */
const USER_DISPLAY_NAME =
  process.env.USER_NAME?.trim() ||
  process.env.USER_DISPLAY_NAME?.trim() ||
  "Pulse User";

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
  // Manually trigger inbox processing: fetch + classify emails, insert action
  // items for anything that needs a decision. Called by the "Process Inbox"
  // button in the dashboard.
  {
    type: "POST",
    path: "/process",
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      try {
        const gmailSvc = runtime.getService(
          GmailMcpService.serviceType
        ) as GmailMcpService | null;

        if (!gmailSvc) {
          err(res, "GmailMcpService not available", 503);
          return;
        }

        console.log("[Pulse:Routes] POST /pulse/process — fetching and classifying inbox…");
        const classified = await gmailSvc.fetchAndClassify();

        if (classified.length === 0) {
          console.log("[Pulse:Routes] /process — no new emails to process.");
          ok(res, { success: true, processed: 0, inserted: 0 });
          return;
        }

        const db = runtime.db as unknown as Db;
        let inserted = 0;

        for (const { message: msg, classification } of classified) {
          if (!classification.actionItemType) continue;
          try {
            await insertActionItem(db, {
              type:     classification.actionItemType,
              title:    msg.subject,
              body:     classification.body,
              metadata: {
                gmailMessageId: msg.id,
                from:           msg.from,
                date:           msg.date,
                category:       classification.category,
                ...(classification.metadata ?? {}),
              },
              priority: classification.priority,
            });
            inserted++;
          } catch (insertErr) {
            const insertMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
            console.error(`[Pulse:Routes] Failed to insert item for "${msg.subject}": ${insertMsg}`);
          }
        }

        console.log(`[Pulse:Routes] /process complete — ${classified.length} classified, ${inserted} inserted.`);
        ok(res, { success: true, processed: classified.length, inserted });
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
        } | undefined;

        const to       = body?.to?.trim();
        const subject  = body?.subject?.trim();
        const emailBody = body?.body?.trim();
        const itemId   = body?.itemId?.trim();

        if (!to || !subject || !emailBody || !itemId) {
          err(res, "Missing required fields: to, subject, body, itemId", 400);
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

        const messageId = await gmailSvc.sendEmail(to, subject, emailBody);

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

        // Build a self-contained prompt that instructs the model to act as a
        // focused email editor. All context is in the user message so the
        // character's system prompt does not pollute it with queue/calendar state.
        const prompt = [
          "You are acting as a focused email writing assistant. Your only task is to",
          "edit the email draft below according to the user's instruction.",
          "",
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
          `To: ${to || "(unknown)"}`,
          `Subject: ${subject || "(no subject)"}`,
          originalFrom ? `From: ${originalFrom}` : "",
          originalSnippet ? `Original message:\n${originalSnippet.slice(0, 400)}` : "",
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
          runtime.useModel(ModelType.TEXT_SMALL, {
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

  // ── POST /pulse/create-calendar-event ────────────────────────────────────
  // Directly creates a Google Calendar event from a natural-language message.
  // Bypasses ElizaOS action selection (which is unreliable for tool invocation)
  // by calling the LLM for extraction and the Calendar REST API directly.
  {
    type: "POST" as const,
    path: "/create-calendar-event",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const { message } = (req.body as { message?: string }) ?? {};
        if (!message?.trim()) { err(res, "message is required", 400); return; }

        const calSvc = runtime.getService(
          CalendarMcpService.serviceType
        ) as CalendarMcpService | null;
        if (!calSvc) { err(res, "CalendarMcpService not available", 503); return; }

        const today    = new Date().toISOString().slice(0, 10);
        const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

        const extractPrompt =
          `Today is ${today}. Extract calendar event details from the user message and return ONLY a JSON object.\n` +
          `User message: "${message}"\n\n` +
          `JSON format:\n` +
          `{"title":"...","date":"YYYY-MM-DD","startTime":"HH:MM","durationMinutes":60,"timeZone":null}\n\n` +
          `Rules:\n` +
          `- "tomorrow" = ${tomorrow}\n` +
          `- "morning" = 09:00, "noon" = 12:00, "afternoon" = 14:00, "evening" = 18:00\n` +
          `- Resolve weekday names relative to today (${today})\n` +
          `- timeZone: IANA string if mentioned, otherwise null\n` +
          `- Return ONLY raw JSON, no markdown fences, no extra text.`;

        const raw = await Promise.race([
          runtime.useModel(ModelType.TEXT_SMALL, {
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
    handler: async (req: RouteRequest, res: RouteResponse) => {
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

        // Step 1: LLM extracts which event to reschedule and target time.
        const extractionPrompt =
          `You are a scheduling assistant. Extract rescheduling intent from a user message.\n\n` +
          `Context:\n` +
          `  Event A: "${eventATitle ?? "Event A"}" (${eventAStart?.slice(11, 16) ?? "?"}–${eventAEnd?.slice(11, 16) ?? "?"})\n` +
          `  Event B: "${eventBTitle ?? "Event B"}" (${eventBStart?.slice(11, 16) ?? "?"}–${eventBEnd?.slice(11, 16) ?? "?"})\n\n` +
          `User message: "${message}"\n\n` +
          `Reply with ONLY valid JSON, no markdown:\n` +
          `{"targetEvent":"A"|"B"|"unknown","targetTime":"HH:MM"|null,"reasoning":"..."}\n` +
          `targetTime must be 24h format (e.g. "16:00") or null if not mentioned.`;

        const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: extractionPrompt,
          maxTokens: 120,
          temperature: 0.1,
        });

        let extracted: { targetEvent: "A" | "B" | "unknown"; targetTime: string | null } = {
          targetEvent: "unknown",
          targetTime: null,
        };
        try {
          const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
          const parsed = JSON.parse(cleaned) as typeof extracted;
          extracted.targetEvent = parsed.targetEvent ?? "unknown";
          extracted.targetTime  = parsed.targetTime ?? null;
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
          const targetDate = date ?? (eventAStart?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
          const newStart = `${targetDate}T${extracted.targetTime}:00`;
          const newEndMs = new Date(newStart).getTime() + durationMinutes * 60_000;
          const newEnd   = new Date(newEndMs).toISOString().replace(/\.\d{3}Z$/, "");
          const tz       = Intl.DateTimeFormat().resolvedOptions().timeZone;

          const updated = await updateEvent(chosenId, { start: newStart, end: newEnd, timeZone: tz });

          const readable = new Date(newStart).toLocaleString("en-US", {
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
          });

          ok(res, {
            action:      "rescheduled",
            text:        `Done! **${updated.title}** moved to **${readable}**. The conflict is resolved — approve the item to dismiss it from your queue.`,
            newStart:    updated.start,
            eventId:     updated.id,
          });
          return;
        }

        // If we know which event but no time, suggest free slots.
        const slotsDate = date ?? (eventAStart?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
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
];

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
From: ${from || "(unknown)"}
Subject: ${subject || "(no subject)"}
Preview: ${bodySnippet.slice(0, 200) || "(no preview)"}

Return ONLY a JSON array: ["suggestion1","suggestion2","suggestion3"]
Nothing else.`;

  try {
    const timeoutMs = 5_000;
    const raw = await Promise.race([
      runtime.useModel(ModelType.TEXT_SMALL, { prompt, maxTokens: 80, temperature: 0.3 }),
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
