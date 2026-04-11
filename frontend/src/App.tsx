import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, AlertCircle, ChevronDown, ChevronUp, CheckCircle, XCircle, MessageSquare, Undo2, Maximize2 } from "lucide-react";
import { useActionQueue } from "./hooks/useActionQueue";
import { agentApi, pulseApi, type ActionItem, type EmailDraftContext, type BriefingData } from "./api/pulseApi";
import { Sidebar, type SidebarView } from "./components/Sidebar";
import { ActionQueue } from "./components/ActionQueue";
import { HistoryView } from "./components/HistoryView";
import { CommitmentsView } from "./components/CommitmentsView";
import { DecisionHistory } from "./components/DecisionHistory";
import { ChatDrawer } from "./components/ChatDrawer";
import { BriefingPanel } from "./components/BriefingPanel";
import { FocusMode } from "./components/FocusMode";

// ─── Toast ────────────────────────────────────────────────────────────────────

interface Toast {
  id: string;
  type: "approved" | "rejected" | "processed" | "draft_queued";
  message?: string;
  leaving: boolean;
  /** When set, shows an Undo button. Clicking it calls this function. */
  onUndo?: () => void;
}

function ToastContainer({ toasts, onUndo }: { toasts: Toast[]; onUndo: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            "pointer-events-auto flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium shadow-lg text-white transition-all duration-300",
            t.leaving ? "opacity-0 translate-y-2" : "animate-toast-in",
            t.type === "approved" ? "bg-green-600"
            : t.type === "processed" ? "bg-indigo-600"
            : t.type === "draft_queued" ? "bg-blue-600"
            : "bg-gray-700",
          ].join(" ")}
        >
          {t.type === "approved" ? (
            <CheckCircle size={15} />
          ) : t.type === "processed" ? (
            <RefreshCw size={15} />
          ) : t.type === "draft_queued" ? (
            <MessageSquare size={15} />
          ) : (
            <XCircle size={15} />
          )}
          {t.message ?? (
            t.type === "approved" ? "Item approved"
            : t.type === "processed" ? "Inbox processed"
            : t.type === "draft_queued" ? "Draft email queued"
            : "Item dismissed"
          )}
          {t.onUndo && (
            <button
              onClick={() => onUndo(t.id)}
              className="ml-1 flex items-center gap-1 rounded border border-white/30 bg-white/10 px-2 py-0.5 text-xs font-semibold hover:bg-white/20 transition-colors"
            >
              <Undo2 size={11} />
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Delay for undo window in ms. */
const UNDO_DELAY_MS = 3_000;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Maps toast id → cancel-timer function
  const undoTimers = useRef<Map<string, (() => void)>>(new Map());

  const addToast = useCallback((
    type: "approved" | "rejected" | "processed" | "draft_queued",
    message?: string,
    onUndo?: () => void
  ) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message, leaving: false, onUndo }]);

    const fadeTimer = setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    }, onUndo ? UNDO_DELAY_MS + 300 : 1700);

    const removeTimer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      undoTimers.current.delete(id);
    }, onUndo ? UNDO_DELAY_MS + 600 : 2000);

    undoTimers.current.set(id, () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    });

    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    undoTimers.current.get(id)?.();
    undoTimers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, removeToast };
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
  onProcessInbox,
  processingInbox,
}: {
  title: string;
  subtitle: string;
  lastUpdated: Date | null;
  error: string | null;
  onRefresh: () => void;
  onProcessInbox?: () => void;
  processingInbox?: boolean;
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
          {onProcessInbox && (
            <button
              onClick={onProcessInbox}
              disabled={processingInbox}
              title="Fetch new emails from Gmail and classify them into action items"
              className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-600 transition-colors hover:border-indigo-300 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
            >
              <RefreshCw size={12} className={processingInbox ? "animate-spin" : ""} />
              {processingInbox ? "Checking…" : "Check for New Emails"}
            </button>
          )}
          <button
            onClick={onRefresh}
            title="Refresh queue from database"
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-700 active:scale-95"
          >
            <RefreshCw size={12} />
            Refresh Queue
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
  const [processingInbox, setProcessingInbox] = useState(false);
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(true);
  const [focusMode, setFocusMode] = useState(false);

  // Chat drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingAutoSend, setPendingAutoSend] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [activeEmailDraft, setActiveEmailDraft] = useState<EmailDraftContext | null>(null);

  const { toasts, addToast, removeToast } = useToasts();

  // Pending undo timers: itemId → { cancelApiFn, toastId }
  const undoPending = useRef<Map<string, { cancel: () => void; toastId: string }>>(new Map());

  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    agentApi.fetchAgentId().then(setAgentId).catch(() => {});
  }, []);

  // Fetch briefing once on mount (fires ~5s after agent start)
  useEffect(() => {
    setBriefingLoading(true);
    pulseApi.getBriefing()
      .then((r) => setBriefing(r.briefing))
      .catch(() => {})
      .finally(() => setBriefingLoading(false));
  }, []);

  function openChatWithContext(title: string, body: string) {
    const snippet = body
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim()
      .slice(0, 100) ?? "";
    setPendingAutoSend(`I need help with this item: "${title}". ${snippet}`);
    setActiveEmailDraft(null);
    setDrawerOpen(true);
  }

  const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/;

  function extractEmailAddress(item: ActionItem): string {
    const meta = item.metadata;
    for (const key of ["from", "to"] as const) {
      const val = meta?.[key];
      if (typeof val === "string" && val) {
        const m = val.match(/<([^>]+)>/) ?? val.match(EMAIL_RE);
        if (m) {
          const addr = m[1] ?? m[0] ?? "";
          if (addr) return addr;
        }
      }
    }
    const bodyMatch = item.body.match(/\*{0,2}From:\*{0,2}\s+([^\s<>\n]+@[^\s<>\n]+)/i);
    if (bodyMatch?.[1]) return bodyMatch[1].replace(/[.,;>]+$/, "");
    const bareMatch = item.body.match(EMAIL_RE);
    if (bareMatch?.[0]) return bareMatch[0];
    return "";
  }

  function extractDraftReply(body: string): string {
    const MARKER = "**Suggested reply scaffold:**\n\n";
    const END    = "\n\n---";
    const start  = body.indexOf(MARKER);
    if (start === -1) return body;
    const textStart = start + MARKER.length;
    const end = body.indexOf(END, textStart);
    return end !== -1 ? body.slice(textStart, end) : body.slice(textStart);
  }

  function extractOriginalSnippet(body: string): string | undefined {
    const MARKER = "**Their message:**\n";
    const END    = "\n\n---";
    const markerIdx = body.indexOf(MARKER);
    if (markerIdx !== -1) {
      const textStart = markerIdx + MARKER.length;
      const endIdx    = body.indexOf(END, textStart);
      const text = (endIdx !== -1 ? body.slice(textStart, endIdx) : body.slice(textStart)).trim();
      if (text) return text;
    }
    const SCAFFOLD_MARKER = "**Suggested reply scaffold:**";
    const APPROVE_MARKER  = "**Approve**";
    const firstSep = body.indexOf("\n---\n");
    const stopA    = body.indexOf(SCAFFOLD_MARKER);
    const stopB    = body.indexOf(APPROVE_MARKER);
    const stopAt   = Math.min(
      stopA === -1 ? Infinity : stopA,
      stopB === -1 ? Infinity : stopB,
    );
    if (firstSep !== -1 && stopAt !== Infinity && firstSep < stopAt) {
      const text = body
        .slice(firstSep + 5, stopAt)
        .replace(/^\*\*Their message:\*\*\s*\n?/, "")
        .replace(/\n?---\s*$/, "")
        .trim();
      if (text.length > 5) return text;
    }
    return undefined;
  }

  function openEmailDraft(item: ActionItem) {
    const meta = item.metadata;
    console.log("[Email] item metadata:", JSON.stringify(item.metadata));
    const subject =
      typeof meta?.subject === "string" ? meta.subject : item.title;
    const draft: EmailDraftContext = {
      itemId:          item.id,
      to:              extractEmailAddress(item),
      subject,
      body:            extractDraftReply(item.body),
      originalFrom:    typeof meta?.from === "string" ? meta.from : undefined,
      originalDate:    typeof meta?.date === "string" ? meta.date : undefined,
      originalSnippet: extractOriginalSnippet(item.body),
    };
    setActiveEmailDraft(draft);
    setPendingAutoSend(null);
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

  refreshRef.current = refresh;

  const handleProcessInbox = useCallback(async () => {
    setProcessingInbox(true);
    try {
      await pulseApi.processInbox();
      addToast("processed");
      refreshRef.current?.();
    } catch {
      // error surfaces via queue error banner
    } finally {
      setProcessingInbox(false);
    }
  }, [addToast]);

  // ─── Undo-aware approve ─────────────────────────────────────────────────────
  const approve = useCallback(
    async (id: string) => {
      // If there's already a pending undo for this item, cancel it first
      const existing = undoPending.current.get(id);
      if (existing) {
        existing.cancel();
        undoPending.current.delete(id);
        removeToast(existing.toastId);
      }

      // Optimistically remove the item from view immediately (the card exits).
      // The actual API call is deferred by UNDO_DELAY_MS.
      let cancelled = false;
      const timer = setTimeout(async () => {
        if (cancelled) return;
        undoPending.current.delete(id);
        try {
          const result = await _approve(id);
          if (result.draftCreated) {
            const raw = result.draftRecipient ?? "";
            const nameMatch = raw.match(/^([^<]+)</);
            const firstName = nameMatch
              ? nameMatch[1].trim().split(" ")[0]
              : raw.replace(/<[^>]+>/, "").trim() || "recipient";
            addToast("draft_queued", `Draft email queued for ${firstName}`);
            setTimeout(() => refreshRef.current?.(), 1_000);
          }
          // Refresh to sync any server-side changes
          refreshRef.current?.();
        } catch {
          // Error will surface on next poll
        }
      }, UNDO_DELAY_MS);

      const undoFn = () => {
        cancelled = true;
        clearTimeout(timer);
        // Refresh so the item reappears in the queue
        refreshRef.current?.();
      };

      const toastId = addToast("approved", "Item approved", undoFn) as string;
      undoPending.current.set(id, { cancel: () => { cancelled = true; clearTimeout(timer); }, toastId });
    },
    [_approve, addToast, removeToast]
  );

  // ─── Undo-aware reject ──────────────────────────────────────────────────────
  const reject = useCallback(
    async (id: string, reason?: string) => {
      let cancelled = false;
      const timer = setTimeout(async () => {
        if (cancelled) return;
        undoPending.current.delete(id);
        try { await _reject(id, reason); } catch {}
        refreshRef.current?.();
      }, UNDO_DELAY_MS);

      const undoFn = () => {
        cancelled = true;
        clearTimeout(timer);
        refreshRef.current?.();
      };

      const toastId = addToast("rejected", "Item rejected", undoFn) as string;
      undoPending.current.set(id, { cancel: () => { cancelled = true; clearTimeout(timer); }, toastId });
    },
    [_reject, addToast]
  );

  // ─── Dismiss (Skip without rejecting) ──────────────────────────────────────
  const dismiss = useCallback(
    async (id: string) => {
      let cancelled = false;
      const timer = setTimeout(async () => {
        if (cancelled) return;
        undoPending.current.delete(id);
        try { await pulseApi.dismiss(id); } catch {}
        refreshRef.current?.();
      }, UNDO_DELAY_MS);

      const undoFn = () => {
        cancelled = true;
        clearTimeout(timer);
        refreshRef.current?.();
      };

      const toastId = addToast("rejected", "Item skipped", undoFn) as string;
      undoPending.current.set(id, { cancel: () => { cancelled = true; clearTimeout(timer); }, toastId });
    },
    [addToast]
  );

  const handleUndoToast = useCallback((toastId: string) => {
    // Find the pending undo entry with this toast id
    for (const [, entry] of undoPending.current.entries()) {
      if (entry.toastId === toastId) {
        entry.cancel();
      }
    }
    removeToast(toastId);
    // Refresh after a short delay to let the cancel propagate
    setTimeout(() => refreshRef.current?.(), 50);
  }, [removeToast]);

  const pending      = status?.queue.pending ?? 0;
  const approved     = status?.queue.approved ?? 0;
  const rejected     = status?.queue.rejected ?? 0;
  const committedCount = items.filter((i) => i.type === "slib_reminder").length;

  // Stat card: only count email_draft decisions as "emails sent"
  const emailsSent = (decisions?.decisions ?? []).filter(
    (d) => d.itemType === "email_draft" && d.decision === "approved"
  ).length;
  const conflictsResolved = (decisions?.decisions ?? []).filter(
    (d) => d.itemType === "conflict_resolution"
  ).length;
  const commitmentsTracked = (decisions?.decisions ?? []).filter(
    (d) => d.itemType === "slib_reminder"
  ).length;

  // Proactive chat context: first pending item for welcome message
  const firstPendingItem = items.find((i) => i.status === "pending");

  useEffect(() => {
    document.title = pending > 0
      ? `Pulse (${pending}) — Chief of Staff`
      : "Pulse — Chief of Staff";
  }, [pending]);

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
            onProcessInbox={view === "queue" ? handleProcessInbox : undefined}
            processingInbox={processingInbox}
          />

          {view === "history" && (
            <HistoryView data={decisions} loading={loading} />
          )}

          {view === "commitments" && (
            <CommitmentsView
              items={items.filter((i) => i.type === "slib_reminder")}
              loading={loading}
              onApprove={approve}
              onReject={reject}
              onAskPulse={openChatWithContext}
              decisions={decisions?.decisions ?? []}
            />
          )}

          {view === "queue" && (
            <>
              {!focusMode && (
                <>
                  {/* Morning briefing panel */}
                  <BriefingPanel briefing={briefing} loading={briefingLoading} />

                  <div className="mb-8 grid grid-cols-3 gap-4">
                    <StatCard label="Emails sent" value={emailsSent} />
                    <StatCard label="Conflicts resolved" value={conflictsResolved} />
                    <StatCard label="Commitments tracked" value={commitmentsTracked} />
                  </div>
                </>
              )}

              {focusMode ? (
                <FocusMode
                  items={items.filter((i) => i.status === "pending")}
                  onExit={() => setFocusMode(false)}
                  onApprove={approve}
                  onReject={reject}
                  onDismiss={dismiss}
                  onAskPulse={openChatWithContext}
                  onEmailReview={openEmailDraft}
                />
              ) : (
                <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
                  <section className="lg:col-span-2">
                    {/* Focus mode toggle — only shown when there are pending items */}
                    {pending > 0 && (
                      <div className="mb-4 flex justify-end">
                        <button
                          onClick={() => setFocusMode(true)}
                          title="Review one item at a time without distractions"
                          className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-600 transition-colors hover:bg-indigo-100"
                        >
                          <Maximize2 size={12} />
                          Focus Mode
                        </button>
                      </div>
                    )}
                    <ActionQueue
                      items={items}
                      loading={loading}
                      onApprove={approve}
                      onReject={reject}
                      onDismiss={dismiss}
                      onAskPulse={openChatWithContext}
                      onEmailReview={openEmailDraft}
                    />
                  </section>

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
              )}
            </>
          )}

          <footer className="mt-16 border-t border-gray-200 pt-6 text-center text-xs text-gray-400">
            Pulse · Nothing is auto-sent · You decide everything
          </footer>
        </main>
      </div>

      {!drawerOpen && (
        <button
          onClick={() => setDrawerOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg transition-all hover:bg-indigo-700 hover:shadow-xl active:scale-95"
          aria-label="Open Pulse chat"
        >
          <MessageSquare size={20} />
        </button>
      )}

      <ChatDrawer
        key={activeEmailDraft ? `draft-${activeEmailDraft.itemId}` : "chat"}
        isOpen={drawerOpen}
        onClose={() => { setDrawerOpen(false); setActiveEmailDraft(null); }}
        agentId={agentId}
        autoSendText={pendingAutoSend}
        onAutoSendConsumed={() => setPendingAutoSend(null)}
        emailDraft={activeEmailDraft}
        onEmailSent={() => {
          refresh();
          addToast("approved", "Email sent");
        }}
        onQueueRefresh={refresh}
        userDisplayName={status?.userDisplayName}
        pendingCount={pending}
        firstPendingTitle={firstPendingItem?.title}
      />

      <ToastContainer toasts={toasts} onUndo={handleUndoToast} />
    </div>
  );
}
