import { Inbox, Clock, Shield, BarChart2, LogOut } from "lucide-react";
import type { StatusResponse } from "../api/pulseApi";

export type SidebarView = "queue" | "history" | "commitments" | "analytics";

interface Props {
  activeView: SidebarView;
  onNavigate: (view: SidebarView) => void;
  pendingCount: number;
  committedCount: number;
  status: StatusResponse | null;
  isGoogleConnected?: boolean;
  onLogout?: () => void;
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

function shortNodeId(nodeId: string | null | undefined): string {
  if (!nodeId) return "local-dev";
  return nodeId.length > 14 ? nodeId.slice(0, 6) + "…" + nodeId.slice(-4) : nodeId;
}

// ─── Inbox Health widget ──────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const r = 18;
  const circ = 2 * Math.PI * r;
  const filled = (score / 100) * circ;
  const color = score > 75 ? "#22c55e" : score >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <svg viewBox="0 0 44 44" className="h-12 w-12 -rotate-90">
      <circle cx="22" cy="22" r={r} fill="none" stroke="#1e293b" strokeWidth="4" />
      <circle
        cx="22" cy="22" r={r} fill="none"
        stroke={color} strokeWidth="4"
        strokeDasharray={`${filled} ${circ}`}
        strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.8s ease" }}
      />
    </svg>
  );
}

