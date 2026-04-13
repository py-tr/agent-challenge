/**
 * src/pulse/lib/authStore.ts
 *
 * Persists the Google OAuth refresh token to .eliza/pulse-auth.json so the
 * user only needs to complete the OAuth flow once. The stored value is used
 * as a fallback when GOOGLE_REFRESH_TOKEN is not set in the environment.
 *
 * Priority order in gmailClient / calendarClient:
 *   1. GOOGLE_REFRESH_TOKEN env var  (Nosana job definitions, CI)
 *   2. .eliza/pulse-auth.json        (set by the /pulse/auth/google/callback route)
 */

import { promises as fs } from "fs";
import path from "path";

const AUTH_FILE = path.resolve(".eliza", "pulse-auth.json");

interface AuthData {
  refreshToken: string;
  savedAt: string;
}

let _cached: AuthData | null | undefined = undefined; // undefined = not yet loaded

/** Returns the stored refresh token, or null if not saved yet. */
export async function getStoredRefreshToken(): Promise<string | null> {
  if (_cached !== undefined) return _cached?.refreshToken ?? null;
  try {
    const raw = await fs.readFile(AUTH_FILE, "utf-8");
    _cached = JSON.parse(raw) as AuthData;
    return _cached.refreshToken;
  } catch {
    _cached = null;
    return null;
  }
}

/** Saves a refresh token to disk and updates the in-memory cache. */
export async function saveRefreshToken(refreshToken: string): Promise<void> {
  const data: AuthData = { refreshToken, savedAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true });
  await fs.writeFile(AUTH_FILE, JSON.stringify(data, null, 2), "utf-8");
  _cached = data;
}

/** Returns true if credentials are configured (env var or stored file). */
export async function isGoogleAuthConfigured(): Promise<boolean> {
  if (process.env.GOOGLE_REFRESH_TOKEN) return true;
  const stored = await getStoredRefreshToken();
  return stored !== null;
}

/** Resolves the refresh token from env or stored file. Returns null if neither. */
export async function resolveRefreshToken(): Promise<string | null> {
  // Use || not ?? so that an empty-string env var falls through to the stored file.
  return process.env.GOOGLE_REFRESH_TOKEN || (await getStoredRefreshToken());
}
