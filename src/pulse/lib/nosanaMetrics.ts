/**
 * src/pulse/lib/nosanaMetrics.ts
 * Lightweight singleton that tracks runtime metrics for the Nosana GPU panel.
 *
 * Deliberately a plain module (not an ElizaOS Service) so it can be imported
 * by the model handlers in pulse/index.ts without creating a circular dep
 * through the service registry.
 *
 * Consumers:
 *   - pulse/index.ts model handlers: call recordLlmCall(durationMs) after each inference
 *   - pulse/routes/pulseRoutes.ts GET /status: reads getMetrics()
 *
 * Security:
 *   - Only the model NAME is surfaced (e.g. "Qwen3.5-27B-AWQ-4bit"), never the
 *     API key or full endpoint URL — those remain server-side only.
 *   - nodeId is extracted from the URL subdomain; the full URL is not exposed.
 */

const _startTime = Date.now();
let _llmCallCount = 0;

/**
 * Exponential moving average of inference latency.
 * α = 0.2 gives a smooth ~5-sample memory without storing history.
 * Null until the first call completes.
 */
const EMA_ALPHA = 0.2;
let _avgLatencyMs: number | null = null;

// ─── Recording ────────────────────────────────────────────────────────────────

/**
 * Record a completed inference.
 * @param durationMs Wall-clock time from request start to first token (ms).
 */
export function recordLlmCall(durationMs?: number): void {
  _llmCallCount++;
  if (durationMs != null && durationMs > 0) {
    _avgLatencyMs =
      _avgLatencyMs === null
        ? durationMs
        : EMA_ALPHA * durationMs + (1 - EMA_ALPHA) * _avgLatencyMs;
  }
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface NosanaMetrics {
  /** Nosana GPU node identifier extracted from OPENAI_API_URL subdomain, or null. */
  nodeId: string | null;
  /** True when OPENAI_API_URL points to a Nosana .nos.ci node. */
  isNosanaNode: boolean;
  /** How many LLM completions have been routed through this agent since start. */
  llmCallCount: number;
  /** Exponential moving average of inference latency in milliseconds, or null if no calls yet. */
  avgLatencyMs: number | null;
  /** Agent process uptime in milliseconds. */
  uptimeMs: number;
  /** Value of PULSE_JOB_TYPE env var (morning | evening | scheduled). */
  jobType: string;
  /** ISO timestamp of agent startup. */
  startedAt: string;
  /**
   * Display name of the active model — the model name string only
   * (e.g. "Qwen3.5-27B-AWQ-4bit"). API keys and endpoint URLs are
   * intentionally excluded from this object.
   */
  modelName: string | null;
}

/** Read the current snapshot — pure, no side effects. */
export function getMetrics(): NosanaMetrics {
  const apiUrl = process.env.OPENAI_API_URL ?? "";

  // Extract node ID from subdomain: https://<nodeId>.node.k8s.prd.nos.ci/v1
  const nodeMatch = apiUrl.match(/https?:\/\/([^.]+)\.node\./);
  const nodeId = nodeMatch?.[1] ?? null;
  const isNosanaNode =
    apiUrl.includes(".nos.ci") || apiUrl.includes("nosana");

  // Model name only — never the API key or full URL.
  const rawModelName =
    process.env.OPENAI_SMALL_MODEL ??
    process.env.SMALL_MODEL ??
    null;

  return {
    nodeId,
    isNosanaNode,
    llmCallCount:  _llmCallCount,
    avgLatencyMs:  _avgLatencyMs !== null ? Math.round(_avgLatencyMs) : null,
    uptimeMs:      Date.now() - _startTime,
    jobType:       process.env.PULSE_JOB_TYPE ?? "scheduled",
    startedAt:     new Date(_startTime).toISOString(),
    modelName:     rawModelName,
  };
}

/** Human-readable uptime string, e.g. "2h 15m" or "45s". */
export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}
