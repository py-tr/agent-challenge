import type { StatusResponse } from "../api/pulseApi";

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

export function StatusBar({ status, lastUpdated, error, onRefresh }: Props) {
  const pending = status?.queue.pending ?? 0;
  const approved = status?.queue.approved ?? 0;
  const rejected = status?.queue.rejected ?? 0;
  const gmailAt = status?.gmail.fetchedAt ?? null;
  const msgCount = status?.gmail.messageCount ?? 0;

  return (
    <header className="sticky top-0 z-10 border-b border-slate-800 bg-surface-1/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight text-white">
              ⚡ Pulse
            </span>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
              Chief of Staff
            </span>
          </div>

          {/* Live indicator */}
          <div className="flex items-center gap-1.5 rounded-full border border-emerald-900 bg-emerald-950/50 px-2.5 py-1">
            <span className="h-1.5 w-1.5 animate-pulse_dot rounded-full bg-emerald-400" />
            <span className="text-xs font-medium text-emerald-400">Live</span>
          </div>
        </div>

        {/* Center: Nosana GPU note */}
        {gmailAt && (
          <div className="hidden text-center text-xs text-slate-500 md:block">
            Processed{" "}
            <span className="font-medium text-slate-300">{msgCount} emails</span>{" "}
            on Nosana GPU ·{" "}
            <span className="font-medium text-slate-300">
              {timeAgo(gmailAt)}
            </span>
          </div>
        )}

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

      {/* Error banner */}
      {error && (
        <div className="border-t border-red-900 bg-red-950/60 px-6 py-2 text-xs text-red-300">
          ⚠ Connection error: {error} — retrying every 5s
        </div>
      )}
    </header>
  );
}

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
