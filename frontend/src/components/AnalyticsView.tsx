/**
 * AnalyticsView — 7-day decision history bar chart + per-type approval rates.
 * Uses inline SVG only — no external chart libs needed.
 */

import { useState, useEffect } from "react";
import { pulseApi, type DayBucket, type DecisionPattern } from "../api/pulseApi";

// ─── Bar Chart ────────────────────────────────────────────────────────────────

const CHART_W = 480;
const CHART_H = 120;
const BAR_GAP = 6;

function WeeklyChart({ data }: { data: DayBucket[] }) {
  if (data.length === 0) return null;

  const maxVal = Math.max(...data.map((d) => d.approved + d.rejected), 1);
  const barW = (CHART_W - BAR_GAP * (data.length - 1)) / data.length;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H + 24}`}
        className="w-full"
        style={{ minWidth: "320px", maxWidth: "560px" }}
        aria-label="7-day decision chart"
      >
        {data.map((day, i) => {
          const total = day.approved + day.rejected;
          const approvedH = total > 0 ? (day.approved / maxVal) * CHART_H : 0;
          const rejectedH = total > 0 ? (day.rejected / maxVal) * CHART_H : 0;
          const x = i * (barW + BAR_GAP);
          const label = day.date.slice(5); // MM-DD

          return (
            <g key={day.date}>
              {/* Rejected (bottom) */}
              {rejectedH > 0 && (
                <rect
                  x={x}
                  y={CHART_H - approvedH - rejectedH}
                  width={barW}
                  height={rejectedH}
                  fill="#f87171"
                  rx="2"
                />
              )}
              {/* Approved (top) */}
              {approvedH > 0 && (
                <rect
                  x={x}
                  y={CHART_H - approvedH}
                  width={barW}
                  height={approvedH}
                  fill="#4f46e5"
                  rx="2"
                />
              )}
              {/* Empty placeholder */}
              {total === 0 && (
                <rect
                  x={x}
                  y={CHART_H - 3}
                  width={barW}
                  height={3}
                  fill="#e2e8f0"
                  rx="1"
                />
              )}
              {/* Date label */}
              <text
                x={x + barW / 2}
                y={CHART_H + 16}
                textAnchor="middle"
                fontSize="9"
                fill="#94a3b8"
              >
                {label}
              </text>
              {/* Total count above bar */}
              {total > 0 && (
                <text
                  x={x + barW / 2}
                  y={CHART_H - approvedH - rejectedH - 3}
                  textAnchor="middle"
                  fontSize="9"
                  fill="#64748b"
                >
                  {total}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="mt-2 flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: "#4f46e5" }} />
          <span className="text-xs text-gray-500">Approved</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: "#f87171" }} />
          <span className="text-xs text-gray-500">Rejected</span>
        </div>
      </div>
    </div>
  );
}

// ─── Type breakdown ───────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  email_draft:         "Email Drafts",
  conflict_resolution: "Conflicts",
  slib_reminder:       "Commitments",
  follow_up:           "Follow-ups",
};

function ApprovalBar({ approved, rejected }: { approved: number; rejected: number }) {
  const total = approved + rejected;
  if (total === 0) return <span className="text-xs text-gray-400">No decisions yet</span>;
  const pct = Math.round((approved / total) * 100);
  const color = pct >= 75 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-24 overflow-hidden rounded-full" style={{ backgroundColor: "#e2e8f0" }}>
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs font-medium tabular-nums" style={{ color }}>
        {pct}%
      </span>
      <span className="text-[10px] text-gray-400">
        ({approved}/{total})
      </span>
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function AnalyticsView() {
  const [weekly, setWeekly] = useState<DayBucket[]>([]);
  const [patterns, setPatterns] = useState<DecisionPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    pulseApi.getAnalytics()
      .then((data) => {
        setWeekly(data.weekly);
        setPatterns(data.patterns);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const totalApproved = patterns.reduce((s, p) => s + p.approved, 0);
  const totalRejected = patterns.reduce((s, p) => s + p.rejected, 0);
  const totalDecisions = totalApproved + totalRejected;

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-40 animate-pulse rounded-xl bg-white shadow-sm" />
        <div className="h-32 animate-pulse rounded-xl bg-white shadow-sm" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-600">
        Failed to load analytics: {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 7-day chart */}
      <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Decision Activity</h2>
            <p className="text-xs text-gray-400">Last 7 days</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold tabular-nums text-gray-900">{totalDecisions}</p>
            <p className="text-[10px] text-gray-400">total decisions</p>
          </div>
        </div>
        <WeeklyChart data={weekly} />
      </div>

      {/* Per-type approval rates */}
      <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-gray-900">Approval Rate by Type</h2>
        {patterns.length === 0 ? (
          <p className="text-sm text-gray-400">
            No decisions yet — approve or reject some items to see patterns.
          </p>
        ) : (
          <div className="space-y-4">
            {patterns.map((p) => (
              <div key={p.type} className="flex items-center justify-between gap-4">
                <span className="text-sm text-gray-700 w-36 shrink-0">
                  {TYPE_LABELS[p.type] ?? p.type}
                </span>
                <ApprovalBar approved={p.approved} rejected={p.rejected} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Overall summary */}
      {totalDecisions > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums text-indigo-600">{totalApproved}</p>
            <p className="text-xs text-gray-400 mt-1">Approved</p>
          </div>
          <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums text-red-400">{totalRejected}</p>
            <p className="text-xs text-gray-400 mt-1">Rejected</p>
          </div>
          <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums text-gray-900">
              {totalDecisions > 0 ? Math.round((totalApproved / totalDecisions) * 100) : 0}%
            </p>
            <p className="text-xs text-gray-400 mt-1">Approval rate</p>
          </div>
        </div>
      )}
    </div>
  );
}
