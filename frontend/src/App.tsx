import { useState, useEffect, useCallback } from "react";
import { RefreshCw, AlertCircle, ChevronDown, ChevronUp, CheckCircle, XCircle, MessageSquare } from "lucide-react";
import { useActionQueue } from "./hooks/useActionQueue";
import { agentApi } from "./api/pulseApi";
import { Sidebar, type SidebarView } from "./components/Sidebar";
import { ActionQueue } from "./components/ActionQueue";
import { HistoryView } from "./components/HistoryView";
import { CommitmentsView } from "./components/CommitmentsView";
import { DecisionHistory } from "./components/DecisionHistory";
import { ChatDrawer } from "./components/ChatDrawer";

// ─── Toast ────────────────────────────────────────────────────────────────────

interface Toast {
  id: string;
  type: "approved" | "rejected";
  leaving: boolean;
}

function ToastContainer({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            "flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium shadow-lg text-white transition-all duration-300",
            t.leaving ? "opacity-0 translate-y-2" : "animate-toast-in",
            t.type === "approved" ? "bg-green-600" : "bg-gray-700",
          ].join(" ")}
        >
          {t.type === "approved" ? (
            <CheckCircle size={15} />
          ) : (
            <XCircle size={15} />
          )}
          {t.type === "approved" ? "Item approved" : "Item dismissed"}
        </div>
      ))}
    </div>
  );
}

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: "approved" | "rejected") => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, leaving: false }]);

    // Start fade-out at 1.7s
    setTimeout(() => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, leaving: true } : t))
      );
    }, 1700);

    // Remove from DOM at 2s
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2000);
  }, []);

  return { toasts, addToast };
}

// ─── Stats row ────────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1.5 text-3xl font-bold tabular-nums text-gray-900">{value}</p>
    </div>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────────────

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
  const [activityCollapsed, setActivityCollapsed] = useState(false);

  // Chat drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingAutoSend, setPendingAutoSend] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);

  // Toasts
  const { toasts, addToast } = useToasts();

  useEffect(() => {
    agentApi.fetchAgentId().then(setAgentId).catch(() => {
      // Agent unavailable — chat drawer shows bouncing dots
    });
  }, []);

  function openChatWithContext(title: string, body: string) {
    const snippet = body
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim()
      .slice(0, 100) ?? "";
    setPendingAutoSend(`I need help with this item: "${title}". ${snippet}`);
    setDrawerOpen(true);
  }

  const {
    items,
    status,
    decisions,
    loading,
    error,
    lastUpdated,
    approve: _approve,
    reject: _reject,
    refresh,
  } = useActionQueue();

  // Wrap approve/reject to fire toasts
  const approve = useCallback(
    async (id: string) => {
      await _approve(id);
      addToast("approved");
    },
    [_approve, addToast]
  );

  const reject = useCallback(
    async (id: string, reason?: string) => {
      await _reject(id, reason);
      addToast("rejected");
    },
    [_reject, addToast]
  );

  const pending = status?.queue.pending ?? 0;
  const approved = status?.queue.approved ?? 0;
  const rejected = status?.queue.rejected ?? 0;
  const committedCount = items.filter((i) => i.type === "slib_reminder").length;

  const viewTitle =
    view === "history" ? "History" : view === "commitments" ? "Commitments" : "Inbox";
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

      {/* Main content */}
      <div
        className={`flex-1 pl-60 transition-all duration-300 ${drawerOpen ? "pr-96" : "pr-0"}`}
      >
        {drawerOpen && (
          <div
            className="pointer-events-none fixed inset-y-0 z-20 bg-black/5"
            style={{ left: "240px", right: "384px" }}
          />
        )}

        <main className="mx-auto max-w-5xl px-8 py-8">
          <TopBar
            title={viewTitle}
            subtitle={viewSubtitle}
            lastUpdated={lastUpdated}
            error={error}
            onRefresh={refresh}
          />

          {/* ── History view ───────────────────────────────────────────── */}
          {view === "history" && (
            <HistoryView data={decisions} loading={loading} />
          )}

          {/* ── Commitments view ───────────────────────────────────────── */}
          {view === "commitments" && (
            <CommitmentsView
              items={items.filter((i) => i.type === "slib_reminder")}
              loading={loading}
              onApprove={approve}
              onReject={reject}
              onAskPulse={openChatWithContext}
            />
          )}

          {/* ── Inbox view ─────────────────────────────────────────────── */}
          {view === "queue" && (
            <>
              <div className="mb-8 grid grid-cols-3 gap-4">
                <StatCard label="Emails processed" value={approved + rejected} />
                <StatCard
                  label="Conflicts resolved"
                  value={
                    (decisions?.decisions ?? []).filter(
                      (d) => d.itemType === "conflict_resolution"
                    ).length
                  }
                />
                <StatCard
                  label="Commitments tracked"
                  value={
                    (decisions?.decisions ?? []).filter(
                      (d) => d.itemType === "slib_reminder"
                    ).length
                  }
                />
              </div>

              <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
                <section className="lg:col-span-2">
                  <ActionQueue
                    items={items}
                    loading={loading}
                    onApprove={approve}
                    onReject={reject}
                    onAskPulse={openChatWithContext}
                  />
                </section>

                {/* Collapsible Activity panel */}
                <section className="lg:col-span-1">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-gray-700">Activity</h2>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setView("history")}
                        className="text-xs font-medium text-indigo-500 hover:text-indigo-700"
                      >
                        View all
                      </button>
                      <button
                        onClick={() => setActivityCollapsed((v) => !v)}
                        className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                        title={activityCollapsed ? "Expand" : "Collapse"}
                      >
                        {activityCollapsed ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronUp size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                  {!activityCollapsed && (
                    <DecisionHistory data={decisions} loading={loading} compact />
                  )}
                </section>
              </div>
            </>
          )}

          <footer className="mt-16 border-t border-gray-200 pt-6 text-center text-xs text-gray-400">
            Pulse · Nothing is auto-sent · You decide everything
          </footer>
        </main>
      </div>

      {/* Floating chat button */}
      {!drawerOpen && (
        <button
          onClick={() => setDrawerOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg transition-all hover:bg-indigo-700 hover:shadow-xl active:scale-95"
          aria-label="Open Pulse chat"
        >
          <MessageSquare size={20} />
        </button>
      )}

      {/* Chat drawer */}
      <ChatDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        agentId={agentId}
        autoSendText={pendingAutoSend}
        onAutoSendConsumed={() => setPendingAutoSend(null)}
      />

      {/* Toasts */}
      <ToastContainer toasts={toasts} />
    </div>
  );
}
