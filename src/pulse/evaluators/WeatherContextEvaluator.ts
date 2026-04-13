/**
 * src/pulse/evaluators/WeatherContextEvaluator.ts
 *
 * Evaluator — runs after any response that contains weather data.
 * Extracts the city + forecast summary and stores it as a CUSTOM memory
 * so WebSearchProvider can inject it into follow-up questions without
 * re-fetching or using regex hacks.
 *
 * Flow:
 *   1. validate()  — only runs when the recent assistant output contains weather data
 *   2. handler()   — extracts city + forecast lines, writes to runtime memory (tableName: "facts")
 *
 * WebSearchProvider reads this fact on follow-up messages where no city is
 * present (e.g. "which day is best for golf?"), re-injecting the forecast
 * into LLM context so it can reason from real data.
 */

import type { Evaluator, IAgentRuntime, Memory, State } from "@elizaos/core";
import { MemoryType } from "@elizaos/core";

// Matches lines that look like weather output
const WEATHER_DATA_RE = /°C|°F|\bhumidity\b|\bwind\b.*km\/h/i;
const WEATHER_BLOCK_LINE_RE = /°C|°F|High|Low|Partly|Clear|Rain|Cloud|Sunny|Overcast|Drizzle|Snow|Fog|Mist|Patchy|humidity|wind/i;
const CITY_RE = /(?:current weather in|weather in)\s+([^:\n,]+)/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractWeatherBlock(text: string): { city: string; summary: string } | null {
  if (!WEATHER_DATA_RE.test(text)) return null;

  const cityMatch = text.match(CITY_RE);
  const city = cityMatch?.[1]?.trim() ?? "unknown";

  const lines = text.split(/\n/);
  const weatherLines = lines.filter(l => WEATHER_BLOCK_LINE_RE.test(l)).slice(0, 6);
  if (weatherLines.length === 0) return null;

  return { city, summary: weatherLines.join("\n") };
}

function recentAssistantText(state: State): string {
  // recentMessages is a formatted string in ElizaOS state
  const raw = state.recentMessages;
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw ?? "");
}

// ─── Evaluator ────────────────────────────────────────────────────────────────

export const weatherContextEvaluator: Evaluator = {
  name: "WEATHER_CONTEXT",
  description:
    "Stores weather forecast data from responses as fact memories. " +
    "Enables follow-up questions like 'which day is best for golf?' to be " +
    "answered from real fetched data rather than re-searching or hallucinating.",
  alwaysRun: false,

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State
  ): Promise<boolean> => {
    if (!state) return false;
    return WEATHER_DATA_RE.test(recentAssistantText(state));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<void> => {
    if (!state) return;

    const text = recentAssistantText(state);
    const block = extractWeatherBlock(text);
    if (!block) return;

    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        agentId:  runtime.agentId,
        roomId:   message.roomId,
        content: {
          text: `Weather context — ${block.city}:\n${block.summary}`,
          source: "weather-context-evaluator",
        },
        metadata: {
          type:      MemoryType.CUSTOM,
          source:    "weather-context-evaluator",
          scope:     "shared",
          city:      block.city,
          fetchedAt: Date.now(),
        },
      },
      "facts"
    );
  },

  examples: [],
};
