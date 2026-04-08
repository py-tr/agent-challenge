import type { StatusResponse, NosanaMetrics } from "../api/pulseApi";

interface Props {
  status: StatusResponse | null;
  lastUpdated: Date | null;
  error: string | null;
  onRefresh: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// Abbreviate the 40-char Nosana node ID for display
function shortNodeId(nodeId: string | null): string {
  if (!nodeId) return "local";
  return nodeId.length > 12 ? nodeId.slice(0, 8) + "…" + nodeId.slice(-4) : nodeId;
}

// ─── Nosana GPU Panel ─────────────────────────────────────────────────────────

function NosanaPanel({ nosana }: { nosana: NosanaMetrics }) {
  if (!nosana.isNosanaNode) {
    // Running locally — show a muted "local dev" indicator
    return (
      <div className="flex items-center gap-2 text-xs text-slate-600">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
        <span>local dev</span>
        <span className="text-slate-700">·</span>
        <span>{nosana.llmCallCount} LLM calls</span>
        <span className="text-slate-700">·</span>
        <span>up {formatUptime(nosana.uptimeMs)}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {/* Nosana badge */}
      <a
        href={nosana.nodeUrl ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        title={`Nosana GPU node: ${nosana.nodeId}`}
        className="inline-flex items-center gap-1.5 rounded-full border border-violet-800 bg-violet-950/60 px-2.5 py-0.5 text-violet-300 transition-colors hover:border-violet-600 hover:text-violet-200"
      >
        {/* Animated GPU dot */}
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-400" />
        </span>
        <span className="font-medium">Nosana GPU</span>
      </a>

      {/* Node ID */}
      <span className="font-mono text-slate-500" title={nosana.nodeId ?? ""}>
        {shortNodeId(nosana.nodeId)}
      </span>

      <span className="hidden text-slate-700 sm:block">·</span>

      {/* LLM call counter */}
      <span className="hidden text-slate-400 sm:block">
        <span className="font-semibold tabular-nums text-slate-300">
          {nosana.llmCallCount}
        </span>
        {" "}inferences
      </span>

      <span className="hidden text-slate-700 sm:block">·</span>

      {/* Uptime */}
      <span className="hidden text-slate-500 sm:block">
        up {formatUptime(nosana.uptimeMs)}
      </span>

      <span className="hidden text-slate-700 sm:block">·</span>

      {/* Job type badge */}
      <span className="hidden rounded bg-slate-800 px-1.5 py-0.5 font-mono text-slate-400 sm:block">
        {nosana.jobType}
      </span>
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
    <header className="sticky top-0 z-10 border-b border-slate-800 bg-surface-1/90 backdrop-blur-sm">
      {/* ── Main row ─────────────────────────────────────────────────────── */}
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
        {/* Left: brand + live indicator */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight text-white">
              ⚡ Pulse
            </span>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
              Chief of Staff
            </span>
          </div>

          <div className="flex items-center gap-1.5 rounded-full border border-emerald-900 bg-emerald-950/50 px-2.5 py-1">
            <span className="h-1.5 w-1.5 animate-pulse_dot rounded-full bg-emerald-400" />
            <span className="text-xs font-medium text-emerald-400">Live</span>
          </div>
        </div>

        {/* Right: queue stats + refresh */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-xs">
            <Stat
              label="Pending"
              value={pending}
              color={pending > 0 ? "text-amber-400" : "text-slate-500"}
            />
            <Divider />
            <Stat label="Approved" value={approved} color="text-emerald-400" />
            <Divider />
            <Stat label="Rejected" value={rejected} color="text-slate-400" />
          </div>

          {lastUpdated && (
            <span className="hidden text-xs text-slate-600 sm:block">
              Updated {timeAgo(lastUpdated.toISOString())}
            </span>
          )}

          <button
            onClick={onRefresh}
            className="rounded-lg border border-slate-700 p-1.5 text-slate-400 transition-colors hover:border-slate-500 hover:text-white active:scale-95"
            title="Refresh"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Nosana GPU panel row ─────────────────────────────────────────── */}
      {nosana && (
        <div className="border-t border-slate-900 bg-black/20 px-6 py-1.5">
          <div className="mx-auto max-w-7xl">
            <NosanaPanel nosana={nosana} />
          </div>
        </div>
      )}

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {error && (
        <div className="border-t border-red-900 bg-red-950/60 px-6 py-2 text-xs text-red-300">
          ⚠ Connection error: {error} — retrying every 5s
        </div>
      )}
    </header>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
      <span className="text-slate-600">{label}</span>
    </div>
  );
}

function Divider() {
  return <span className="h-3 w-px bg-slate-700" />;
}
