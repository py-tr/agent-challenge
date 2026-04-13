/**
 * scripts/fake-reply.ts
 * Injects a fake reply from Tom (contract renewal) into Gmail
 * to test that DetectFollowUpsAction auto-resolves his follow-up item.
 *
 * Usage:
 *   npx tsx scripts/fake-reply.ts
 *
 * Then in the chat say: "who hasn't replied?"
 * Expected: Tom's follow-up is marked resolved, queue shrinks by 1.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function loadEnv(): void {
  const envPath = resolve(__dirname, "../.env");
  let raw: string;
  try { raw = readFileSync(envPath, "utf-8"); } catch { return; }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

async function getAccessToken(): Promise<string> {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = process.env;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google credentials in .env");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${await resp.text()}`);
  return ((await resp.json()) as { access_token: string }).access_token;
}

async function getMyEmail(token: string): Promise<string> {
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Profile fetch failed: ${resp.status}`);
  return ((await resp.json()) as { emailAddress: string }).emailAddress;
}

async function findMessageBySubject(token: string, subject: string): Promise<{ id: string; threadId: string } | null> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: `subject:"${subject}"`, maxResults: "1" })}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { messages?: { id: string; threadId: string }[] };
  return data.messages?.[0] ?? null;
}

async function getMessageIdHeader(token: string, gmailMsgId: string): Promise<string | null> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMsgId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Message-Id`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { payload?: { headers?: { name: string; value: string }[] } };
  return data.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id")?.value ?? null;
}

function rfc2822(date: Date): string {
  return date.toUTCString().replace("GMT", "+0000");
}

function toBase64Url(s: string): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function insertEmail(token: string, raw: string, date: Date, labels: string[]): Promise<void> {
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: toBase64Url(raw), internalDate: String(date.getTime()), labelIds: labels }),
  });
  if (!resp.ok) throw new Error(`Insert failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
}

async function main(): Promise<void> {
  console.log("🔐 Authenticating…");
  const token = await getAccessToken();
  const myEmail = process.env.GOOGLE_USER_EMAIL ?? await getMyEmail(token);

  const ORIGINAL_SUBJECT = "Contract renewal terms - any questions?";

  console.log(`🔍 Looking for sent email: "${ORIGINAL_SUBJECT}"…`);
  const original = await findMessageBySubject(token, ORIGINAL_SUBJECT);
  if (!original) {
    console.error("✗  Original email not found in Gmail. Did you run seed-gmail.ts first?");
    process.exit(1);
  }

  const msgId = await getMessageIdHeader(token, original.id);
  if (!msgId) {
    console.error("✗  Could not read Message-ID from original email. Cannot thread reply.");
    process.exit(1);
  }

  console.log(`✓  Found original (threadId=${original.threadId})`);
  console.log(`✓  Message-ID: ${msgId}`);

  // Check if reply already exists
  const existing = await findMessageBySubject(token, `Re: ${ORIGINAL_SUBJECT}`);
  if (existing) {
    console.log("ℹ  Reply already exists in Gmail — skipping insert.");
    console.log('\nNow say "who hasn\'t replied?" in the chat to trigger auto-resolve.');
    return;
  }

  const date = new Date();
  const encodedBody = Buffer.from(
    `Hi,

Sorry for the delay — I've reviewed the contract renewal and everything looks good.
Happy to sign this week. Can you send me the final version?

Thanks,
Tom Bradley`,
    "utf-8"
  ).toString("base64").replace(/(.{76})/g, "$1\r\n");

  const raw = [
    `From: Tom Bradley <tom.bradley@example.com>`,
    `To: ${myEmail}`,
    `Subject: Re: ${ORIGINAL_SUBJECT}`,
    `Date: ${rfc2822(date)}`,
    `In-Reply-To: ${msgId}`,
    `References: ${msgId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    "",
    encodedBody,
  ].join("\r\n");

  await insertEmail(token, raw, date, ["INBOX", "UNREAD"]);
  console.log("✓  Tom's reply injected into your INBOX.");
  console.log('\n→ Now say "who hasn\'t replied?" in the chat.');
  console.log("  Expected: Tom\'s follow-up resolved, queue shrinks by 1.");
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
