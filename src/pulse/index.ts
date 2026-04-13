/**
 * src/pulse/index.ts
 * Assembles all Pulse plugin components into the pulsePlugin object.
 *
 * Grows each day:
 *   Day 4: services (PulseBackgroundService)
 *   Day 5: actions (ProcessEmailsAction), model override (chat/completions)
 *   Day 6: evaluators (SlibGuardEvaluator)
 *   Day 7: actions (DetectConflictsAction), routes
 *   Day 9: providers, tests
 *
 * Model override (priority: 1 > plugin-openai's 0):
 *   @ai-sdk/openai v2 always routes openai.languageModel() to the Responses API
 *   (/v1/responses), which Nosana does not support. We register TEXT_SMALL and
 *   TEXT_LARGE handlers here that POST directly to /v1/chat/completions instead.
 */

import { ModelType, type IAgentRuntime, type Plugin } from "@elizaos/core";
import { PulseBackgroundService } from "./services/PulseBackgroundService.js";
import { GmailMcpService } from "./services/GmailMcpService.js";
import { CalendarMcpService } from "./services/CalendarMcpService.js";
import { MorningBriefingService } from "./services/MorningBriefingService.js";
import { DailySummaryService } from "./services/DailySummaryService.js";
import { processEmailsAction } from "./actions/ProcessEmailsAction.js";
import { detectConflictsAction } from "./actions/DetectConflictsAction.js";
import { detectFollowUpsAction } from "./actions/DetectFollowUpsAction.js";
import { webSearchAction } from "./actions/WebSearchAction.js";
import { createCalendarEventAction } from "./actions/CreateCalendarEventAction.js";
import { meetingPrepAction } from "./actions/MeetingPrepAction.js";
import { slibGuardEvaluator } from "./evaluators/SlibGuardEvaluator.js";
import { weatherContextEvaluator } from "./evaluators/WeatherContextEvaluator.js";
import { pulseRoutes } from "./routes/pulseRoutes.js";
import { actionQueueProvider } from "./providers/ActionQueueProvider.js";
import { decisionHistoryProvider } from "./providers/DecisionHistoryProvider.js";
import { webSearchProvider } from "./providers/WebSearchProvider.js";
import { recordLlmCall } from "./lib/nosanaMetrics.js";

// ─── Chat Completions Shim ────────────────────────────────────────────────────

/** Reads the base URL from the same env vars plugin-openai checks (in order). */
function getChatBaseUrl(): string {
  return (
    process.env.OPENAI_API_URL ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
}

interface ChatCompletionsParams {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
}

/**
 * Calls /v1/chat/completions directly — bypassing @ai-sdk/openai's
 * Responses-API default. Used for both TEXT_SMALL and TEXT_LARGE.
 */
async function callChatCompletions(
  runtime: IAgentRuntime,
  modelName: string,
  params: ChatCompletionsParams
): Promise<string> {
  const baseUrl = getChatBaseUrl();
  const apiKey = process.env.OPENAI_API_KEY ?? "nosana";

  // Build messages array: optional system prompt + user prompt.
  const messages: Array<{ role: string; content: string }> = [];
  if (runtime.character.system) {
    messages.push({ role: "system", content: runtime.character.system });
  }
  messages.push({ role: "user", content: params.prompt });

  const body: Record<string, unknown> = {
    model: modelName,
    messages,
    max_tokens: params.maxTokens ?? 8192,
    temperature: params.temperature ?? 0.7,
  };
  if (params.frequencyPenalty != null) body.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenalty  != null) body.presence_penalty  = params.presencePenalty;
  if (params.stopSequences?.length)    body.stop               = params.stopSequences;

  const requestStart = Date.now();

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[Pulse] Chat completions HTTP ${resp.status} for model=${modelName}: ${text.slice(0, 300)}`
    );
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const result = data.choices[0]?.message?.content;
  if (!result) {
    throw new Error(
      `[Pulse] Empty response from model=${modelName} (choices=${data.choices.length})`
    );
  }

  // Track every successful inference: count, latency, and response length for the GPU panel.
  recordLlmCall(Date.now() - requestStart, result.length);

  return result;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export const pulsePlugin: Plugin = {
  name: "pulse",
  description:
    "Pulse — Autonomous Chief of Staff. " +
    "Runs background processing on Nosana GPU, reads Gmail and Google Calendar via MCP, " +
    "tracks commitments with Slib Guard, and presents an action approval queue " +
    "for every proposed action. Nothing is auto-sent — the user decides.",

  /**
   * priority: 1 ensures our model handlers are chosen over plugin-openai (priority 0).
   * The runtime sorts handlers by priority DESC; first-registered wins ties.
   */
  priority: 1,

  // ── Model handlers — force /v1/chat/completions for Nosana compatibility ─────
  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params) => {
      const model =
        process.env.OPENAI_SMALL_MODEL ??
        process.env.SMALL_MODEL ??
        "Qwen3.5-27B-AWQ-4bit";
      return callChatCompletions(runtime, model, params as ChatCompletionsParams);
    },
    [ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params) => {
      const model =
        process.env.OPENAI_LARGE_MODEL ??
        process.env.LARGE_MODEL ??
        "Qwen3.5-27B-AWQ-4bit";
      return callChatCompletions(runtime, model, params as ChatCompletionsParams);
    },
    // No-op embedding handler — overrides plugin-openai (priority 0) which calls
    // /v1/embeddings, an endpoint Nosana nodes don't expose (returns 404).
    // Returns a 1536-dimensional zero vector so ElizaOS's ensureEmbeddingDimension
    // check passes without making any HTTP calls.
    [ModelType.TEXT_EMBEDDING]: async (_runtime: IAgentRuntime, _params) => {
      return new Array(1536).fill(0) as number[];
    },
  },

  // ── Services ────────────────────────────────────────────────────────────────
  // GmailMcpService: starts first — runs DB migrations + token refresh heartbeat.
  // CalendarMcpService: wraps calendarClient with caching.
  // PulseBackgroundService: owns the 6-hour scheduled processing cycle.
  // MorningBriefingService: fires once on startup after a 5-second delay.
  services: [GmailMcpService, CalendarMcpService, PulseBackgroundService, MorningBriefingService, DailySummaryService],

  // ── Actions ─────────────────────────────────────────────────────────────────
  // webSearchAction: DuckDuckGo Instant Answer — no API key, runs on Nosana node.
  actions: [processEmailsAction, detectConflictsAction, detectFollowUpsAction, meetingPrepAction, webSearchAction, createCalendarEventAction],

  // ── Providers ────────────────────────────────────────────────────────────────
  providers: [actionQueueProvider, decisionHistoryProvider, webSearchProvider],

  // ── Evaluators ───────────────────────────────────────────────────────────────
  evaluators: [slibGuardEvaluator, weatherContextEvaluator],

  // ── Routes ───────────────────────────────────────────────────────────────────
  routes: pulseRoutes,

  tests: [],
};

export default pulsePlugin;
