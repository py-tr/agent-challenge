/**
 * src/pulse/providers/WebSearchProvider.ts
 * Provider — detects search intent in the user's message, fetches real-time
 * data, and injects it into the LLM context BEFORE the response is generated.
 *
 * Routing:
 *   Weather intent → wttr.in/{city}?format=j1 (JSON, today + tomorrow forecast)
 *   General intent → DDG Instant Answer API   (Wikipedia/factual data)
 *   No intent      → returns ""               (provider is skipped)
 */

import type { Provider, ProviderResult, IAgentRuntime, Memory, State } from "@elizaos/core";

// ─── Intent detection ─────────────────────────────────────────────────────────

const SEARCH_INTENT_RE = /weather|forecast|temperature|rain|sunny|snow|wind|humidity|search|find|look up|what is|who is|current|today|tomorrow|latest|news|price|check/i;

const WEATHER_RE = /weather|forecast|temperature|rain|sunny|snow|wind|humidity/i;

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { result: string; ts: number }>();
const CACHE_TTL_MS = 60_000;

function getCached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.result;
}

function setCached(key: string, result: string): void {
  cache.set(key, { result, ts: Date.now() });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timedFetch(url: string, init: RequestInit, ms = 6_000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(id));
}

function extractCity(query: string): string {
  // Try: "weather/forecast in/for/at <City> [tomorrow|today|?]"
  const match = query.match(
    /(?:in|for|at)\s+([A-Z][a-zA-Z\s]+?)(?:\s+tomorrow|\s+today|\s+this week|\?|$)/i
  );
  return match?.[1]?.trim() || "London";
}

function extractMessageText(message: Memory): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { text?: string })?.text ?? "";
}

// ─── Weather fetch (wttr.in JSON) ─────────────────────────────────────────────

interface WttrHourly {
  weatherDesc: { value: string }[];
  time: string;
}

interface WttrDay {
  date: string;
  avgtempC: string;
  maxtempC: string;
  mintempC: string;
  hourly: WttrHourly[];
}

interface WttrCondition {
  temp_C: string;
  FeelsLikeC: string;
  weatherDesc: { value: string }[];
}

interface WttrResponse {
  current_condition?: WttrCondition[];
  weather?: WttrDay[];
  nearest_area?: { areaName: { value: string }[]; country: { value: string }[] }[];
}

async function fetchWeather(query: string): Promise<string> {
  const city = extractCity(query);
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
  try {
    const resp = await timedFetch(url, {
      headers: { "User-Agent": "Pulse/1.0 ElizaOS-Agent", Accept: "application/json" },
    });
    if (!resp.ok) return `Weather data unavailable (HTTP ${resp.status}).`;

    const data = (await resp.json()) as WttrResponse;

    const area = data.nearest_area?.[0];
    const location = area
      ? `${area.areaName[0]?.value ?? city}, ${area.country[0]?.value ?? ""}`
      : city;

    const parts: string[] = [];

    // Today (current conditions)
    const cur = data.current_condition?.[0];
    if (cur) {
      const desc = cur.weatherDesc[0]?.value ?? "";
      parts.push(`Current (${location}): ${desc}, ${cur.temp_C}°C (feels like ${cur.FeelsLikeC}°C)`);
    }

    // Tomorrow (index 1)
    const tomorrow = data.weather?.[1];
    if (tomorrow) {
      const desc = tomorrow.hourly?.[4]?.weatherDesc?.[0]?.value
        ?? tomorrow.hourly?.[0]?.weatherDesc?.[0]?.value
        ?? "";
      parts.push(`Tomorrow: ${desc}, avg ${tomorrow.avgtempC}°C (high ${tomorrow.maxtempC}°C / low ${tomorrow.mintempC}°C)`);
    }

    return parts.length > 0 ? parts.join(". ") : `No weather data for ${city}.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Weather fetch failed: ${msg}`;
  }
}

// ─── DDG Instant Answer fetch ─────────────────────────────────────────────────

interface DdgResponse {
  AbstractText?: string;
  AbstractSource?: string;
  Answer?: string;
  Heading?: string;
}

async function fetchDdgInstant(query: string): Promise<string> {
  const params = new URLSearchParams({ q: query, format: "json", no_html: "1", skip_disambig: "1" });
  try {
    const resp = await timedFetch(`https://api.duckduckgo.com/?${params}`, {
      headers: { "User-Agent": "Pulse/1.0 ElizaOS-Agent", Accept: "application/json" },
    });
    if (!resp.ok) return "No web results found.";

    const data = (await resp.json()) as DdgResponse;
    if (data.Answer) return data.Answer;
    if (data.AbstractText) {
      const src = data.AbstractSource ? ` (${data.AbstractSource})` : "";
      return `${data.Heading ? data.Heading + ": " : ""}${data.AbstractText}${src}`;
    }
    return "No web results found.";
  } catch {
    return "No web results found.";
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export const webSearchProvider: Provider = {
  name: "REALTIME_WEB_DATA",
  description:
    "Fetches real-time web data (weather, facts, news) and injects it into the LLM context " +
    "before the response is generated. Only activates when search intent is detected.",

  get: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const text = extractMessageText(message);

    if (!SEARCH_INTENT_RE.test(text)) {
      return { text: "" };
    }

    const cacheKey = text.toLowerCase().trim();
    const cached = getCached(cacheKey);
    if (cached) {
      return { text: `Real-time web data:\n${cached}\nUse this to answer accurately.` };
    }

    let result: string;
    if (WEATHER_RE.test(text)) {
      result = await fetchWeather(text);
    } else {
      result = await fetchDdgInstant(text);
    }

    if (!result || result === "No web results found.") {
      return { text: "" };
    }

    setCached(cacheKey, result);
    return { text: `Real-time web data:\n${result}\nUse this to answer accurately.` };
  },
};
