import type { DecisionsResponse, DecisionPattern, Decision } from "../api/pulseApi";

interface Props {
  data: DecisionsResponse | null;
  loading: boolean;
}

// Map itemType → short display label
const TYPE_LABEL: Record<string, string> = {
  email_draft:         "Email",
  conflict_resolution: "Conflict",
  slib_reminder:       "Commitment",
  follow_up:           "Follow-up",
};

const TYPE_BADGE: Record<string, string> = {
  email_draft:         "bg-blue-900/50 text-blue-300",
  conflict_resolution: "bg-red-900/50 text-red-300",
  slib_reminder:       "bg-amber-900/50 text-amber-300",
  follow_up:           "bg-purple-900/50 text-purple-300",
};

export function DecisionHistory({ data, loading }: Props) {
  const decisions = data?.decisions ?? [];
  const patterns = data?.patterns ?? [];
  const total = data?.total ?? 0;

  return (
    <aside className="flex flex-col gap-4">
      {/* Pattern summary — shown when 10+ decisions exist */}
      {total >= 10 && patterns.length > 0 && (
        <PatternSummary patterns={patterns} total={total} />
      )}

      {/* History panel */}
      <div className="overflow-hidden rounded-xl border border-slate-800 bg-surface-2">
        {/* Header with left accent bar */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-surface-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-4 w-0.5 rounded-full bg-slate-500" />
            <h2 className="text-sm font-semibold text-white">Decision History</h2>
          </div>
          {total > 0 && (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
              {total} total
            </span>
          )}
        </div>

        {loading ? (
          <div className="space-y-px p-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <div
                key={n}
                className="h-16 animate-pulse rounded-lg border border-slate-800/50 bg-surface-3"
              />
            ))}
          </div>
        ) : decisions.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-slate-800 bg-surface-3 text-lg">
              📋
            </div>
            <p className="text-sm font-medium text-slate-500">No decisions yet</p>
            <p className="mt-1 text-xs text-slate-700">
              Approve or reject items to build history.
            </p>
          </div>
        ) : (
          <ul
            className="divide-y divide-slate-800/50 overflow-y-auto"
            style={{ maxHeight: "calc(100vh - 300px)" }}
          >
            {decisions.map((d) => (
              <DecisionRow key={d.id} decision={d} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function DecisionRow({ decision: d }: { decision: Decision }) {
  const approved = d.decision === "approved";
  const label = d.title ?? `Item ${d.actionItemId.slice(0, 8)}`;
  const typeLabel = d.itemType ? (TYPE_LABEL[d.itemType] ?? d.itemType) : null;
  const typeBadgeClass = d.itemType ? (TYPE_BADGE[d.itemType] ?? "bg-slate-800 text-slate-400") : "";

  return (
    <li className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-3">
      {/* Decision indicator — left accent */}
      <div
        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
          approved ? "bg-emerald-400" : "bg-red-400"
        }`}
      />

      {/* Main content */}
      <div className="min-w-0 flex-1 space-y-1.5">
        {/* Title */}
        <p className="truncate text-sm font-medium leading-snug text-slate-200">
          {label}
        </p>

        {/* Badges row */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Approved / Rejected badge */}
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
              approved
                ? "bg-emerald-900/60 text-emerald-400 ring-1 ring-emerald-800/50"
                : "bg-red-900/60 text-red-400 ring-1 ring-red-800/50"
            }`}
          >
            {approved ? "✓" : "✕"} {approved ? "Approved" : "Rejected"}
          </span>

          {/* Type badge */}
          {typeLabel && (
            <span className={`rounded-full px-2 py-0.5 text-xs ${typeBadgeClass}`}>
              {typeLabel}
            </span>
          )}
        </div>

        {/* Reason + timestamp row */}
        <div className="flex items-center justify-between gap-2">
          {d.reason ? (
            <p className="truncate text-xs italic text-slate-600">"{d.reason}"</p>
          ) : (
            <span />
          )}
          <p className="shrink-0 text-xs text-slate-700">{relativeTime(d.decidedAt)}</p>
        </div>
      </div>
    </li>
  );
}

function PatternSummary({
  patterns,
  total,
}: {
  patterns: DecisionPattern[];
  total: number;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-surface-2">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-800 bg-surface-3 px-4 py-3">
        <div className="h-4 w-0.5 rounded-full bg-slate-500" />
        <h2 className="text-sm font-semibold text-white">Your Patterns</h2>
        <span className="ml-auto text-xs text-slate-600">{total} decisions</span>
      </div>

      <div className="space-y-3 px-4 py-4">
        {patterns.map((p) => {
          const approvedTotal = p.approved + p.rejected;
          const pct =
            approvedTotal > 0 ? Math.round((p.approved / approvedTotal) * 100) : 0;
          const label = TYPE_LABEL[p.type] ?? p.type.replace(/_/g, " ");
          const barColor =
            pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-red-500";
          const pctColor =
            pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-red-400";

          return (
            <div key={p.type}>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="text-slate-400">{label}</span>
                <span className={`font-semibold tabular-nums ${pctColor}`}>
                  {pct}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${barColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-1 text-right text-xs text-slate-700">
                {p.approved}✓ {p.rejected}✕
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  if (diff < 60_000) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
