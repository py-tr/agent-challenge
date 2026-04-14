/**
 * src/pulse/db/queries.ts
 * Typed CRUD helpers for all Pulse tables.
 *
 * Rules:
 *   - No raw SQL — Drizzle's query builder only.
 *   - Every function takes `db: Db` as its first argument (no module-level state).
 *   - IDs are generated here with crypto.randomUUID() so callers don't need to.
 *   - All dates written as ISO strings; never Date objects.
 */

import { eq, and, lte, desc, count, isNull, gte, asc, inArray, like } from "drizzle-orm";
import { actionItems, commitments, decisions, type Db } from "./schema.js";
import {
  rowToActionItem,
  type ActionItem,
  type ActionItemType,
  type ActionItemStatus,
  type Commitment,
  type Decision,
  type DecisionValue,
} from "../types.js";

// ─── Action Items ─────────────────────────────────────────────────────────────

export async function insertActionItem(
  db: Db,
  item: {
    type: ActionItemType;
    title: string;
    body: string;
    metadata?: Record<string, unknown> | null;
    priority?: number;
  }
): Promise<ActionItem> {
  const row = {
    id:        crypto.randomUUID(),
    type:      item.type,
    title:     item.title,
    body:      item.body,
    metadata:  item.metadata ? JSON.stringify(item.metadata) : null,
    status:    "pending" as const,
    priority:  item.priority ?? 5,
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };

  await db.insert(actionItems).values(row);
  return rowToActionItem(row);
}

/** Return all pending items ordered by priority asc, then oldest first. */
export async function getQueue(db: Db): Promise<ActionItem[]> {
  const rows = await db
    .select()
    .from(actionItems)
    .where(eq(actionItems.status, "pending"))
    .orderBy(actionItems.priority, actionItems.createdAt);

  return rows.map(rowToActionItem);
}

/**
 * Check if an action item with the given Gmail message ID already exists.
 * Used to deduplicate emails across full-fetch and incremental-sync cycles.
 */
export async function actionItemExistsForGmailMessage(
  db: Db,
  gmailMessageId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: actionItems.id })
    .from(actionItems)
    .where(like(actionItems.metadata, `%"gmailMessageId":"${gmailMessageId}"%`))
    .limit(1);
  return rows.length > 0;
}

export async function getActionItem(
  db: Db,
  id: string
): Promise<ActionItem | null> {
  const rows = await db
    .select()
    .from(actionItems)
    .where(eq(actionItems.id, id))
    .limit(1);

  return rows[0] ? rowToActionItem(rows[0]) : null;
}

/**
 * Update an item's status.
 * Sets decidedAt automatically — callers don't manage timestamps.
 */
export async function setActionItemStatus(
  db: Db,
  id: string,
  status: ActionItemStatus
): Promise<void> {
  await db
    .update(actionItems)
    .set({ status, decidedAt: new Date().toISOString() })
    .where(eq(actionItems.id, id));
}

/** Count of items by status — used by the StatusBar ("processed X emails"). */
export async function countByStatus(
  db: Db,
  status: ActionItemStatus
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(actionItems)
    .where(eq(actionItems.status, status));

  return rows[0]?.n ?? 0;
}

/**
 * Count all statuses in one GROUP BY query.
 * Replaces three separate countByStatus() calls in /pulse/status.
 */
export async function countAllStatuses(
  db: Db
): Promise<{ pending: number; approved: number; rejected: number }> {
  const rows = await db
    .select({ status: actionItems.status, n: count() })
    .from(actionItems)
    .groupBy(actionItems.status);

  const result = { pending: 0, approved: 0, rejected: 0 };
  for (const row of rows) {
    if (row.status === "pending" || row.status === "approved" || row.status === "rejected") {
      result[row.status] = row.n;
    }
  }
  return result;
}

// ─── Commitments ──────────────────────────────────────────────────────────────

