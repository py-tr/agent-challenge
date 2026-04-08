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

import { eq, and, lte, desc, count, isNull } from "drizzle-orm";
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
  return row;
}

/** Most recent decisions first, used by DecisionHistory UI and pattern summary. */
export async function getDecisions(
  db: Db,
  limit = 20
): Promise<Decision[]> {
  const rows = await db
    .select()
    .from(decisions)
    .orderBy(desc(decisions.decidedAt))
    .limit(limit);
  // Drizzle infers decision as `string`; cast to the narrower DecisionValue.
  return rows.map((r) => ({ ...r, decision: r.decision as DecisionValue }));
}

export async function countDecisions(db: Db): Promise<number> {
  const rows = await db.select({ n: count() }).from(decisions);
  return rows[0]?.n ?? 0;
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
