/**
 * src/pulse/types.ts
 * Shared application types — pure TypeScript, no DB or framework imports.
 * All other Pulse modules import from here to keep the domain model central.
 */

// ─── Action Queue ─────────────────────────────────────────────────────────────

/**
 * Every item the user sees in the approval queue is one of these four types.
 * The type drives card rendering in the React frontend.
 */
export type ActionItemType =
  | "email_draft"          // Pulse drafted an outbound email
  | "conflict_resolution"  // Two calendar events overlap — resolution suggested
  | "slib_reminder"        // Slib Guard detected a past commitment about to be missed
  | "follow_up";           // No reply received — follow-up draft created

export type ActionItemStatus = "pending" | "approved" | "rejected";

export interface ActionItem {
  id: string;                          // UUID
  type: ActionItemType;
  title: string;                       // Short label shown on the card
  body: string;                        // Draft content / resolution description
  metadata: Record<string, unknown> | null; // Type-specific data (email id, event ids…)
  status: ActionItemStatus;
  priority: number;                    // 1 = highest, 10 = lowest; lower surfaces first
  createdAt: string;                   // ISO datetime
  decidedAt: string | null;            // Null until resolved
}

// Row shape returned from the DB (dates as strings, metadata as JSON string)
export interface ActionItemRow {
  id: string;
  type: string;
  title: string;
  body: string;
  metadata: string | null;
  status: string;
  priority: number;
  createdAt: string;
  decidedAt: string | null;
}

// ─── Commitments (Slib Guard) ─────────────────────────────────────────────────

/**
 * A commitment extracted from an outgoing message.
 * Example: "I'll send the proposal to Mark by Wednesday."
 */
export interface Commitment {
  id: string;                    // UUID
  sourceMessageId: string | null; // Email/message id the commitment was found in
  text: string;                  // Verbatim commitment text
  recipient: string | null;      // Extracted name ("Mark")
  deadline: string;              // YYYY-MM-DD
  remindAt: string;              // ISO datetime — 1 day before deadline at 9am
  reminderSent: boolean;
  actionItemId: string | null;   // Set once the slib_reminder queue item is created
  createdAt: string;             // ISO datetime
}

// ─── Decisions ────────────────────────────────────────────────────────────────

export type DecisionValue = "approved" | "rejected";

export interface Decision {
  id: string;            // UUID
  actionItemId: string;  // References action_items.id
  decision: DecisionValue;
  reason: string | null; // Optional rejection reason
  decidedAt: string;     // ISO datetime
  // Joined from action_items — populated by getDecisions()
  title: string | null;
  itemType: string | null;
}

// ─── Convenience ─────────────────────────────────────────────────────────────

/** Narrow an ActionItemRow to ActionItem, parsing JSON metadata. */
export function rowToActionItem(row: ActionItemRow): ActionItem {
  return {
    id: row.id,
    type: row.type as ActionItemType,
    title: row.title,
    body: row.body,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    status: row.status as ActionItemStatus,
    priority: row.priority,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}
