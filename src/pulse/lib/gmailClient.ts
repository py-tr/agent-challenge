/**
 * src/pulse/lib/gmailClient.ts
 * Day 1 MCP Spike — Gmail client with MCP-first / REST fallback
 *
 * Standalone run:
 *   npx tsx src/pulse/lib/gmailClient.ts
 *
 * Access paths (tried in order):
 *   A. MCP  — set GMAIL_MCP_SERVER_URL (e.g. http://localhost:3001)
 *   B. REST — set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN
 *
 * If both fail, listMessages() returns { messages: [], path: "cache", error }
 * so the caller can degrade to PGLite-cached data.
 */

import { fileURLToPath } from "node:url";

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface GmailMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export type GmailPath = "mcp" | "rest" | "cache";

export interface GmailResult {
  messages: GmailMessage[];
  path: GmailPath;
  error?: string;
}

// ─── OAuth Token Cache ────────────────────────────────────────────────────────

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let _token: TokenCache | null = null;

/**
 * Exchange refresh token for a bearer token.
 * Result is cached for (expires_in - 60s) to avoid hammering the token endpoint.
 * Called automatically by REST helpers; re-exported for the 30-min heartbeat
 * that GmailMcpService will run later.
 */
export async function refreshAccessToken(): Promise<string> {
  const now = Date.now();
  if (_token && _token.expiresAt > now + 60_000) {
    return _token.accessToken;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "REST path requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN"
    );
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token refresh HTTP ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };

  _token = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return _token.accessToken;
}

