/**
 * src/pulse/db/migrations.ts
 * PGLite schema migrations for Pulse.
 *
 * Design:
 *   - runMigrations(db) is idempotent — safe to call on every service start.
 *   - DDL uses IF NOT EXISTS so re-runs are no-ops.
 *   - pulse_schema_version tracks applied versions for future ALTER TABLE work.
 *   - createDb(dataDir) is the factory used by both this standalone runner
 *     and PulseBackgroundService on Day 4.
 *
 * Standalone run:
 *   npx tsx src/pulse/db/migrations.ts
 *   (pnpm dev must NOT be running — PGLite allows only one writer at a time)
 */

import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { schema, type Db } from "./schema.js";

// ─── Factory ──────────────────────────────────────────────────────────────────

// @electric-sql/pglite is a transitive dep — not directly importable from this
// project. drizzle() accepts the dataDir string and constructs PGlite internally,
// so we never need to import PGlite ourselves. db.$client holds the instance.
type Closeable = { close(): Promise<void> };

/**
 * Open a Drizzle-over-PGLite connection to `dataDir`.
 * PGLite supports only one writer per directory — call this once per process.
 */
export function createDb(dataDir: string): { db: Db; close: () => Promise<void> } {
  const db = drizzle(dataDir, { schema }) as Db;
  const close = () => (db.$client as unknown as Closeable).close();
  return { db, close };
}

// ─── Migrations ───────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1;

export async function runMigrations(db: Db): Promise<void> {
  // Version tracking table — created unconditionally first.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pulse_schema_version (
      version    INTEGER NOT NULL,
      applied_at TEXT    NOT NULL
    )
  `);

  const rows = await db.execute(
    sql`SELECT MAX(version) AS v FROM pulse_schema_version`
  );
  const existing =
    (rows.rows[0] as { v: number | null } | undefined)?.v ?? 0;

  if (existing >= CURRENT_VERSION) {
    console.log(
      `[Migrations] Schema already at v${existing} — nothing to do.`
    );
    return;
  }

  console.log(
    `[Migrations] Applying v${existing + 1} → v${CURRENT_VERSION}…`
  );

  // ── v1: initial Pulse schema ───────────────────────────────────────────────

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pulse_action_items (
      id          TEXT    PRIMARY KEY,
      type        TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      body        TEXT    NOT NULL DEFAULT '',
      metadata    TEXT,
      status      TEXT    NOT NULL DEFAULT 'pending',
      priority    INTEGER NOT NULL DEFAULT 5,
      created_at  TEXT    NOT NULL,
      decided_at  TEXT
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pulse_commitments (
      id                TEXT    PRIMARY KEY,
      source_message_id TEXT,
      text              TEXT    NOT NULL,
      recipient         TEXT,
      deadline          TEXT    NOT NULL,
      remind_at         TEXT    NOT NULL,
      reminder_sent     BOOLEAN NOT NULL DEFAULT FALSE,
      action_item_id    TEXT,
      created_at        TEXT    NOT NULL
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pulse_decisions (
      id             TEXT PRIMARY KEY,
      action_item_id TEXT NOT NULL,
      decision       TEXT NOT NULL,
      reason         TEXT,
      decided_at     TEXT NOT NULL
    )
  `);

  // Indexes for the most common query patterns.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_action_items_status
      ON pulse_action_items (status, priority, created_at)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_commitments_remind_at
      ON pulse_commitments (remind_at, reminder_sent)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_decisions_decided_at
      ON pulse_decisions (decided_at DESC)
  `);

  // Record applied version.
  await db.execute(sql`
    INSERT INTO pulse_schema_version (version, applied_at)
    VALUES (${CURRENT_VERSION}, ${new Date().toISOString()})
  `);

  console.log(`[Migrations] v${CURRENT_VERSION} applied successfully.`);
}

// ─── Standalone Runner ────────────────────────────────────────────────────────
// npx tsx src/pulse/db/migrations.ts

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  void (async () => {
    const DATA_DIR = "./.eliza/.elizadb";

    console.log("╔═══════════════════════════════════╗");
    console.log("║   Pulse — DB Migrations Runner    ║");
    console.log("╚═══════════════════════════════════╝\n");
    console.log(`Database: ${DATA_DIR}\n`);
    console.log(
      "⚠  Ensure pnpm dev is NOT running (PGLite: one writer per directory)\n"
    );

    const { db, close } = createDb(DATA_DIR);

    try {
      await runMigrations(db);

      // Verification: list all pulse_ tables
      const tables = await db.execute(sql`
        SELECT tablename
        FROM pg_catalog.pg_tables
        WHERE tablename LIKE 'pulse_%'
        ORDER BY tablename
      `);

      console.log("\nVerification — pulse_ tables in database:");
      for (const row of tables.rows) {
        console.log(`  ✓ ${(row as { tablename: string }).tablename}`);
      }

      console.log("\n✓ MIGRATIONS PASSED — proceed to Day 4 (plugin skeleton)");
    } finally {
      await close();
    }
  })().catch((err: unknown) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
