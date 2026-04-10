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
import { MemoryType, type Route, type RouteRequest, type RouteResponse, type IAgentRuntime } from "@elizaos/core";
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
} from "../db/queries.js";
import type { Db } from "../db/schema.js";
import { GmailMcpService } from "../services/GmailMcpService.js";
import { CalendarMcpService } from "../services/CalendarMcpService.js";

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

        console.log(`[Pulse:Routes] Approved item ${id}`);
        ok(res, { success: true, id, status: "approved" });
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
        const limit = limitParam
          ? Math.min(parseInt(String(limitParam), 10) || 20, 100)
          : 20;

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

        const [counts, gmailInfo, calInfo] =
          await Promise.all([
            countAllStatuses(db),
            gmailSvc?.getLastFetchInfo() ??
              Promise.resolve({ fetchedAt: null, messageCount: 0 }),
            calSvc?.getLastFetchInfo() ??
              Promise.resolve({ fetchedAt: null, eventCount: 0 }),
          ]);

        ok(res, {
          queue: counts,
          gmail: gmailInfo,
          calendar: calInfo,
          agentName: runtime.character?.name ?? "Pulse",
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
            console.log(`[Gmail] Inserting item: ${msg.subject}`);
            await insertActionItem(db, {
              type:     classification.actionItemType,
              title:    msg.subject,
              body:     classification.body,
              metadata: {
                gmailMessageId: msg.id,
                from:           msg.from,
                date:           msg.date,
                category:       classification.category,
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
];