// ─── REST Path ────────────────────────────────────────────────────────────────

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function restListMessages(maxResults: number): Promise<GmailMessage[]> {
  const token = await refreshAccessToken();

  const listResp = await fetch(
    `${GMAIL_BASE}/messages?maxResults=${maxResults}&labelIds=INBOX`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listResp.ok) {
    throw new Error(`Gmail list HTTP ${listResp.status}`);
  }
  const listData = (await listResp.json()) as {
    messages?: Array<{ id: string }>;
  };

  const ids = listData.messages ?? [];
  if (ids.length === 0) return [];

  // Fetch metadata in parallel (Subject, From, Date headers only — fast).
  const results = await Promise.allSettled(
    ids.map(async ({ id }) => {
      const resp = await fetch(
        `${GMAIL_BASE}/messages/${id}` +
          `?format=metadata` +
          `&metadataHeaders=Subject` +
          `&metadataHeaders=From` +
          `&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!resp.ok) throw new Error(`Message ${id} HTTP ${resp.status}`);

      const msg = (await resp.json()) as {
        id: string;
        snippet: string;
        payload: {
          headers: Array<{ name: string; value: string }>;
        };
      };

      const h = (name: string) =>
        msg.payload.headers.find(
          (header) => header.name.toLowerCase() === name.toLowerCase()
        )?.value ?? "";

      return {
        id: msg.id,
        subject: h("Subject") || "(no subject)",
        from: h("From"),
        date: h("Date"),
        snippet: msg.snippet,
      } satisfies GmailMessage;
    })
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<GmailMessage> => r.status === "fulfilled"
    )
    .map((r) => r.value);
}

// ─── MCP Path ────────────────────────────────────────────────────────────────
//
// Requires: pnpm add @modelcontextprotocol/sdk
// If the package is not installed, the dynamic import rejects and the caller
// falls through to the REST path automatically.
//
// The server URL should point to a Gmail MCP server instance, e.g.:
//   - Local: npx @modelcontextprotocol/server-gmail (coming soon)
//   - Claude.ai hosted: https://gmail.mcp.claude.com  (requires claude.ai token)
//
// The MCP server must expose a tool named "list_emails" returning JSON array
// matching GmailMessage[].

async function mcpListMessages(
  serverUrl: string,
  maxResults: number
): Promise<GmailMessage[]> {
  // Dynamic import so missing package = graceful fallback, not startup crash.
  const { Client } = (await import(
    "@modelcontextprotocol/sdk/client/index.js"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )) as any;
  const { StreamableHTTPClientTransport } = (await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )) as any;

  const client = new Client({ name: "pulse-spike", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("/mcp", serverUrl)
  );

  await client.connect(transport);

  try {
    const result = (await client.callTool({
      name: "list_emails",
      arguments: { maxResults, labelIds: ["INBOX"] },
    })) as { content: Array<{ type: string; text: string }> };

    const raw = result.content[0]?.text ?? "[]";
    const messages = JSON.parse(raw) as GmailMessage[];
    return messages;
  } finally {
    await client.close();
  }
}

// ─── Profile + History API ────────────────────────────────────────────────────

export interface GmailProfile {
  historyId: string;
  emailAddress: string;
}

/** Fetch the user's current historyId (used to anchor incremental sync). */
export async function getProfile(): Promise<GmailProfile> {
  const token = await refreshAccessToken();
  const resp = await fetch(`${GMAIL_BASE}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`getProfile HTTP ${resp.status}`);
  const data = (await resp.json()) as { historyId: string; emailAddress: string };
  return { historyId: data.historyId, emailAddress: data.emailAddress };
}

export interface HistoryResult {
  /** New messages added to INBOX since startHistoryId. */
  messages: GmailMessage[];
  /** Latest historyId — persist this as the new cursor. */
  newHistoryId: string;
}

/**
 * Thrown when startHistoryId is too old (Gmail keeps ~30 days of history).
 * Caller should fall back to a full fetch and reset the cursor.
 */
export class HistoryExpiredError extends Error {
  constructor(msg: string) { super(msg); this.name = "HistoryExpiredError"; }
}

/**
 * Fetch only messages added to INBOX since startHistoryId.
 * Returns an empty messages array (and updated historyId) when nothing is new.
 */
export async function listNewMessages(startHistoryId: string): Promise<HistoryResult> {
  const token = await refreshAccessToken();

  const params = new URLSearchParams({
    startHistoryId,
    historyTypes: "messageAdded",
    labelId: "INBOX",
  });

  const resp = await fetch(`${GMAIL_BASE}/history?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.status === 404) {
    throw new HistoryExpiredError(`historyId ${startHistoryId} is expired or invalid`);
  }
  if (!resp.ok) throw new Error(`history.list HTTP ${resp.status}`);

  const data = (await resp.json()) as {
    history?: Array<{
      messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }>;
    }>;
    historyId: string;
  };

  // Collect unique INBOX message IDs from all history records.
  const newIds = new Set<string>();
  for (const record of data.history ?? []) {
    for (const added of record.messagesAdded ?? []) {
      const { id, labelIds } = added.message;
      // Guard: only process if it landed in INBOX (some events lack labelIds).
      if (!labelIds || labelIds.includes("INBOX")) {
        newIds.add(id);
      }
    }
  }

  if (newIds.size === 0) {
    return { messages: [], newHistoryId: data.historyId };
  }

  const messages = await fetchMessageMetadata(token, [...newIds]);
  return { messages, newHistoryId: data.historyId };
}

// ─── Shared metadata fetcher (used by both list and history paths) ────────────

async function fetchMessageMetadata(
  token: string,
  ids: string[]
): Promise<GmailMessage[]> {
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const resp = await fetch(
        `${GMAIL_BASE}/messages/${id}` +
          `?format=metadata` +
          `&metadataHeaders=Subject` +
          `&metadataHeaders=From` +
          `&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!resp.ok) throw new Error(`Message ${id} HTTP ${resp.status}`);

      const msg = (await resp.json()) as {
        id: string;
        snippet: string;
        payload: { headers: Array<{ name: string; value: string }> };
      };

      const h = (name: string) =>
        msg.payload.headers.find(
          (hdr) => hdr.name.toLowerCase() === name.toLowerCase()
        )?.value ?? "";

      return {
        id:      msg.id,
        subject: h("Subject") || "(no subject)",
        from:    h("From"),
        date:    h("Date"),
        snippet: msg.snippet,
      } satisfies GmailMessage;
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<GmailMessage> => r.status === "fulfilled")
    .map((r) => r.value);
}

// ─── Send Email ───────────────────────────────────────────────────────────────

/**
 * Send an email via Gmail REST API.
 *
 * Builds a minimal RFC 2822 message with UTF-8 text/plain body, base64url-
 * encodes the whole thing, and POSTs it to messages.send.
 *
 * @returns The Gmail message ID of the sent message.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<string> {
  const token = await refreshAccessToken();

  // RFC 2822 headers + blank line + body.
  // Using quoted-printable encoding declaration keeps the headers spec-valid
  // even though we send raw UTF-8; Gmail's API is lenient about this.
  const raw =
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: 8bit\r\n` +
    `\r\n` +
    body;

  const encoded = Buffer.from(raw).toString("base64url");

  const resp = await fetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encoded }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail send HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { id: string };
  return data.id;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch inbox messages. MCP is tried first when GMAIL_MCP_SERVER_URL is set;
 * REST is the fallback. Returns which path succeeded so callers can log it.
 */
export async function listMessages(maxResults = 10): Promise<GmailResult> {
  const mcpUrl = process.env.GMAIL_MCP_SERVER_URL?.trim();

  if (mcpUrl) {
    try {
      const messages = await mcpListMessages(mcpUrl, maxResults);
      return { messages, path: "mcp" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:GmailClient] MCP failed (${msg}), falling back to REST`);
    }
  }

  try {
    const messages = await restListMessages(maxResults);
    return { messages, path: "rest" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[Pulse:GmailClient] REST also failed: ${error}`);
    return { messages: [], path: "cache", error };
  }
}

/**
 * Fetch the plain-text body of a single message.
 * Used by emailClassifier and commitmentParser in later days.
 * REST-only (MCP body fetch can be added in Day 5 when GmailMcpService is built).
 */
export async function getMessageBody(messageId: string): Promise<string> {
  const token = await refreshAccessToken();

  const resp = await fetch(`${GMAIL_BASE}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(`getMessageBody HTTP ${resp.status} for id=${messageId}`);
  }

  const msg = (await resp.json()) as {
    payload: {
      mimeType?: string;
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    };
  };

  // Prefer the text/plain part; fall back to root body data.
  const textPart = msg.payload.parts?.find(
    (p) => p.mimeType === "text/plain"
  );
  const encoded = textPart?.body?.data ?? msg.payload.body?.data ?? "";

  if (!encoded) return "";
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

// ─── Standalone Spike ─────────────────────────────────────────────────────────
// Runs only when this file is the direct entry point:
//   npx tsx src/pulse/lib/gmailClient.ts

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  void (async () => {
    console.log("╔═══════════════════════════════════╗");
    console.log("║   Pulse — Gmail Client Spike      ║");
    console.log("╚═══════════════════════════════════╝\n");

    console.log("Env check:");
    console.log(
      `  GMAIL_MCP_SERVER_URL    : ${process.env.GMAIL_MCP_SERVER_URL ?? "(not set)"}`
    );
    console.log(
      `  GOOGLE_CLIENT_ID        : ${process.env.GOOGLE_CLIENT_ID ? "✓ set" : "✗ missing"}`
    );
    console.log(
      `  GOOGLE_CLIENT_SECRET    : ${process.env.GOOGLE_CLIENT_SECRET ? "✓ set" : "✗ missing"}`
    );
    console.log(
      `  GOOGLE_REFRESH_TOKEN    : ${process.env.GOOGLE_REFRESH_TOKEN ? "✓ set" : "✗ missing"}`
    );
    console.log("");

    const result = await listMessages(10);

    if (result.error) {
      console.error(`✗ SPIKE FAILED\n  ${result.error}\n`);
      console.error("Add one of the following to your .env:");
      console.error(
        "  Path A (MCP):  GMAIL_MCP_SERVER_URL=http://localhost:3001"
      );
      console.error(
        "  Path B (REST): GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN"
      );
      process.exit(1);
    }

    console.log(`✓ Connected via: ${result.path.toUpperCase()}`);
    console.log(`✓ Messages fetched: ${result.messages.length}\n`);
    console.log("─".repeat(60));

    result.messages.forEach((msg, i) => {
      const dateShort = msg.date.slice(0, 16);
      const fromShort =
        msg.from.length > 35 ? msg.from.slice(0, 32) + "..." : msg.from;
      console.log(`${String(i + 1).padStart(2)}. ${dateShort}  ${fromShort}`);
      console.log(
        `    Subject : ${msg.subject}`
      );
      console.log(
        `    Preview : ${msg.snippet.slice(0, 80)}${msg.snippet.length > 80 ? "…" : ""}`
      );
      console.log("");
    });

    console.log("─".repeat(60));
    console.log("✓ SPIKE PASSED — proceed to Day 2 (Calendar)");
  })().catch((err: unknown) => {
    console.error("Unhandled:", err);
    process.exit(1);
  });
}
