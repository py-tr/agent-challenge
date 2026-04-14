import type { StatusResponse, NosanaMetrics } from "../api/pulseApi";

interface Props {
  status: StatusResponse | null;
  lastUpdated: Date | null;
  error: string | null;
  onRefresh: () => void;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  if (diff < 60_000) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function shortNodeId(nodeId: string | null): string {
  if (!nodeId) return "local";
  return nodeId.length > 12 ? nodeId.slice(0, 8) + "…" + nodeId.slice(-4) : nodeId;
}

// ─── Nosana Badge ─────────────────────────────────────────────────────────────

function NosanaBadge({ nosana }: { nosana: NosanaMetrics }) {
  if (!nosana.isNosanaNode) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5">
        <span className="h-2 w-2 rounded-full bg-gray-300" />
        <span className="text-xs text-gray-500">Local dev</span>
        <span className="text-gray-300">·</span>
        <span className="text-xs text-gray-400">{nosana.llmCallCount} LLM calls</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {/* Prominent Nosana chip */}
      <div
        title={`Nosana GPU node: ${nosana.nodeId ?? "unknown"}`}
        className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5"
      >
        {/* Pulsing green dot */}
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
        </span>
        <span className="text-sm font-semibold text-green-800">Running on Nosana GPU</span>
      </div>

      {/* Secondary stats */}
      <div className="hidden items-center gap-2 text-xs text-gray-400 sm:flex">
        <span className="tabular-nums font-medium text-gray-600">{nosana.llmCallCount}</span>
        <span>inferences</span>
        <span className="text-gray-300">·</span>
        <span>up {formatUptime(nosana.uptimeMs)}</span>
        <span className="text-gray-300">·</span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-500">
          {nosana.jobType}
        </span>
      </div>
    </div>
  );
}

// ─── Status Bar ───────────────────────────────────────────────────────────────

export function StatusBar({ status, lastUpdated, error, onRefresh }: Props) {
  const pending  = status?.queue.pending  ?? 0;
  const approved = status?.queue.approved ?? 0;
  const rejected = status?.queue.rejected ?? 0;
  const nosana   = status?.nosana;

  return (
    <header className="sticky top-0 z-10 border-b border-gray-200 bg-white shadow-sm">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">

        {/* ── Left: brand + Nosana badge ──────────────────────────────────── */}
        <div className="flex items-center gap-5">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-2xl font-bold tracking-tight text-gray-900">Pulse</span>
              <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                Chief of Staff
              </span>
            </div>
            <p className="mt-0.5 text-xs text-gray-400 leading-snug">
              Monitors inbox and calendar · waits for your approval before acting
            </p>
          </div>

          {nosana && <NosanaBadge nosana={nosana} />}
        </div>

        {/* ── Right: pending badge + stats + refresh ──────────────────────── */}
        <div className="flex shrink-0 items-center gap-4">
          {/* Large indigo pending count */}
          <div className="flex items-center gap-2">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold tabular-nums transition-colors ${
                pending > 0
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              {pending}
            </div>
            <span className="hidden text-xs text-gray-500 sm:block">pending</span>
          </div>

          <div className="h-6 w-px bg-gray-200" />

          <div className="hidden items-center gap-3 text-xs sm:flex">
            <Stat label="Approved" value={approved} />
            <span className="text-gray-200">·</span>
            <Stat label="Rejected" value={rejected} />
          </div>

          {lastUpdated && (
            <span className="hidden text-xs text-gray-400 lg:block">
              {timeAgo(lastUpdated.toISOString())}
            </span>
          )}

          <button
            onClick={onRefresh}
            className="rounded-lg border border-gray-200 p-1.5 text-gray-400 transition-colors hover:border-gray-300 hover:text-gray-600 active:scale-95"
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {error && (
        <div className="border-t border-red-200 bg-red-50 px-6 py-2 text-xs text-red-600">
          Connection error: {error} — retrying every 5s
        </div>
      )}
    </header>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-gray-600">
      <span className="font-semibold tabular-nums text-gray-800">{value}</span>
      {" "}{label}
    </span>
  );
}

function RefreshIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}
