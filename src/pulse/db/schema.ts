/**
 * src/pulse/db/schema.ts
 * Drizzle ORM table definitions for PGLite.
 *
 * All tables are prefixed with "pulse_" to avoid collisions with ElizaOS's
 * own tables (memories, participants, accounts, etc.) in the shared database.
 *
 * Dates are stored as TEXT (ISO strings) rather than TIMESTAMP to sidestep
 * PGLite timezone handling. crypto.randomUUID() supplies all IDs.
 */

import { pgTable, text, boolean, integer } from "drizzle-orm/pg-core";
import type { PgliteDatabase } from "drizzle-orm/pglite";

// ─── Tables ───────────────────────────────────────────────────────────────────

/**
 * Every item in the approval queue — email drafts, conflict resolutions,
 * Slib Guard reminders, and follow-ups share this single table.
 * The `type` column drives card rendering in the frontend.
 */
export const actionItems = pgTable("pulse_action_items", {
  id:         text("id").primaryKey(),
  type:       text("type").notNull(),                         // ActionItemType
  title:      text("title").notNull(),
  body:       text("body").notNull().default(""),
  metadata:   text("metadata"),                               // JSON string | null
  status:     text("status").notNull().default("pending"),    // ActionItemStatus
  priority:   integer("priority").notNull().default(5),       // 1 highest → 10 lowest
  createdAt:  text("created_at").notNull(),                   // ISO datetime
  decidedAt:  text("decided_at"),                             // null until resolved
});

/**
 * Commitments extracted from outgoing emails by Slib Guard.
 * Example row: "I'll send the proposal to Mark by Wednesday" → deadline 2026-04-08
 */
export const commitments = pgTable("pulse_commitments", {
  id:              text("id").primaryKey(),
  sourceMessageId: text("source_message_id"),                 // Email id | null
  text:            text("text").notNull(),                     // Verbatim commitment
  recipient:       text("recipient"),                          // Extracted name | null
  deadline:        text("deadline").notNull(),                 // YYYY-MM-DD
  remindAt:        text("remind_at").notNull(),               // ISO datetime (deadline - 1 day, 9am)
  reminderSent:    boolean("reminder_sent").notNull().default(false),
  actionItemId:    text("action_item_id"),                    // Set once queued
  createdAt:       text("created_at").notNull(),
});

/**
 * Immutable log of every user decision (approve / reject).
 * Queried for the decision-pattern summary once 10+ decisions exist.
 */
export const decisions = pgTable("pulse_decisions", {
  id:           text("id").primaryKey(),
  actionItemId: text("action_item_id").notNull(),             // References action_items.id
  decision:     text("decision").notNull(),                   // "approved" | "rejected"
  reason:       text("reason"),                               // Optional rejection note
  decidedAt:    text("decided_at").notNull(),                 // ISO datetime
});

// ─── Schema bundle (passed to drizzle() for relational query support) ─────────

export const schema = { actionItems, commitments, decisions };

// ─── Db type alias ────────────────────────────────────────────────────────────

/**
 * The typed Drizzle-over-PGLite database instance used throughout Pulse.
 * Import this type wherever you need a db parameter.
 *
 *   import type { Db } from "../db/schema.js";
 */
export type Db = PgliteDatabase<typeof schema>;
