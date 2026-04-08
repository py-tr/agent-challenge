/**
 * src/pulse/lib/nosanaMetrics.ts
 * Lightweight singleton that tracks runtime metrics for the Nosana GPU panel.
 *
 * Deliberately a plain module (not an ElizaOS Service) so it can be imported
 * by the model handlers in pulse/index.ts without creating a circular dep
 * through the service registry.
 *
 * Consumers:
 *   - pulse/index.ts model handlers: call recordLlmCall() after each inference
 *   - pulse/routes/pulseRoutes.ts GET /status: reads getMetrics()
 */

const _startTime = Date.now();
let _llmCallCount = 0;

// ─── Recording ────────────────────────────────────────────────────────────────

/** Increment the LLM call counter.  Called once per successful inference. */
export function recordLlmCall(): void {
  _llmCallCount++;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface NosanaMetrics {
  /** Nosana GPU node identifier extracted from OPENAI_API_URL, or null. */
  nodeId: string | null;
  /** Full Nosana node URL (without /v1 suffix), or null when running locally. */
  nodeUrl: string | null;
  /** True when OPENAI_API_URL points to a .nos.ci node. */
  isNosanaNode: boolean;
  /** How many LLM completions have been routed through this agent since start. */
  llmCallCount: number;
  /** Agent process uptime in milliseconds. */
  uptimeMs: number;
  /** Value of PULSE_JOB_TYPE env var (morning | evening | scheduled). */
  jobType: string;
  /** ISO timestamp of agent startup. */
  startedAt: string;
}

/** Read the current snapshot — pure, no side effects. */
export function getMetrics(): NosanaMetrics {
  const apiUrl = process.env.OPENAI_API_URL ?? "";

  // URL format on Nosana: https://<nodeId>.node.k8s.prd.nos.ci/v1
  const nodeMatch = apiUrl.match(/https?:\/\/([^.]+)\.node\./);
  const nodeId = nodeMatch?.[1] ?? null;
  const isNosanaNode =
    apiUrl.includes(".nos.ci") || apiUrl.includes("nosana");

  const nodeUrl = isNosanaNode && apiUrl
    ? apiUrl.replace(/\/v1\/?$/, "")
    : null;

  return {
    nodeId,
    nodeUrl,
    isNosanaNode,
    llmCallCount: _llmCallCount,
    uptimeMs: Date.now() - _startTime,
    jobType: process.env.PULSE_JOB_TYPE ?? "scheduled",
    startedAt: new Date(_startTime).toISOString(),
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
