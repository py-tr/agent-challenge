import { TrendingUp } from "lucide-react";
import type { DecisionsResponse, DecisionPattern, Decision } from "../api/pulseApi";

interface Props {
  data: DecisionsResponse | null;
  loading: boolean;
  compact?: boolean; // sidebar panel vs full-page view
}

const TYPE_LABEL: Record<string, string> = {
  email_draft:         "Email",
  conflict_resolution: "Conflict",
  slib_reminder:       "Commitment",
  follow_up:           "Follow-up",
};

const TYPE_COLOR: Record<string, string> = {
  email_draft:         "#3b82f6",
  conflict_resolution: "#ef4444",
  slib_reminder:       "#f59e0b",
  follow_up:           "#8b5cf6",
};

const TYPE_BADGE: Record<string, string> = {
  email_draft:         "bg-blue-50 text-blue-600 ring-1 ring-blue-200/60",
  conflict_resolution: "bg-red-50 text-red-600 ring-1 ring-red-200/60",
  slib_reminder:       "bg-amber-50 text-amber-600 ring-1 ring-amber-200/60",
  follow_up:           "bg-purple-50 text-purple-600 ring-1 ring-purple-200/60",
};

// ─── Compact sidebar panel ────────────────────────────────────────────────────

function CompactHistory({ decisions, loading }: { decisions: Decision[]; loading: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm">
      {loading ? (
        <div className="space-y-3 p-4">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex gap-2.5">
              <div className="mt-1 h-3 w-3 shrink-0 animate-pulse rounded-full bg-gray-100" />
              <div className="flex-1 space-y-1">
                <div className="h-2.5 animate-pulse rounded bg-gray-100" />
                <div className="h-2.5 w-2/3 animate-pulse rounded bg-gray-100" />
              </div>
            </div>
          ))}
        </div>
      ) : decisions.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-xs text-gray-400">No decisions yet</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-50">
          {decisions.slice(0, 8).map((d) => (
            <CompactRow key={d.id} decision={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function CompactRow({ decision: d }: { decision: Decision }) {
  const approved = d.decision === "approved";
  const label = d.title ?? `Item ${d.actionItemId.slice(0, 8)}`;
  const typeColor = d.itemType ? (TYPE_COLOR[d.itemType] ?? "#9ca3af") : "#9ca3af";

  return (
    <div className="flex items-start gap-2.5 px-4 py-3">
      {/* Colored dot keyed to item type */}
      <div
        className="mt-1 h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: typeColor, opacity: approved ? 1 : 0.35 }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-gray-700">{label}</p>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`text-[10px] font-semibold ${approved ? "text-green-600" : "text-red-500"}`}>
            {approved ? "Approved" : "Rejected"}
          </span>
          {d.itemType && (
            <span className="text-[10px] text-gray-400">{TYPE_LABEL[d.itemType] ?? d.itemType}</span>
          )}
          <span className="ml-auto shrink-0 text-[10px] text-gray-300">{relativeTime(d.decidedAt)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Full-page timeline ───────────────────────────────────────────────────────

function FullHistory({
  decisions,
  patterns,
  total,
  loading,
}: {
  decisions: Decision[];
  patterns: DecisionPattern[];
  total: number;
  loading: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
      {/* Timeline — 2/3 */}
      <div className="lg:col-span-2">
        <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Decision Log</h2>
              {total > 0 && (
                <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                  {total} total
                </span>
              )}
            </div>
          </div>

          {loading ? (
            <div className="space-y-4 p-6">
              {[1, 2, 3, 4, 5].map((n) => (
                <div key={n} className="flex gap-3">
                  <div className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-gray-100" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 animate-pulse rounded bg-gray-100" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-gray-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : decisions.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-sm font-medium text-gray-500">No decisions recorded yet</p>
              <p className="mt-1 text-xs text-gray-400">
                Approve or reject items to build your history.
              </p>
            </div>
          ) : (
            <div className="overflow-y-auto px-6 py-5" style={{ maxHeight: "calc(100vh - 280px)" }}>
              <ul className="relative space-y-0">
                {/* Vertical connecting line */}
                <div className="pointer-events-none absolute left-[7px] top-3 bottom-3 w-px bg-gray-100" />
                {decisions.map((d) => (
                  <TimelineRow key={d.id} decision={d} />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Patterns sidebar — 1/3 */}
      <div className="lg:col-span-1">
        {total >= 5 && patterns.length > 0 && (
          <PatternSummary patterns={patterns} total={total} />
        )}
      </div>
    </div>
  );
}

function TimelineRow({ decision: d }: { decision: Decision }) {
  const approved = d.decision === "approved";
  const label = d.title ?? `Item ${d.actionItemId.slice(0, 8)}`;
  const typeLabel = d.itemType ? (TYPE_LABEL[d.itemType] ?? d.itemType) : null;
  const typeBadge = d.itemType ? (TYPE_BADGE[d.itemType] ?? "bg-gray-100 text-gray-500") : "";

  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {/* Timeline dot */}
      <div
        className={`relative z-10 mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border-2 bg-white ${
          approved ? "border-green-500" : "border-red-400"
        }`}
      >
        <span
          className={`h-[5px] w-[5px] rounded-full ${approved ? "bg-green-500" : "bg-red-400"}`}
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug text-gray-800 truncate">{label}</p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            className={`badge text-xs font-semibold ${
              approved
                ? "bg-green-50 text-green-700 ring-1 ring-green-200/60"
                : "bg-red-50 text-red-600 ring-1 ring-red-200/60"
            }`}
          >
            {approved ? "Approved" : "Rejected"}
          </span>
          {typeLabel && (
            <span className={`badge text-xs ${typeBadge}`}>{typeLabel}</span>
          )}
        </div>

        {d.reason && (
          <p className="mt-1 truncate text-xs italic text-gray-400">"{d.reason}"</p>
        )}

        <p className="mt-0.5 text-xs text-gray-400">{relativeTime(d.decidedAt)}</p>
      </div>
    </li>
  );
}

// ─── Pattern summary ──────────────────────────────────────────────────────────

function PatternSummary({ patterns, total }: { patterns: DecisionPattern[]; total: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
        <div className="flex items-center gap-2">
          <TrendingUp size={15} className="text-indigo-400" />
          <h2 className="text-sm font-semibold text-gray-900">Your Patterns</h2>
        </div>
        <span className="text-xs text-gray-400">{total} decisions</span>
      </div>

      <div className="space-y-4 px-5 py-4">
        {patterns.map((p) => {
          const approvedTotal = p.approved + p.rejected;
          const pct = approvedTotal > 0 ? Math.round((p.approved / approvedTotal) * 100) : 0;
          const label = TYPE_LABEL[p.type] ?? p.type.replace(/_/g, " ");
          const typeColor = TYPE_COLOR[p.type] ?? "#9ca3af";
          const pctColor = pct >= 70 ? "text-green-600" : pct >= 40 ? "text-amber-600" : "text-red-500";

          return (
            <div key={p.type}>
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <div
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: typeColor }}
                  />
                  <span className="text-sm text-gray-700">{label}</span>
                </div>
                <span className={`text-sm font-semibold tabular-nums ${pctColor}`}>{pct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${pct}%`, backgroundColor: typeColor }}
                />
              </div>
              <p className="mt-1 text-right text-xs text-gray-400">
                {p.approved} approved · {p.rejected} rejected
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function DecisionHistory({ data, loading, compact = false }: Props) {
  const decisions = data?.decisions ?? [];
  const patterns = data?.patterns ?? [];
  const total = data?.total ?? 0;

  if (compact) {
    return <CompactHistory decisions={decisions} loading={loading} />;
  }

  return <FullHistory decisions={decisions} patterns={patterns} total={total} loading={loading} />;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  if (diff < 60_000) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
