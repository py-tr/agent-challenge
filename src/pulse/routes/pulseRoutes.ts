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
 *   GET  localhost:3000/pulse/queue
 *   POST localhost:3000/pulse/approve/:id
 *   POST localhost:3000/pulse/reject/:id
 *   GET  localhost:3000/pulse/decisions
 *   GET  localhost:3000/pulse/status
 *
 * Also accessible via the agent-scoped prefix:
 *   GET  localhost:3000/api/agents/{agentId}/plugins/pulse/queue
 */

import type { Route, RouteRequest, RouteResponse, IAgentRuntime } from "@elizaos/core";
import {
  getQueue,
  getActionItem,
  setActionItemStatus,
  insertDecision,
  getDecisions,
  countByStatus,
  countDecisions,
  getDecisionPatterns,
} from "../db/queries.js";
import type { Db } from "../db/schema.js";
import { GmailMcpService } from "../services/GmailMcpService.js";
import { CalendarMcpService } from "../services/CalendarMcpService.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

function ok(res: RouteResponse, data: unknown): void {
  res.status(200).json(data);
}

function err(res: RouteResponse, message: string, status = 500): void {
  res.status(status).json({ error: message });
}

// ─── Routes ──────────────────────────────────────────────────────────────────
// Paths here are SUFFIXES only — ElizaOS prepends "/pulse/" automatically.

export const pulseRoutes: Route[] = [
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

        const [pending, approved, rejected, gmailInfo, calInfo] =
          await Promise.all([
            countByStatus(db, "pending"),
            countByStatus(db, "approved"),
            countByStatus(db, "rejected"),
            gmailSvc?.getLastFetchInfo() ??
              Promise.resolve({ fetchedAt: null, messageCount: 0 }),
            calSvc?.getLastFetchInfo() ??
              Promise.resolve({ fetchedAt: null, eventCount: 0 }),
          ]);

        ok(res, {
          queue: { pending, approved, rejected },
          gmail: gmailInfo,
          calendar: calInfo,
          agentName: runtime.character?.name ?? "Pulse",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Pulse:Routes] GET /pulse/status: ${msg}`);
        err(res, msg);
      }
    },
  },
];