function InboxHealthWidget({ score }: { score: number | undefined }) {
  if (score === undefined) return null;
  const textColor =
    score > 75 ? "#22c55e" : score >= 50 ? "#f59e0b" : "#ef4444";
  const label =
    score > 75 ? "Great shape" : score >= 50 ? "Needs attention" : "Action needed";

  return (
    <div className="mx-3 mb-3 rounded-lg p-3" style={{ backgroundColor: "#1e293b" }}>
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <ScoreRing score={score} />
          <span
            className="absolute inset-0 flex items-center justify-center text-sm font-bold leading-none rotate-90"
            style={{ color: textColor }}
          >
            {score}
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">Inbox Health</p>
          <p className="text-[10px] font-medium" style={{ color: textColor }}>{label}</p>
          <p className="mt-0.5 text-[9px] leading-tight" style={{ color: "#475569" }}>
            decisions · queue · commitments
          </p>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ activeView, onNavigate, pendingCount, committedCount, status, isGoogleConnected, onLogout }: Props) {
  const nosana = status?.nosana;

  const navItems: { id: SidebarView; label: string; icon: React.ReactNode; count?: number }[] = [
    {
      id: "queue",
      label: "Inbox",
      icon: <Inbox size={16} />,
      count: pendingCount > 0 ? pendingCount : undefined,
    },
    {
      id: "history",
      label: "History",
      icon: <Clock size={16} />,
    },
    {
      id: "commitments",
      label: "Commitments",
      icon: <Shield size={16} />,
      count: committedCount > 0 ? committedCount : undefined,
    },
    {
      id: "analytics",
      label: "Analytics",
      icon: <BarChart2 size={16} />,
    },
  ];

  return (
    <aside
      className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col"
      style={{ backgroundColor: "#0f172a" }}
    >
      {/* Brand */}
      <div className="px-5 pt-6 pb-5">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-md text-white"
            style={{ backgroundColor: "#4f46e5" }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-bold leading-none text-white">Pulse</p>
            <p className="mt-0.5 text-[10px] leading-none" style={{ color: "#64748b" }}>
              Chief of Staff
            </p>
          </div>
        </div>
      </div>

      <div className="mx-4 mb-4 h-px" style={{ backgroundColor: "#1e293b" }} />

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-3">
        {navItems.map((item) => {
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium transition-all duration-100 ${
                active
                  ? "bg-white/10 text-white"
                  : "text-slate-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              <span className={active ? "text-white" : "text-slate-500"}>{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.count !== undefined && (
                <span
                  className="flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white"
                  style={{ backgroundColor: "#4f46e5" }}
                >
                  {item.count}
                </span>
              )}
            </button>
          );
        })}

      </nav>

      {/* Inbox Health score */}
      <div className="mx-4 mb-3 h-px" style={{ backgroundColor: "#1e293b" }} />
      <InboxHealthWidget score={status?.score} />

      {/* Bottom: Nosana badge */}
      <div className="mx-4 mb-4 h-px" style={{ backgroundColor: "#1e293b" }} />

      <div className="px-3 pb-5">
        {nosana?.isNosanaNode ? (
          <div
            className="rounded-lg p-3 space-y-2"
            style={{ backgroundColor: "#1e293b" }}
          >
            {/* Header row */}
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
              <span className="text-xs font-semibold text-white">Nosana GPU</span>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {nosana.modelName && (
                <>
                  <span className="text-[10px]" style={{ color: "#64748b" }}>Model</span>
                  <span
                    className="font-mono text-[10px] text-right truncate"
                    style={{ color: "#a78bfa" }}
                    title={nosana.modelName}
                  >
                    {nosana.modelName.length > 16
                      ? nosana.modelName.slice(0, 14) + "…"
                      : nosana.modelName}
                  </span>
                </>
              )}

              <span className="text-[10px]" style={{ color: "#64748b" }}>Inferences</span>
              <span className="font-mono text-[10px] text-right" style={{ color: "#94a3b8" }}>
                {nosana.llmCallCount}
              </span>

              {nosana.avgLatencyMs != null && (
                <>
                  <span className="text-[10px]" style={{ color: "#64748b" }}>Avg latency</span>
                  <span className="font-mono text-[10px] text-right" style={{ color: "#94a3b8" }}>
                    {nosana.avgLatencyMs < 1000
                      ? `${nosana.avgLatencyMs}ms`
                      : `${(nosana.avgLatencyMs / 1000).toFixed(1)}s`}
                  </span>
                </>
              )}


              <span className="text-[10px]" style={{ color: "#64748b" }}>Uptime</span>
              <span className="font-mono text-[10px] text-right" style={{ color: "#94a3b8" }}>
                {formatUptime(nosana.uptimeMs)}
              </span>

              <span className="text-[10px]" style={{ color: "#64748b" }}>Job type</span>
              <span className="font-mono text-[10px] text-right" style={{ color: "#94a3b8" }}>
                {nosana.jobType}
              </span>
            </div>
          </div>
        ) : (
          <div
            className="rounded-lg p-3 space-y-2"
            style={{ backgroundColor: "#1e293b" }}
          >
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: "#475569" }} />
              <span className="text-xs font-medium" style={{ color: "#94a3b8" }}>Local dev</span>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {nosana?.modelName && (
                <>
                  <span className="text-[10px]" style={{ color: "#64748b" }}>Model</span>
                  <span
                    className="font-mono text-[10px] text-right truncate"
                    style={{ color: "#a78bfa" }}
                    title={nosana.modelName}
                  >
                    {nosana.modelName.length > 16
                      ? nosana.modelName.slice(0, 14) + "…"
                      : nosana.modelName}
                  </span>
                </>
              )}
              <span className="text-[10px]" style={{ color: "#64748b" }}>Inferences</span>
              <span className="font-mono text-[10px] text-right" style={{ color: "#94a3b8" }}>
                {nosana?.llmCallCount ?? 0}
              </span>
              {nosana?.avgLatencyMs != null && (
                <>
                  <span className="text-[10px]" style={{ color: "#64748b" }}>Avg latency</span>
                  <span className="font-mono text-[10px] text-right" style={{ color: "#94a3b8" }}>
                    {nosana.avgLatencyMs < 1000
                      ? `${nosana.avgLatencyMs}ms`
                      : `${(nosana.avgLatencyMs / 1000).toFixed(1)}s`}
                  </span>
                </>
              )}
            </div>
          </div>
        )}
      {isGoogleConnected && onLogout && (
        <div className="px-3 pb-3">
          <button
            onClick={onLogout}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          >
            <LogOut size={13} />
            Sign out of Google
          </button>
        </div>
      )}
      </div>
    </aside>
  );
}