export async function insertCommitment(
  db: Db,
  c: {
    sourceMessageId?: string | null;
    text: string;
    recipient?: string | null;
    deadline: string;    // YYYY-MM-DD
    remindAt: string;    // ISO datetime
  }
): Promise<Commitment> {
  const row = {
    id:              crypto.randomUUID(),
    sourceMessageId: c.sourceMessageId ?? null,
    text:            c.text,
    recipient:       c.recipient ?? null,
    deadline:        c.deadline,
    remindAt:        c.remindAt,
    reminderSent:    false,
    actionItemId:    null,
    createdAt:       new Date().toISOString(),
  };

  await db.insert(commitments).values(row);
  return row;
}

/**
 * Return commitments whose remindAt has passed and whose reminder hasn't
 * been sent yet. Called by PulseBackgroundService on each processing cycle.
 */
export async function getPendingReminders(
  db: Db,
  asOf: string = new Date().toISOString()
): Promise<Commitment[]> {
  return db
    .select()
    .from(commitments)
    .where(
      and(
        lte(commitments.remindAt, asOf),
        eq(commitments.reminderSent, false)
      )
    );
}

/**
 * Mark a commitment's reminder as sent and link the created action item.
 */
export async function markReminderSent(
  db: Db,
  commitmentId: string,
  actionItemId: string
): Promise<void> {
  await db
    .update(commitments)
    .set({ reminderSent: true, actionItemId })
    .where(eq(commitments.id, commitmentId));
}

/** Commitment stats for inbox score: total vs handled (reminderSent = true). */
export async function getCommitmentStats(
  db: Db
): Promise<{ total: number; handled: number }> {
  const rows = await db
    .select({ reminderSent: commitments.reminderSent, n: count() })
    .from(commitments)
    .groupBy(commitments.reminderSent);

  let total = 0;
  let handled = 0;
  for (const row of rows) {
    total += row.n;
    if (row.reminderSent) handled += row.n;
  }
  return { total, handled };
}

/** All commitments without an associated action item — for debugging / tests. */
export async function getUnqueuedCommitments(db: Db): Promise<Commitment[]> {
  return db
    .select()
    .from(commitments)
    .where(isNull(commitments.actionItemId));
}

// ─── Decisions ────────────────────────────────────────────────────────────────

export async function insertDecision(
  db: Db,
  d: {
    actionItemId: string;
    decision: DecisionValue;
    reason?: string | null;
  }
): Promise<Decision> {
  const row = {
    id:           crypto.randomUUID(),
    actionItemId: d.actionItemId,
    decision:     d.decision,
    reason:       d.reason ?? null,
    decidedAt:    new Date().toISOString(),
  };

  await db.insert(decisions).values(row);
  return { ...row, title: null, itemType: null };
}

/** Most recent decisions first, joined with action_items for title + type. */
export async function getDecisions(
  db: Db,
  limit = 20
): Promise<Decision[]> {
  const rows = await db
    .select({
      id:           decisions.id,
      actionItemId: decisions.actionItemId,
      decision:     decisions.decision,
      reason:       decisions.reason,
      decidedAt:    decisions.decidedAt,
      title:        actionItems.title,
      itemType:     actionItems.type,
    })
    .from(decisions)
    .leftJoin(actionItems, eq(decisions.actionItemId, actionItems.id))
    .orderBy(desc(decisions.decidedAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    decision: r.decision as DecisionValue,
    title:    r.title ?? null,
    itemType: r.itemType ?? null,
  }));
}

export async function countDecisions(db: Db): Promise<number> {
  const rows = await db.select({ n: count() }).from(decisions);
  return rows[0]?.n ?? 0;
}

export interface DayBucket { date: string; approved: number; rejected: number }

/**
 * Returns decisions grouped by calendar day for the last N days.
 * Used by the analytics dashboard.
 */
