import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, AlertCircle, ChevronDown, ChevronUp, CheckCircle, MessageSquare, Maximize2, X as XIcon } from "lucide-react";
import { useActionQueue } from "./hooks/useActionQueue";
import { agentApi, pulseApi, type ActionItem, type EmailDraftContext, type BriefingData, type ConflictContext } from "./api/pulseApi";
import { Sidebar, type SidebarView } from "./components/Sidebar";
import { ActionQueue } from "./components/ActionQueue";
import { HistoryView } from "./components/HistoryView";
import { CommitmentsView } from "./components/CommitmentsView";
import { DecisionHistory } from "./components/DecisionHistory";
import { ChatDrawer } from "./components/ChatDrawer";
import { BriefingPanel } from "./components/BriefingPanel";
import { FocusMode } from "./components/FocusMode";
import { AnalyticsView } from "./components/AnalyticsView";

// ─── Toast ────────────────────────────────────────────────────────────────────

interface Toast {
  id: string;
  type: "processed" | "draft_queued" | "info";
  message?: string;
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
            "pointer-events-auto flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium shadow-lg text-white transition-all duration-300",
            t.leaving ? "opacity-0 translate-y-2" : "animate-toast-in",
            t.type === "processed" ? "bg-indigo-600"
            : t.type === "draft_queued" ? "bg-blue-600"
            : "bg-gray-700",
          ].join(" ")}
        >
          {t.type === "processed" ? (
            <RefreshCw size={15} />
          ) : t.type === "draft_queued" ? (
            <MessageSquare size={15} />
          ) : (
            <CheckCircle size={15} />
          )}
          {t.message ?? (
            t.type === "processed" ? "Inbox processed"
            : t.type === "draft_queued" ? "Draft email queued"
            : "Done"
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

  const addToast = useCallback((
    type: "processed" | "draft_queued" | "info",
    message?: string,
  ) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message, leaving: false }]);

    setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    }, 1_700);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2_000);

    return id;
  }, []);

  return { toasts, addToast };
}

// ─── Undo state ───────────────────────────────────────────────────────────────

