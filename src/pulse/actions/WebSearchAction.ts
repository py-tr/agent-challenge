/**
 * src/pulse/actions/WebSearchAction.ts
 * ElizaOS Action — web search via DuckDuckGo Instant Answer API.
 *
 * Why DuckDuckGo instead of a paid plugin:
 *   - Zero API keys required — works immediately on any Nosana node
 *   - Native ElizaOS Action pattern — demonstrates architecture understanding
 *   - DDG Instant Answer API is free and covers factual queries, Wikipedia
 *     summaries, calculations, conversions, and related-topic results
 *
 * Trigger phrases detected in validate():
 *   "search for X", "look up X", "find X", "web search X",
 *   "what is X", "who is X", "when did X", "how does X",
 *   "tell me about X", "google X"
 *
 * Flow:
 *   1. validate() detects search intent
 *   2. handler() extracts the search query from the message
 *   3. Queries api.duckduckgo.com for instant answers + related results
 *   4. Streams formatted results back via callback
 *   5. Returns ActionResult with the search findings
 *
 * DuckDuckGo API reference:
 *   https://duckduckgo.com/duckduckgo-help-pages/settings/params/
 *   GET https://api.duckduckgo.com/?q=QUERY&format=json&no_html=1&skip_disambig=1
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from "@elizaos/core";

// ─── DDG API types ────────────────────────────────────────────────────────────

interface DdgTopic {
  Text: string;
  FirstURL: string;
  Icon?: { URL?: string };
}

interface DdgResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Answer?: string;
  AnswerType?: string;
  Image?: string;
  Results?: DdgTopic[];
  RelatedTopics?: (DdgTopic | { Name: string; Topics: DdgTopic[] })[];
  Type?: string; // "A" = Article, "D" = Disambiguation, "C" = Category, "" = nothing
}

interface SearchResult {
  title: string;
  url:   string;
  snippet: string;
}

// ─── Query extraction ─────────────────────────────────────────────────────────

const SEARCH_PREFIXES = [
  "search for ",
  "search ",
  "look up ",
  "look up",
  "web search ",
  "find information about ",
  "find ",
  "tell me about ",
  "google ",
] as const;

const QUESTION_PREFIXES = [
  "what is ",
  "what are ",
  "who is ",
  "who was ",
  "when did ",
  "when was ",
  "where is ",
  "where was ",
  "how does ",
  "how did ",
  "why is ",
  "why did ",
] as const;

function extractSearchQuery(text: string): string {
  const t = text.trim();
  const lower = t.toLowerCase();

  // Strip common search prefixes
  for (const prefix of SEARCH_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return t.slice(prefix.length).replace(/\?$/, "").trim();
    }
  }

  // For question-style queries, use the full text as the search query
  for (const prefix of QUESTION_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return t.replace(/\?$/, "").trim();
    }
  }

  // Fallback: use full text
  return t.replace(/\?$/, "").trim();
}

// ─── Trigger detection ────────────────────────────────────────────────────────

function isWebSearchRequest(text: string): boolean {
  if (!text || text.length < 5) return false;
  const t = text.toLowerCase();

  const hasSearchIntent = SEARCH_PREFIXES.some((p) => t.includes(p));
  const isQuestion = QUESTION_PREFIXES.some((p) => t.startsWith(p));

  return hasSearchIntent || isQuestion;
}

// ─── DuckDuckGo search ────────────────────────────────────────────────────────

async function duckDuckGoSearch(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q:             query,
    format:        "json",
    no_html:       "1",
    skip_disambig: "1",
  });

  const resp = await fetch(`https://api.duckduckgo.com/?${params.toString()}`, {
    headers: {
      "User-Agent":
        "Pulse/1.0 ElizaOS-Agent (Nosana GPU; +github.com/nosana-ci/agent-challenge)",
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!resp.ok) {
    throw new Error(`DuckDuckGo API responded with ${resp.status}`);
  }

  const data = (await resp.json()) as DdgResponse;
  const results: SearchResult[] = [];

  // 1. Direct instant answer (math, conversions, factual lookups)
  if (data.Answer) {
    results.push({
      title:   "Direct Answer",
      url:     "",
      snippet: data.Answer,
    });
  }

  // 2. Knowledge-panel abstract (Wikipedia / other knowledge source)
  if (data.AbstractText) {
    const source = data.AbstractSource ? `${data.AbstractSource}` : "Summary";
    results.push({
      title:   `${source}: ${data.Heading ?? query}`,
      url:     data.AbstractURL ?? "",
      snippet: data.AbstractText.length > 400
        ? data.AbstractText.slice(0, 397) + "…"
        : data.AbstractText,
    });
  }

  // 3. Direct web results
  for (const r of data.Results ?? []) {
    if (results.length >= 5) break;
    if (r.Text && r.FirstURL) {
      results.push({
        title:   r.Text.slice(0, 100),
        url:     r.FirstURL,
        snippet: r.Text,
      });
    }
  }

  // 4. Related topics (the bulk of web results for general queries)
  const flatTopics: DdgTopic[] = [];
  for (const item of data.RelatedTopics ?? []) {
    if ("Topics" in item) {
      flatTopics.push(...item.Topics);
    } else {
      flatTopics.push(item as DdgTopic);
    }
  }

  for (const t of flatTopics) {
    if (results.length >= 6) break;
    if (t.Text && t.FirstURL && !t.FirstURL.includes("duckduckgo.com")) {
      results.push({
        title:   t.Text.slice(0, 100),
        url:     t.FirstURL,
        snippet: t.Text.length > 300 ? t.Text.slice(0, 297) + "…" : t.Text,
      });
    }
  }

  return results.slice(0, 5);
}

// ─── Format results as markdown ───────────────────────────────────────────────

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return (
      `No results found for **"${query}"** via DuckDuckGo. ` +
      `Try rephrasing or being more specific.`
    );
  }

  const lines: string[] = [
    `**Search results for "${query}"** (via DuckDuckGo)\n`,
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`**${i + 1}. ${r.title}**`);
    if (r.url) lines.push(`   ${r.url}`);
    lines.push(`   ${r.snippet}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ─── Action definition ────────────────────────────────────────────────────────

export const webSearchAction: Action = {
  name: "WEB_SEARCH",

  description:
    "Search the web for up-to-date information using DuckDuckGo Instant Answers. " +
    "Returns summaries, Wikipedia abstracts, direct answers, and related results. " +
    "No API key required — runs directly on the Nosana node.",

  similes: [
    "SEARCH_WEB",
    "DUCKDUCKGO",
    "WEB_LOOKUP",
    "FIND_ONLINE",
    "SEARCH_INTERNET",
    "INTERNET_SEARCH",
    "LOOK_UP",
  ],

  examples: [
    [
      { name: "user", content: { text: "Search for Nosana network status" } },
      {
        name: "Pulse",
        content: {
          text: "Searching DuckDuckGo for 'Nosana network status'…",
        },
      },
    ],
    [
      { name: "user", content: { text: "What is the Qwen3.5 model?" } },
      {
        name: "Pulse",
        content: {
          text: "Let me look that up via DuckDuckGo…",
        },
      },
    ],
  ],

  // ── Validate ────────────────────────────────────────────────────────────────

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const text = typeof message.content === "string"
      ? message.content
      : (message.content as { text?: string })?.text ?? "";
    return isWebSearchRequest(text);
  },

  // ── Handler ─────────────────────────────────────────────────────────────────

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

    // Immediate acknowledgement so the user sees activity
    await callback?.({
      text: `Searching DuckDuckGo for **"${query}"**…`,
    });

    try {
      const results = await duckDuckGoSearch(query);
      const formatted = formatResults(query, results);

      await callback?.({ text: formatted });
      return { success: true, data: { query, resultCount: results.length } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pulse:WebSearch] DuckDuckGo search failed: ${msg}`);

      await callback?.({
        text:
          `Web search temporarily unavailable (${msg}). ` +
          `Please try again in a moment.`,
      });
      return { success: false, error: msg };
    }
  },
};
