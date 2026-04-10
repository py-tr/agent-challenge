/**
 * src/pulse/providers/WebSearchProvider.ts
 * Provider — detects search intent in the user's message, fetches real-time
 * data, and injects it into the LLM context BEFORE the response is generated.
 *
 * Weather routing (tried in order, first success wins):
 *   1. wttr.in/{city}?format=j1     — rich JSON, current + forecast
 *   2. Open-Meteo geocoding + forecast API  — fallback, no API key
 *
 * General routing:
 *   DDG Instant Answer API — Wikipedia/factual data
 *
 * On total failure: injects an explicit "unavailable" message so the LLM
 * never hallucinates real-time data.
 */

import type { Provider, ProviderResult, IAgentRuntime, Memory, State } from "@elizaos/core";

// ─── Intent detection ─────────────────────────────────────────────────────────

const SEARCH_INTENT_RE = /weather|forecast|temperature|rain|sunny|snow|wind|humidity|search|find|look up|what is|who is|current|today|tomorrow|latest|news|price|check/i;

const WEATHER_RE = /weather|forecast|temperature|rain|sunny|snow|wind|humidity/i;

const SEARCH_UNAVAILABLE =
  "Web search unavailable on this node. Queue data is available — ask about your pending items instead.";

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

const FETCH_TIMEOUT_MS = process.env.NODE_ENV === "production" ? 15_000 : 8_000;

function timedFetch(url: string, init: RequestInit, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(id));
}

function extractCity(query: string): string {
  const match = query.match(
    /(?:in|for|at)\s+([A-Z][a-zA-Z\s]+?)(?:\s+tomorrow|\s+today|\s+this week|\?|$)/i
  );
  return match?.[1]?.trim() || "London";
}

function extractMessageText(message: Memory): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { text?: string })?.text ?? "";
}

// ─── Weather source 1: wttr.in ────────────────────────────────────────────────

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

async function fetchWeatherWttr(city: string): Promise<string | null> {
  try {
    const resp = await timedFetch(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1`,
      { headers: { "User-Agent": "Pulse/1.0 ElizaOS-Agent", Accept: "application/json" } }
    );
    if (!resp.ok) return null;

    const data = (await resp.json()) as WttrResponse;
    const area = data.nearest_area?.[0];
    const location = area
      ? `${area.areaName[0]?.value ?? city}, ${area.country[0]?.value ?? ""}`
      : city;

    const parts: string[] = [];
    const cur = data.current_condition?.[0];
    if (cur) {
      const desc = cur.weatherDesc[0]?.value ?? "";
      parts.push(`Current (${location}): ${desc}, ${cur.temp_C}°C (feels like ${cur.FeelsLikeC}°C)`);
    }
    const tomorrow = data.weather?.[1];
    if (tomorrow) {
      const desc = tomorrow.hourly?.[4]?.weatherDesc?.[0]?.value
        ?? tomorrow.hourly?.[0]?.weatherDesc?.[0]?.value
        ?? "";
      parts.push(`Tomorrow: ${desc}, avg ${tomorrow.avgtempC}°C (high ${tomorrow.maxtempC}°C / low ${tomorrow.mintempC}°C)`);
    }
    return parts.length > 0 ? parts.join(". ") : null;
  } catch {
    return null;
  }
}

// ─── Weather source 2: Open-Meteo (geocoding + forecast) ─────────────────────

interface GeoResult {
  latitude: number;
  longitude: number;
  name: string;
  country?: string;
}

interface GeoResponse {
  results?: GeoResult[];
}

interface OpenMeteoResponse {
  daily?: {
    time: string[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
    precipitation_probability_max: (number | null)[];
  };
}

async function fetchWeatherOpenMeteo(city: string): Promise<string | null> {
  try {
    // Step 1: geocode city → lat/lon
    const geoResp = await timedFetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
      { headers: { Accept: "application/json" } }
    );
    if (!geoResp.ok) return null;

    const geoData = (await geoResp.json()) as GeoResponse;
    const loc = geoData.results?.[0];
    if (!loc) return null;

    const locationLabel = loc.country ? `${loc.name}, ${loc.country}` : loc.name;

    // Step 2: fetch 2-day forecast
    const params = new URLSearchParams({
      latitude:  String(loc.latitude),
      longitude: String(loc.longitude),
      daily:     "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone:  "auto",
      forecast_days: "2",
    });
    const forecastResp = await timedFetch(
      `https://api.open-meteo.com/v1/forecast?${params}`,
      { headers: { Accept: "application/json" } }
    );
    if (!forecastResp.ok) return null;

    const forecast = (await forecastResp.json()) as OpenMeteoResponse;
    const daily = forecast.daily;
    if (!daily?.time?.length) return null;

    const parts: string[] = [];
    for (let i = 0; i < Math.min(2, daily.time.length); i++) {
      const label = i === 0 ? `Today (${locationLabel})` : "Tomorrow";
      const max  = daily.temperature_2m_max[i];
      const min  = daily.temperature_2m_min[i];
      const rain = daily.precipitation_probability_max[i];
      const tempStr = max != null && min != null ? `high ${max}°C / low ${min}°C` : "";
      const rainStr = rain != null ? `, ${rain}% chance of rain` : "";
      parts.push(`${label}: ${tempStr}${rainStr}`);
    }
    return parts.length > 0 ? parts.join(". ") : null;
  } catch {
    return null;
  }
}

// ─── Weather: try wttr.in, fall back to Open-Meteo ───────────────────────────

async function fetchWeather(query: string): Promise<string> {
  const city = extractCity(query);

  const wttr = await fetchWeatherWttr(city);
  if (wttr) return wttr;

  const openMeteo = await fetchWeatherOpenMeteo(city);
  if (openMeteo) return openMeteo;

  return SEARCH_UNAVAILABLE;
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
    if (!resp.ok) return SEARCH_UNAVAILABLE;

    const data = (await resp.json()) as DdgResponse;
    if (data.Answer) return data.Answer;
    if (data.AbstractText) {
      const src = data.AbstractSource ? ` (${data.AbstractSource})` : "";
      return `${data.Heading ? data.Heading + ": " : ""}${data.AbstractText}${src}`;
    }
    return SEARCH_UNAVAILABLE;
  } catch {
    return SEARCH_UNAVAILABLE;
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export const webSearchProvider: Provider = {
  name: "REALTIME_WEB_DATA",
  description:
    "Fetches real-time web data (weather, facts, news) and injects it into the LLM context " +
    "before the response is generated. Only activates when search intent is detected. " +
    "Weather: tries wttr.in first, falls back to Open-Meteo. Failure is explicit — never silent.",

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

    const result = WEATHER_RE.test(text)
      ? await fetchWeather(text)
      : await fetchDdgInstant(text);

    // Always cache — including the unavailable message, to avoid hammering dead endpoints.
    setCached(cacheKey, result);

    return { text: `Real-time web data:\n${result}\nUse this to answer accurately.` };
  },
};
