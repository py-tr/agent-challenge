import { Inbox, Clock, Shield, Settings } from "lucide-react";
import type { StatusResponse } from "../api/pulseApi";

export type SidebarView = "queue" | "history" | "commitments";

interface Props {
  activeView: SidebarView;
  onNavigate: (view: SidebarView) => void;
  pendingCount: number;
  committedCount: number;
  status: StatusResponse | null;
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

export function Sidebar({ activeView, onNavigate, pendingCount, committedCount, status }: Props) {
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
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M10 2a1 1 0 011 1v6.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L9 9.586V3a1 1 0 011-1z" />
              <path d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
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

        {/* Settings — placeholder */}
        <button
          className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium text-slate-500 transition-all duration-100 hover:bg-white/5 hover:text-slate-400"
          disabled
        >
          <Settings size={16} className="text-slate-600" />
          <span>Settings</span>
        </button>
      </nav>

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
              <span className="text-[10px]" style={{ color: "#64748b" }}>Node</span>
              <span className="font-mono text-[10px] text-right" style={{ color: "#94a3b8" }}>
                {shortNodeId(nosana.nodeId)}
              </span>

              <span className="text-[10px]" style={{ color: "#64748b" }}>Inferences</span>
              <span className="font-mono text-[10px] text-right" style={{ color: "#94a3b8" }}>
                {nosana.llmCallCount}
              </span>

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
            className="flex items-center gap-2 rounded-lg px-3 py-2.5"
            style={{ backgroundColor: "#1e293b" }}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#475569" }} />
            <div>
              <p className="text-xs font-medium" style={{ color: "#94a3b8" }}>Local dev</p>
              <p className="text-[10px]" style={{ color: "#475569" }}>
                {nosana?.llmCallCount ?? 0} LLM calls
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
