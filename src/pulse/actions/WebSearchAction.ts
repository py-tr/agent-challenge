/**
 * src/pulse/actions/WebSearchAction.ts
 * ElizaOS Action — multi-source web search with no API keys required.
 *
 * Source routing:
 *   1. Weather queries  → wttr.in (real-time, structured JSON)
 *   2. General queries  → DDG Instant Answer API (Wikipedia/factual)
 *                         → DDG HTML scrape fallback (live web snippets)
 *
 * All sources use AbortController + manual setTimeout for timeout
 * (AbortSignal.timeout() requires Node ≥ 17.3, not guaranteed on Nosana).
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from "@elizaos/core";

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface SearchResult {
  title:   string;
  url:     string;
  snippet: string;
}

function timedFetch(url: string, init: RequestInit, ms = 8_000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(id));
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ─── Weather via wttr.in ──────────────────────────────────────────────────────

const WEATHER_RE = /weather|forecast|temperature|rain|sunny|celsius|fahrenheit|hot|cold|wind|humidity/i;

interface WttrCondition {
  temp_C: string;
  FeelsLikeC: string;
  humidity: string;
  windspeedKmph: string;
  weatherDesc: { value: string }[];
}

interface WttrDay {
  date: string;
  maxtempC: string;
  mintempC: string;
  avgtempC: string;
  hourly: { weatherDesc: { value: string }[]; time: string }[];
}

interface WttrResponse {
  current_condition: WttrCondition[];
  weather: WttrDay[];
  nearest_area?: { areaName: { value: string }[]; country: { value: string }[] }[];
}

function extractCity(query: string): string {
  // Stop at comma/punctuation so "in Prague, and tell me..." extracts just "Prague"
  const match = query.match(
    /(?:in|for|at)\s+([A-Za-z][a-zA-Z\s]{1,30}?)(?=[,!?]|\s+(?:tomorrow|today|this\s+week|next\s+week|on\s+\w|and\b)|$)/i
  );
  return match?.[1]?.trim() || "London";
}

function dayLabel(date: string): string {
  try {
    return new Date(date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return date;
  }
}

async function weatherSearch(query: string): Promise<SearchResult[]> {
  const city = extractCity(query);
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
  const resp = await timedFetch(url, {
    headers: { "User-Agent": "Pulse/1.0 ElizaOS-Agent", "Accept": "application/json" },
  });
  if (!resp.ok) throw new Error(`wttr.in responded with ${resp.status}`);

  const data = (await resp.json()) as WttrResponse;
  const cur = data.current_condition?.[0];
  const area = data.nearest_area?.[0];
  const location = area
    ? `${area.areaName[0]?.value ?? city}, ${area.country[0]?.value ?? ""}`
    : city;

  const results: SearchResult[] = [];

  if (cur) {
    results.push({
      title:   `Current weather in ${location}`,
      url:     `https://wttr.in/${encodeURIComponent(city)}`,
      snippet: `${cur.weatherDesc[0]?.value ?? ""}. ${cur.temp_C}°C (feels like ${cur.FeelsLikeC}°C). Humidity ${cur.humidity}%. Wind ${cur.windspeedKmph} km/h.`,
    });
  }

  // Next 3 days forecast
  for (const day of (data.weather ?? []).slice(0, 3)) {
    const desc = day.hourly?.[4]?.weatherDesc?.[0]?.value ?? day.hourly?.[0]?.weatherDesc?.[0]?.value ?? "";
    results.push({
      title:   dayLabel(day.date),
      url:     "",
      snippet: `${desc}. High ${day.maxtempC}°C / Low ${day.mintempC}°C (avg ${day.avgtempC}°C).`,
    });
  }

  return results;
}

// ─── DDG Instant Answer API ───────────────────────────────────────────────────

interface DdgTopic {
  Text: string;
  FirstURL: string;
}

interface DdgResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Answer?: string;
  Results?: DdgTopic[];
  RelatedTopics?: (DdgTopic | { Name: string; Topics: DdgTopic[] })[];
}

async function ddgInstantSearch(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: "json", no_html: "1", skip_disambig: "1" });
  const resp = await timedFetch(`https://api.duckduckgo.com/?${params}`, {
    headers: { "User-Agent": "Pulse/1.0 ElizaOS-Agent", "Accept": "application/json" },
  });
  if (!resp.ok) throw new Error(`DDG API ${resp.status}`);

  const data = (await resp.json()) as DdgResponse;
  const results: SearchResult[] = [];

  if (data.Answer) {
    results.push({ title: "Direct Answer", url: "", snippet: data.Answer });
  }
  if (data.AbstractText) {
    const src = data.AbstractSource ?? "Summary";
    results.push({
      title:   `${src}: ${data.Heading ?? query}`,
      url:     data.AbstractURL ?? "",
      snippet: data.AbstractText.length > 400 ? data.AbstractText.slice(0, 397) + "…" : data.AbstractText,
    });
  }
  for (const r of data.Results ?? []) {
    if (results.length >= 5) break;
    if (r.Text && r.FirstURL) results.push({ title: r.Text.slice(0, 100), url: r.FirstURL, snippet: r.Text });
  }

  const flatTopics: DdgTopic[] = [];
  for (const item of data.RelatedTopics ?? []) {
    if ("Topics" in item) flatTopics.push(...(item as { Topics: DdgTopic[] }).Topics);
    else flatTopics.push(item as DdgTopic);
  }
  for (const t of flatTopics) {
    if (results.length >= 5) break;
    if (t.Text && t.FirstURL && !t.FirstURL.includes("duckduckgo.com")) {
      results.push({
        title:   t.Text.slice(0, 100),
        url:     t.FirstURL,
        snippet: t.Text.length > 300 ? t.Text.slice(0, 297) + "…" : t.Text,
      });
    }
  }

  return results;
}

// ─── DDG HTML scrape fallback ─────────────────────────────────────────────────

async function ddgHtmlSearch(query: string): Promise<SearchResult[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await timedFetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Pulse/1.0)",
      "Accept": "text/html",
    },
  });
  if (!resp.ok) throw new Error(`DDG HTML ${resp.status}`);

  const html = await resp.text();
  const results: SearchResult[] = [];

  // Extract result snippets: <a class="result__snippet">...</a>
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  // Extract result titles: <a class="result__a">...</a>
  const titleRe   = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: { url: string; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) && titles.length < 5) {
    titles.push({ url: m[1], text: decodeHtmlEntities(m[2].replace(/<[^>]+>/g, "").trim()) });
  }

  let i = 0;
  while ((m = snippetRe.exec(html)) && results.length < 3) {
    const snippet = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, "").trim());
    if (snippet.length > 20) {
      results.push({
        title:   titles[i]?.text ?? `Result ${i + 1}`,
        url:     titles[i]?.url ?? "",
        snippet,
      });
    }
    i++;
  }

  return results;
}

// ─── Routing + formatting ─────────────────────────────────────────────────────

async function search(query: string): Promise<SearchResult[]> {
  if (WEATHER_RE.test(query)) {
    return weatherSearch(query);
  }

  // Try DDG Instant Answer first; fall through to HTML scrape if 0 results
  const instant = await ddgInstantSearch(query);
  if (instant.length > 0) return instant;
  return ddgHtmlSearch(query);
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No results found for "${query}". Try rephrasing or being more specific.`;
  }

  const lines: string[] = [];
  for (const r of results) {
    lines.push(r.title ? `${r.title}: ${r.snippet}` : r.snippet);
  }
  return lines.join("\n");
}

// ─── Query extraction ─────────────────────────────────────────────────────────

const SEARCH_PREFIXES = [
  "search for ", "search ", "look up ", "web search ",
  "find information about ", "find ", "tell me about ", "google ",
] as const;

const QUESTION_PREFIXES = [
  "what is ", "what are ", "who is ", "who was ",
  "when did ", "when was ", "where is ", "where was ",
  "how does ", "how did ", "why is ", "why did ",
] as const;

function extractSearchQuery(text: string): string {
  const t = text.trim();
  const lower = t.toLowerCase();
  for (const p of SEARCH_PREFIXES) {
    if (lower.startsWith(p)) return t.slice(p.length).replace(/\?$/, "").trim();
  }
  for (const p of QUESTION_PREFIXES) {
    if (lower.startsWith(p)) return t.replace(/\?$/, "").trim();
  }
  return t.replace(/\?$/, "").trim();
}

// ─── Action definition ────────────────────────────────────────────────────────

export const webSearchAction: Action = {
  name: "WEB_SEARCH",

  description:
    "Search the web for current information. Routes weather queries to wttr.in (real-time), " +
    "factual queries to DuckDuckGo Instant Answers, and falls back to DuckDuckGo HTML scraping " +
    "for live web results. No API keys required — runs on any Nosana node.",

  similes: [
    "SEARCH",
    "SEARCH_WEB",
    "LOOK_UP",
    "FIND_INFORMATION",
    "GET_CURRENT_INFO",
    "RESEARCH",
    "CHECK_FACTS",
  ],

  examples: [
    [
      { name: "user", content: { text: "What's the weather in Prague tomorrow?" } },
      { name: "Pulse", content: { text: "[searches wttr.in] Partly cloudy, 14°C high. Light rain in the afternoon." } },
    ],
    [
      { name: "user", content: { text: "Search for Nosana network" } },
      { name: "Pulse", content: { text: "[searches web] Nosana is a decentralized GPU compute network on Solana…" } },
    ],
  ],

  validate: async (): Promise<boolean> => true,

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const rawText = typeof message.content === "string"
      ? message.content
      : (message.content as { text?: string })?.text ?? "";

    const query = extractSearchQuery(rawText);

    try {
      const results = await search(query);
      const formatted = formatResults(query, results);

      await callback?.({ text: formatted });
      return { success: true, text: formatted, data: { query, resultCount: results.length } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errText = `Web search unavailable (${msg}). Try again in a moment.`;
      await callback?.({ text: errText });
      return { success: false, text: errText, error: msg };
    }
  },
};
