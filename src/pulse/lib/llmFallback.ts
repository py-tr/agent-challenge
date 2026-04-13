/**
 * src/pulse/lib/llmFallback.ts
 *
 * Prefers local Ollama for speed/reliability; falls back to the Nosana/primary
 * model via ElizaOS runtime when Ollama is unavailable.
 *
 * Priority:
 *   1. Ollama (local, fast)
 *   2. Nosana/primary via runtime.useModel() (fallback)
 *
 * Configure via .env:
 *   OLLAMA_BASE_URL       — default: http://localhost:11434/v1
 *   OLLAMA_MODEL          — default: qwen2.5:14b
 */

import { ModelType, type IAgentRuntime } from "@elizaos/core";
import { recordLlmCall } from "./nosanaMetrics.js";

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:14b";
const SKIP_OLLAMA = process.env.SKIP_OLLAMA === "true";

export interface LlmParams {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

// ── Ollama direct call ──────────────────────────────────────────────────────

async function ollamaCompletion(params: LlmParams): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model:       OLLAMA_MODEL,
      messages:    [{ role: "user", content: params.prompt }],
      max_tokens:  params.maxTokens  ?? 512,
      temperature: params.temperature ?? 0.7,
      stream:      false,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

  interface OllamaResponse {
    choices: Array<{ message: { content: string } }>;
  }
  const data = (await res.json()) as OllamaResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("Ollama returned empty response");
  return text;
}

// ── Public helper ───────────────────────────────────────────────────────────

/**
 * Try local Ollama first (fast, reliable).
 * Falls back to the Nosana/primary model via ElizaOS runtime if Ollama is
 * unavailable (not running, connection refused, etc.).
 */
export async function useModelWithFallback(
  runtime: IAgentRuntime,
  modelType: (typeof ModelType)[keyof typeof ModelType],
  params: LlmParams
): Promise<string> {
  // ── Attempt 1: local Ollama (skipped if SKIP_OLLAMA=true) ──
  if (!SKIP_OLLAMA) {
    try {
      const t0 = Date.now();
      const result = await ollamaCompletion(params);
      recordLlmCall(Date.now() - t0, result.length);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[Pulse:LLM] Ollama unavailable (${msg.slice(0, 80)}), falling back to Nosana`);
    }
  }

  // ── Attempt 2: Nosana/primary via runtime ──
  try {
    const raw = await runtime.useModel(modelType, params);
    const result = typeof raw === "string" ? raw : String(raw ?? "");
    if (result.trim()) return result;
    throw new Error("empty response from primary");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[Pulse:LLM] Both Ollama and primary failed. Last error: ${msg}`);
  }
}
