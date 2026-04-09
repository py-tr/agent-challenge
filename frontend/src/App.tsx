import { useState } from "react";
import { RefreshCw, AlertCircle } from "lucide-react";
import { useActionQueue } from "./hooks/useActionQueue";
import { Sidebar, type SidebarView } from "./components/Sidebar";
import { ActionQueue } from "./components/ActionQueue";
import { DecisionHistory } from "./components/DecisionHistory";

// ─── Stats row ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1.5 text-2xl font-bold tabular-nums text-gray-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

// ─── Header bar (inside main area) ───────────────────────────────────────────

function TopBar({
  title,
  subtitle,
  lastUpdated,
  error,
  onRefresh,
}: {
  title: string;
  subtitle: string;
  lastUpdated: Date | null;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
          <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-400">
              {timeAgo(lastUpdated.toISOString())}
            </span>
          )}
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-700 active:scale-95"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-600">
          <AlertCircle size={13} />
          Connection error: {error} — retrying every 5s
        </div>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  if (diff < 60_000) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<SidebarView>("queue");

  const {
    items,
    status,
    decisions,
    loading,
    error,
    lastUpdated,
    approve,
    reject,
    refresh,
  } = useActionQueue();

  const pending = status?.queue.pending ?? 0;
  const approved = status?.queue.approved ?? 0;
  const rejected = status?.queue.rejected ?? 0;

  // Commitments = slib_reminder items currently pending
  const committedCount = items.filter((i) => i.type === "slib_reminder").length;

  // Items to show for each view
  const queueItems = view === "commitments"
    ? items.filter((i) => i.type === "slib_reminder")
    : items;

  const viewTitle = view === "history" ? "History" : view === "commitments" ? "Commitments" : "Inbox";
  const viewSubtitle =
    view === "history"
      ? `${decisions?.total ?? 0} past decisions`
      : view === "commitments"
      ? committedCount === 0
        ? "No pending commitments"
        : `${committedCount} commitment${committedCount === 1 ? "" : "s"} need your attention`
      : loading
      ? "Loading…"
      : pending === 0
      ? "Nothing pending"
      : `${pending} item${pending === 1 ? "" : "s"} need your decision`;

  return (
    <div className="flex min-h-screen" style={{ backgroundColor: "#f8fafc" }}>
      <Sidebar
        activeView={view}
        onNavigate={setView}
        pendingCount={pending}
        committedCount={committedCount}
        status={status}
      />

      {/* Main content — offset by sidebar width */}
      <div className="flex-1 pl-60">
        <main className="mx-auto max-w-5xl px-8 py-8">
          <TopBar
            title={viewTitle}
            subtitle={viewSubtitle}
            lastUpdated={lastUpdated}
            error={error}
            onRefresh={refresh}
          />

          {/* Stats row — only on queue/commitments views */}
          {view !== "history" && (
            <div className="mb-8 grid grid-cols-3 gap-4">
              <StatCard label="Emails processed" value={approved + rejected} />
              <StatCard
                label="Conflicts resolved"
                value={
                  (decisions?.decisions ?? []).filter((d) => d.itemType === "conflict_resolution")
                    .length
                }
              />
              <StatCard
                label="Commitments tracked"
                value={
                  (decisions?.decisions ?? []).filter((d) => d.itemType === "slib_reminder").length
                }
              />
            </div>
          )}

          {/* Content */}
          {view === "history" ? (
            <DecisionHistory data={decisions} loading={loading} />
          ) : (
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
              {/* Queue — 2/3 width */}
              <section className="lg:col-span-2">
                <ActionQueue
                  items={queueItems}
                  loading={loading}
                  onApprove={approve}
                  onReject={reject}
                />
              </section>

              {/* History sidebar — 1/3 width */}
              <section className="lg:col-span-1">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-gray-700">Recent Activity</h2>
                  <button
                    onClick={() => setView("history")}
                    className="text-xs text-indigo-500 hover:text-indigo-700 font-medium"
                  >
                    View all
                  </button>
                </div>
                <DecisionHistory data={decisions} loading={loading} compact />
              </section>
            </div>
          )}

          <footer className="mt-16 border-t border-gray-200 pt-6 text-center text-xs text-gray-400">
            Pulse · Nothing is auto-sent · You decide everything
          </footer>
        </main>
      </div>
    </div>
  );
}