export async function getWeeklyDecisions(
  db: Db,
  days = 7
): Promise<DayBucket[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();

  const rows = await db
    .select({
      decidedAt: decisions.decidedAt,
      decision:  decisions.decision,
    })
    .from(decisions)
    .where(gte(decisions.decidedAt, since))
    .orderBy(asc(decisions.decidedAt));

  // Group by YYYY-MM-DD in TypeScript (avoids SQLite date function portability issues)
  const map = new Map<string, DayBucket>();
  for (const row of rows) {
    const day = row.decidedAt.slice(0, 10);
    const bucket = map.get(day) ?? { date: day, approved: 0, rejected: 0 };
    if (row.decision === "approved") bucket.approved++;
    else bucket.rejected++;
    map.set(day, bucket);
  }

  // Fill in missing days with zeros so the chart has a full 7-day window
  const result: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1_000);
    const key = d.toISOString().slice(0, 10);
    result.push(map.get(key) ?? { date: key, approved: 0, rejected: 0 });
  }
  return result;
}

/**
 * Check if a follow_up item exists for a thread by scanning metadata JSON.
 * Lightweight: only looks at pending follow_up items.
 */
export async function followUpExistsForGmailThread(
  db: Db,
  threadId: string
): Promise<boolean> {
  const rows = await db
    .select({ metadata: actionItems.metadata })
    .from(actionItems)
    .where(and(eq(actionItems.type, "follow_up"), eq(actionItems.status, "pending")));

  return rows.some((r) => r.metadata?.includes(threadId));
}

/**
 * Auto-resolve pending follow_up items whose thread has since received a reply.
 * threadIds: set of thread IDs that now have a reply (last message not from user).
 * Returns the number of items resolved.
 */
export async function resolveFollowUpsWithReplies(
  db: Db,
  repliedThreadIds: Set<string>
): Promise<number> {
  if (repliedThreadIds.size === 0) return 0;

  const rows = await db
    .select({ id: actionItems.id, metadata: actionItems.metadata })
    .from(actionItems)
    .where(and(eq(actionItems.type, "follow_up"), eq(actionItems.status, "pending")));

  const toResolve = rows
    .filter((r) => r.metadata && [...repliedThreadIds].some((tid) => r.metadata!.includes(tid)))
    .map((r) => r.id);

  if (toResolve.length === 0) return 0;

  await db
    .update(actionItems)
    .set({ status: "approved" })
    .where(inArray(actionItems.id, toResolve));

  return toResolve.length;
}

/**
 * Auto-approve pending slib_reminder items whose deadline has passed by more
 * than 24 hours — the commitment window is over, no action needed.
 * Returns the number of items expired.
 */
export async function autoExpireSlibReminders(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);

  const rows = await db
    .select({ id: actionItems.id, metadata: actionItems.metadata })
    .from(actionItems)
    .where(and(eq(actionItems.type, "slib_reminder"), eq(actionItems.status, "pending")));

  const toExpire = rows.filter((r) => {
    if (!r.metadata) return false;
    try {
      const meta = JSON.parse(r.metadata) as { deadline?: string };
      return typeof meta.deadline === "string" && meta.deadline <= cutoff;
    } catch {
      return false;
    }
  }).map((r) => r.id);

  if (toExpire.length === 0) return 0;

  await db
    .update(actionItems)
    .set({ status: "approved", decidedAt: new Date().toISOString() })
    .where(inArray(actionItems.id, toExpire));

  return toExpire.length;
}

/**
 * Approval rate by action item type — used by the pattern summary
 * once 10+ decisions exist.
 *
 * Returns e.g.:
 *   [{ type: "email_draft", approved: 8, rejected: 1 }, …]
 */
export async function getDecisionPatterns(
  db: Db
): Promise<Array<{ type: string; approved: number; rejected: number }>> {
  // Join decisions → action_items, group by type + decision.
  const rows = await db
    .select({
      type:     actionItems.type,
      decision: decisions.decision,
      n:        count(),
    })
    .from(decisions)
    .innerJoin(actionItems, eq(decisions.actionItemId, actionItems.id))
    .groupBy(actionItems.type, decisions.decision);

  // Pivot into { type, approved, rejected }.
  const map = new Map<string, { approved: number; rejected: number }>();
  for (const row of rows) {
    const existing = map.get(row.type) ?? { approved: 0, rejected: 0 };
    if (row.decision === "approved") existing.approved = row.n;
    else existing.rejected = row.n;
    map.set(row.type, existing);
  }

  return Array.from(map.entries()).map(([type, counts]) => ({
    type,
    ...counts,
  }));
}
