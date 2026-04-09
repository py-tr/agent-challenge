import type { DecisionsResponse, DecisionPattern, Decision } from "../api/pulseApi";

interface Props {
  data: DecisionsResponse | null;
  loading: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  email_draft:         "Email Draft",
  conflict_resolution: "Calendar Conflict",
  slib_reminder:       "Commitment",
  follow_up:           "Follow-up",
};

const TYPE_BADGE: Record<string, string> = {
  email_draft:         "bg-blue-950/50 text-blue-500 border border-blue-900/50",
  conflict_resolution: "bg-red-950/50 text-red-500 border border-red-900/50",
  slib_reminder:       "bg-amber-950/50 text-amber-500 border border-amber-900/50",
  follow_up:           "bg-purple-950/50 text-purple-500 border border-purple-900/50",
};

export function DecisionHistory({ data, loading }: Props) {
  const decisions = data?.decisions ?? [];
  const patterns  = data?.patterns  ?? [];
  const total     = data?.total     ?? 0;

  return (
    <aside className="flex flex-col gap-5">
      {/* Pattern summary — shown when 10+ decisions exist */}
      {total >= 10 && patterns.length > 0 && (
        <PatternSummary patterns={patterns} total={total} />
      )}

      {/* History panel */}
      <div className="overflow-hidden rounded-lg border border-slate-800/60 bg-surface-2">
        <div className="flex items-center justify-between border-b border-slate-800/60 bg-surface-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-0.5 rounded-full bg-slate-700" />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              History
            </h2>
          </div>
          {total > 0 && (
            <span className="rounded bg-surface-4 px-1.5 py-0.5 text-xs text-slate-600">
              {total} total
            </span>
          )}
        </div>

        {loading ? (
          <div className="space-y-px p-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <div
                key={n}
                className="h-14 animate-pulse rounded border border-slate-800/40 bg-surface-3"
              />
            ))}
          </div>
        ) : decisions.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full border border-slate-800/60 bg-surface-3">
              <svg className="h-4 w-4 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <p className="text-sm font-medium text-slate-600">No decisions yet</p>
            <p className="mt-1 text-xs text-slate-800 leading-relaxed">
              Approve or reject items from the queue<br />to build your decision history.
            </p>
          </div>
        ) : (
          <ul
            className="divide-y divide-slate-800/40 overflow-y-auto"
            style={{ maxHeight: "calc(100vh - 320px)" }}
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
  const approved    = d.decision === "approved";
  const label       = d.title ?? `Item ${d.actionItemId.slice(0, 8)}`;
  const typeLabel   = d.itemType ? (TYPE_LABEL[d.itemType] ?? d.itemType) : null;
  const typeBadge   = d.itemType ? (TYPE_BADGE[d.itemType] ?? "bg-surface-3 text-slate-500 border border-slate-800/40") : "";

  return (
    <li className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-3">
      {/* Decision indicator dot */}
      <div
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
          approved ? "bg-emerald-500" : "bg-red-600"
        }`}
      />

      <div className="min-w-0 flex-1 space-y-1.5">
        {/* Title */}
        <p className="truncate text-xs font-medium leading-snug text-slate-300">
          {label}
        </p>

        {/* Badges row */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`badge text-xs font-semibold ${
              approved
                ? "bg-emerald-950/50 text-emerald-500 border border-emerald-900/50"
                : "bg-red-950/50 text-red-500 border border-red-900/50"
            }`}
          >
            {approved ? "Approved" : "Rejected"}
          </span>

          {typeLabel && (
            <span className={`badge text-xs ${typeBadge}`}>
              {typeLabel}
            </span>
          )}
        </div>

        {/* Reason + timestamp */}
        <div className="flex items-center justify-between gap-2">
          {d.reason ? (
            <p className="truncate text-xs italic text-slate-700">"{d.reason}"</p>
          ) : (
            <span />
          )}
          <p className="shrink-0 text-xs text-slate-800">{relativeTime(d.decidedAt)}</p>
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
    <div className="overflow-hidden rounded-lg border border-slate-800/60 bg-surface-2">
      <div className="flex items-center gap-2 border-b border-slate-800/60 bg-surface-3 px-4 py-3">
        <div className="h-3.5 w-0.5 rounded-full bg-slate-700" />
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Your Patterns
        </h2>
        <span className="ml-auto text-xs text-slate-700">{total} decisions</span>
      </div>

      <div className="space-y-4 px-4 py-4">
        {patterns.map((p) => {
          const approvedTotal = p.approved + p.rejected;
          const pct =
            approvedTotal > 0 ? Math.round((p.approved / approvedTotal) * 100) : 0;
          const label = TYPE_LABEL[p.type] ?? p.type.replace(/_/g, " ");
          const barColor =
            pct >= 70 ? "bg-emerald-600" : pct >= 40 ? "bg-amber-600" : "bg-red-700";
          const pctColor =
            pct >= 70 ? "text-emerald-500" : pct >= 40 ? "text-amber-500" : "text-red-500";

          return (
            <div key={p.type}>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="text-slate-500">{label}</span>
                <span className={`tabular-nums font-semibold ${pctColor}`}>
                  {pct}% approved
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${barColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-1 text-right text-xs text-slate-800">
                {p.approved} approved · {p.rejected} rejected
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
