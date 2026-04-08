/**
 * src/pulse/tests/helpers.ts
 * Shared utilities for Pulse test suites.
 *
 * makeDb()       — in-memory PGLite + Drizzle + run migrations
 * makeMockRuntime() — minimal IAgentRuntime stub for provider / action tests
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema, type Db } from "../db/schema.js";
import { runMigrations } from "../db/migrations.js";
import type { IAgentRuntime } from "@elizaos/core";

// ─── In-memory DB ─────────────────────────────────────────────────────────────

export async function makeDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite(); // no path = in-memory
  const db = drizzle(client, { schema }) as Db;
  await runMigrations(db);
  return { db, close: () => client.close() };
}

// ─── Mock runtime ─────────────────────────────────────────────────────────────

interface MockRuntimeOptions {
  db?: Db;
  /** Return value for runtime.useModel — defaults to "[]" (empty JSON array) */
  modelResponse?: string;
  cacheStore?: Map<string, unknown>;
}

export function makeMockRuntime(opts: MockRuntimeOptions = {}): IAgentRuntime {
  const cache = opts.cacheStore ?? new Map<string, unknown>();

  return {
    db: opts.db ?? null,
    character: { name: "Pulse", system: "You are Pulse." },

    useModel: async (_type: unknown, _params: unknown): Promise<string> => {
      return opts.modelResponse ?? "[]";
    },

    setCache: async <T>(key: string, value: T): Promise<void> => {
      cache.set(key, value);
    },

    getCache: async <T>(key: string): Promise<T | undefined> => {
      return cache.get(key) as T | undefined;
    },

    getService: (_type: string) => null,

    // Stub every other runtime method to avoid crashes.
    agentId: "test-agent-id",
  } as unknown as IAgentRuntime;
}