export interface UndoEntry {
  type: "approved" | "rejected" | "dismissed";
  startedAt: number;
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
  onResetSync,
}: {
  title: string;
  subtitle: string;
  lastUpdated: Date | null;
  error: string | null;
  onRefresh: () => void;
  onProcessInbox?: () => void;
  processingInbox?: boolean;
  onResetSync?: () => void;
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
          {onResetSync && (
            <button
              onClick={onResetSync}
              title="Reset Gmail sync cursor — forces next Sync Now to do a full inbox fetch (use if emails are missing)"
              className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-600 transition-colors hover:border-amber-300 hover:bg-amber-100 active:scale-95"
            >
              <RefreshCw size={12} />
              Reset Sync
            </button>
          )}
          {onProcessInbox && (
            <button
              onClick={onProcessInbox}
              disabled={processingInbox}
              title="Run a full sync: fetch emails, detect calendar conflicts, and surface commitment reminders"
              className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-600 transition-colors hover:border-indigo-300 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
            >
              <RefreshCw size={12} className={processingInbox ? "animate-spin" : ""} />
              {processingInbox ? "Syncing…" : "Sync Now"}
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

// ─── Google Auth Banner ───────────────────────────────────────────────────────

function GoogleAuthBanner({
  status,
  canStartOAuth,
  onDismiss,
  onLogout,
}: {
  status: "unconfigured" | "success" | "error";
  canStartOAuth: boolean;
  onDismiss: () => void;
  onLogout?: () => void;
}) {
  if (status === "success") {
    return (
      <div className="mb-4 flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
        <div className="flex items-center gap-2">
          <CheckCircle size={15} />
          <span>Google account connected. Gmail &amp; Calendar are ready.</span>
        </div>
        <div className="ml-4 flex items-center gap-2">
          {onLogout && (
            <button
              onClick={onLogout}
              className="rounded px-2 py-1 text-xs text-green-600 hover:bg-green-100 hover:text-green-800 transition-colors"
            >
              Sign out
            </button>
          )}
          <button onClick={onDismiss} className="text-green-500 hover:text-green-700">
            <XIcon size={14} />
          </button>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mb-4 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <div className="flex items-center gap-2">
          <AlertCircle size={15} />
          <span>Google sign-in failed. Check your Client ID &amp; Secret, then try again.</span>
        </div>
        <div className="ml-4 flex items-center gap-2">
          {canStartOAuth && (
            <a href="/pulse/auth/google" className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors">
              Retry
            </a>
          )}
          <button onClick={onDismiss} className="text-red-400 hover:text-red-600"><XIcon size={14} /></button>
        </div>
      </div>
    );
  }

  // unconfigured
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle size={15} />
          <span>Connect your Google account to enable Gmail &amp; Calendar.</span>
        </div>
        <div className="ml-4 flex items-center gap-2">
          {canStartOAuth && (
            <a
              href="/pulse/auth/google"
              className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 shadow-sm hover:bg-amber-50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 48 48" className="flex-shrink-0">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                <path fill="none" d="M0 0h48v48H0z"/>
              </svg>
              Sign in with Google
            </a>
          )}
          <button onClick={onDismiss} className="text-amber-500 hover:text-amber-700"><XIcon size={14} /></button>
        </div>
      </div>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<SidebarView>("queue");
  const [activityCollapsed, setActivityCollapsed] = useState(false);
  const [processingInbox, setProcessingInbox] = useState(false);
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(true);
  const [focusMode, setFocusMode] = useState(false);

  // Google OAuth banner
  const [authBanner, setAuthBanner] = useState<"unconfigured" | "success" | "error" | null>(null);
  const [canStartOAuth, setCanStartOAuth] = useState(false);
  const [isGoogleConnected, setIsGoogleConnected] = useState(false);

  // Chat drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingAutoSend, setPendingAutoSend] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [activeEmailDraft, setActiveEmailDraft] = useState<EmailDraftContext | null>(null);
  const [activeConflictContext, setActiveConflictContext] = useState<ConflictContext | null>(null);

  const { toasts, addToast } = useToasts();

  // IDs that have been optimistically hidden after the undo window expires.
  const [hiddenItemIds, setHiddenItemIds] = useState<Set<string>>(new Set());

  // In-card undo state: items currently showing the undo overlay.
  const [undoStates, setUndoStates] = useState<Map<string, UndoEntry>>(new Map());

  // Pending undo timers: itemId → cancel function
  const undoPending = useRef<Map<string, { cancel: () => void }>>(new Map());

  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    agentApi.fetchAgentId().then(setAgentId).catch(() => {});
  }, []);

  // Check OAuth callback result from query param, then poll auth status
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authParam = params.get("auth");

    if (authParam === "success") {
      setAuthBanner("success");
      setIsGoogleConnected(true);
      // Clean up URL without full reload
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    if (authParam === "error") {
      setAuthBanner("error");
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    // No callback param — check if Google is configured
    pulseApi.getAuthStatus()
      .then(({ configured, canStartOAuth: can }) => {
        setCanStartOAuth(can);
        setIsGoogleConnected(configured);
        if (!configured) setAuthBanner("unconfigured");
      })
      .catch(() => { /* silently ignore if backend not ready */ });
  }, []);

  // Fetch briefing on mount, then retry every 4s until data arrives (briefing
  // fires ~5s after agent start — frontend may load before it's ready).
  useEffect(() => {
    let cancelled = false;
    let retries = 0;
    const MAX_RETRIES = 8; // ~32 seconds total

    async function fetchBriefing() {
      setBriefingLoading(true);
      try {
        const r = await pulseApi.getBriefing();
        if (cancelled) return;
        if (r.briefing) {
          setBriefing(r.briefing);
          setBriefingLoading(false);
        } else if (retries < MAX_RETRIES) {
          retries++;
          setTimeout(fetchBriefing, 4_000);
        } else {
          setBriefingLoading(false);
        }
      } catch {
        if (!cancelled) setBriefingLoading(false);
      }
    }

    void fetchBriefing();
    return () => { cancelled = true; };
  }, []);

  function openChatWithContext(item: ActionItem) {
    const snippet = item.body
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim()
      .slice(0, 100) ?? "";
    setPendingAutoSend(`I need help with this item: "${item.title}". ${snippet}`);
    setActiveEmailDraft(null);

    if (item.type === "conflict_resolution") {
      const m = item.metadata as Record<string, unknown> | null;
      setActiveConflictContext({
        itemId:      item.id,
        eventAId:    m?.eventAId    as string | undefined,
        eventBId:    m?.eventBId    as string | undefined,
        eventATitle: (m?.eventATitle as string | undefined) ?? "Event A",
        eventBTitle: (m?.eventBTitle as string | undefined) ?? "Event B",
        eventAStart: m?.eventAStart as string | undefined,
        eventAEnd:   m?.eventAEnd   as string | undefined,
        eventBStart: m?.eventBStart as string | undefined,
        eventBEnd:   m?.eventBEnd   as string | undefined,
        date:        m?.date        as string | undefined,
      });
    } else {
      setActiveConflictContext(null);
    }

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
      // Refresh briefing panel after sync so it reflects the updated queue.
      try {
        const r = await pulseApi.getBriefing();
        if (r.briefing) setBriefing(r.briefing);
      } catch { /* non-fatal */ }
    } catch {
      // error surfaces via queue error banner
    } finally {
      setProcessingInbox(false);
    }
  }, [addToast, setBriefing]);

  // ─── Undo handler ────────────────────────────────────────────────────────────
  const handleUndo = useCallback((id: string) => {
    const entry = undoPending.current.get(id);
    if (entry) {
      entry.cancel();
      undoPending.current.delete(id);
    }
    setUndoStates((prev) => { const m = new Map(prev); m.delete(id); return m; });
    // Restore item if it was already hidden (edge case: timer fired just as user clicked)
    setHiddenItemIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
  }, []);

  // ─── Undo-aware approve ─────────────────────────────────────────────────────
  const approve = useCallback(
    async (id: string) => {
      // Cancel any existing undo for this item
      const existing = undoPending.current.get(id);
      if (existing) {
        existing.cancel();
        undoPending.current.delete(id);
      }

      // Show in-card undo overlay
      setUndoStates((prev) => new Map(prev).set(id, { type: "approved", startedAt: Date.now() }));

      let cancelled = false;
      const timer = setTimeout(async () => {
        if (cancelled) return;
        undoPending.current.delete(id);
        // Card disappears: hide + remove undo overlay
        setHiddenItemIds((prev) => new Set(prev).add(id));
        setUndoStates((prev) => { const m = new Map(prev); m.delete(id); return m; });
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
          refreshRef.current?.();
        } catch {
          // Restore on error so the item reappears
          setHiddenItemIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
        }
      }, UNDO_DELAY_MS);

      undoPending.current.set(id, { cancel: () => { cancelled = true; clearTimeout(timer); } });
    },
    [_approve, addToast]
  );

  // ─── Undo-aware reject ──────────────────────────────────────────────────────
  const reject = useCallback(
    async (id: string, reason?: string) => {
      setUndoStates((prev) => new Map(prev).set(id, { type: "rejected", startedAt: Date.now() }));
      let cancelled = false;
      const timer = setTimeout(async () => {
        if (cancelled) return;
        undoPending.current.delete(id);
        setHiddenItemIds((prev) => new Set(prev).add(id));
        setUndoStates((prev) => { const m = new Map(prev); m.delete(id); return m; });
        try { await _reject(id, reason); } catch {
          setHiddenItemIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
        }
        refreshRef.current?.();
      }, UNDO_DELAY_MS);

      undoPending.current.set(id, { cancel: () => { cancelled = true; clearTimeout(timer); } });
    },
    [_reject]
  );

  // ─── Dismiss (Skip without rejecting) ──────────────────────────────────────
  const dismiss = useCallback(
    async (id: string) => {
      setUndoStates((prev) => new Map(prev).set(id, { type: "dismissed", startedAt: Date.now() }));
      let cancelled = false;
      const timer = setTimeout(async () => {
        if (cancelled) return;
        undoPending.current.delete(id);
        setHiddenItemIds((prev) => new Set(prev).add(id));
        setUndoStates((prev) => { const m = new Map(prev); m.delete(id); return m; });
        try { await pulseApi.dismiss(id); } catch {
          setHiddenItemIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
        }
        refreshRef.current?.();
      }, UNDO_DELAY_MS);

      undoPending.current.set(id, { cancel: () => { cancelled = true; clearTimeout(timer); } });
    },
    []
  );

  // Filter out items that are permanently hidden (undo window expired + API called).
  // Items in undoStates are still visible (showing the undo overlay).
  const visibleItems = items.filter((i) => !hiddenItemIds.has(i.id));

  const pending      = status?.queue.pending ?? 0;
  const approved     = status?.queue.approved ?? 0;
  const rejected     = status?.queue.rejected ?? 0;
  const committedCount = visibleItems.filter((i) => i.type === "slib_reminder").length;

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
  const firstPendingItem = visibleItems.find((i) => i.status === "pending");

  useEffect(() => {
    document.title = pending > 0
      ? `Pulse (${pending}) — Chief of Staff`
      : "Pulse — Chief of Staff";
  }, [pending]);

  // Suppress unused-variable warnings for approved/rejected counts used in status bar
  void approved;
  void rejected;

  const viewTitle =
    view === "history" ? "History"
    : view === "commitments" ? "Commitments"
    : view === "analytics" ? "Analytics"
    : "Inbox";
  const viewSubtitle =
    view === "history"
      ? `${decisions?.total ?? 0} past decisions`
      : view === "commitments"
      ? committedCount === 0
        ? "No pending commitments"
        : `${committedCount} commitment${committedCount === 1 ? "" : "s"} need your attention`
      : view === "analytics"
      ? "Decision patterns and activity"
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
        isGoogleConnected={isGoogleConnected}
        onLogout={async () => {
          await pulseApi.logout();
          setIsGoogleConnected(false);
          setAuthBanner("unconfigured");
        }}
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
          {authBanner && (
            <GoogleAuthBanner
              status={authBanner}
              canStartOAuth={canStartOAuth}
              onDismiss={() => setAuthBanner(null)}
              onLogout={async () => {
                await pulseApi.logout();
                setAuthBanner("unconfigured");
              }}
            />
          )}

          <TopBar
            title={viewTitle}
            subtitle={viewSubtitle}
            lastUpdated={lastUpdated}
            error={error}
            onRefresh={refresh}
            onProcessInbox={view === "queue" ? handleProcessInbox : undefined}
            processingInbox={processingInbox}
            onResetSync={view === "queue" ? async () => {
              await pulseApi.resetSync();
              await handleProcessInbox();
            } : undefined}
          />

          {view === "analytics" && <AnalyticsView />}

          {view === "history" && (
            <HistoryView data={decisions} loading={loading} />
          )}

          {view === "commitments" && (
            <CommitmentsView
              items={visibleItems.filter((i) => i.type === "slib_reminder")}
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
                  items={visibleItems.filter((i) => i.status === "pending")}
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
                      items={visibleItems}
                      loading={loading}
                      onApprove={approve}
                      onReject={reject}
                      onDismiss={dismiss}
                      onAskPulse={openChatWithContext}
                      onEmailReview={openEmailDraft}
                      undoStates={undoStates}
                      onUndo={handleUndo}
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
        onClose={() => { setDrawerOpen(false); setActiveEmailDraft(null); setActiveConflictContext(null); }}
        agentId={agentId}
        autoSendText={pendingAutoSend}
        onAutoSendConsumed={() => setPendingAutoSend(null)}
        emailDraft={activeEmailDraft}
        conflictContext={activeConflictContext}
        onEmailSent={() => {
          refresh();
          addToast("info", "Email sent");
        }}
        onQueueRefresh={refresh}
        userDisplayName={status?.userDisplayName}
        pendingCount={pending}
        firstPendingTitle={firstPendingItem?.title}
      />

      <ToastContainer toasts={toasts} />
    </div>
  );
}
