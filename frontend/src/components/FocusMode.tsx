/**
 * FocusMode — full-content single-item review experience.
 *
 * Shows one action item at a time, centred in the content area with large
 * action buttons. Designed for focused triage without distractions.
 *
 * Navigation: J / ↓ / ArrowDown → next, K / ↑ / ArrowUp → prev.
 * Keyboard: A → approve, R → start reject, Escape → exit focus mode.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Check,
  Mail,
  MessageSquare,
  Minimize2,
  Shield,
  AlertTriangle,
  FileText,
  GitBranch,
} from "lucide-react";
import type { ActionItem, ActionItemType } from "../api/pulseApi";

// ─── Type metadata ─────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<
  Exclude<ActionItemType, "follow_up">,
  {
    label: string;
    icon: React.ReactNode;
    accentClass: string;
    borderColor: string;
    ctaColor: string;
    cta: string;
  }
> = {
  email_draft: {
    label: "Email Draft",
    icon: <Mail size={18} />,
    accentClass: "text-blue-600",
    borderColor: "border-blue-200",
    ctaColor: "text-blue-500",
    cta: "Review carefully before sending — this will go to a real recipient.",
  },
  conflict_resolution: {
    label: "Calendar Conflict",
    icon: <AlertTriangle size={18} />,
    accentClass: "text-red-600",
    borderColor: "border-red-200",
    ctaColor: "text-red-500",
    cta: "Two calendar events overlap. Approve to start the resolution draft.",
  },
  slib_reminder: {
    label: "Commitment",
    icon: <Shield size={18} />,
    accentClass: "text-amber-600",
    borderColor: "border-amber-200",
    ctaColor: "text-amber-500",
    cta: "Pulse detected a commitment from your email. Approve to mark as handled.",
  },
};

// ─── Markdown body renderer (same security model as ActionQueue) ──────────────

function renderBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part
  );
}

function BodyRenderer({ text }: { text: string }) {
  const parts = text.split(/\n\n+/);
  return (
    <div className="space-y-3">
      {parts.map((para, i) => {
        if (para.startsWith("> ")) {
          return (
            <blockquote
              key={i}
              className="border-l-4 border-gray-200 pl-4 text-base italic text-gray-500 leading-relaxed"
            >
              {renderBold(para.slice(2))}
            </blockquote>
          );
        }
        return (
          <p key={i} className="text-base leading-relaxed text-gray-700">
            {renderBold(para)}
          </p>
        );
      })}
    </div>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  items: ActionItem[];
  onExit: () => void;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, reason?: string) => Promise<void>;
  onDismiss?: (id: string) => Promise<void>;
  onAskPulse?: (title: string, body: string) => void;
  onEmailReview?: (item: ActionItem) => void;
}

// ─── FocusMode ─────────────────────────────────────────────────────────────────

export function FocusMode({
  items,
  onExit,
  onApprove,
  onReject,
  onDismiss,
  onAskPulse,
  onEmailReview,
}: Props) {
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const rejectInputRef = useRef<HTMLInputElement>(null);

  // Items not yet dismissed in this session
  const visible = items.filter((i) => !dismissed.has(i.id));
  const clampedIdx = Math.min(idx, Math.max(0, visible.length - 1));
  const item = visible[clampedIdx] ?? null;

  const goNext = useCallback(() => {
    setIdx((prev) => Math.min(prev + 1, visible.length - 1));
    setShowRejectInput(false);
    setRejectReason("");
  }, [visible.length]);

  const goPrev = useCallback(() => {
    setIdx((prev) => Math.max(prev - 1, 0));
    setShowRejectInput(false);
    setRejectReason("");
  }, []);

  // Dismiss item from focus view, advance to next
  function dismissItem(id: string) {
    setDismissed((prev) => new Set([...prev, id]));
    // Index stays the same; the next item slides into position
  }

  async function handleApprove() {
    if (!item || busy) return;
    setBusy(true);
    try {
      await onApprove(item.id);
      dismissItem(item.id);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(reason?: string) {
    if (!item || busy) return;
    setBusy(true);
    try {
      await onReject(item.id, reason);
      dismissItem(item.id);
    } finally {
      setBusy(false);
      setShowRejectInput(false);
      setRejectReason("");
    }
  }

  async function handleDismiss() {
    if (!item || busy || !onDismiss) return;
    setBusy(true);
    try {
      await onDismiss(item.id);
      dismissItem(item.id);
    } finally {
      setBusy(false);
    }
  }

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Let the reject textarea handle its own keys
      if (document.activeElement === rejectInputRef.current) return;

      switch (e.key) {
        case "ArrowRight":
        case "j":
        case "J":
          e.preventDefault();
          goNext();
          break;
        case "ArrowLeft":
        case "k":
        case "K":
          e.preventDefault();
          goPrev();
          break;
        case "a":
        case "A":
          if (!showRejectInput) { e.preventDefault(); void handleApprove(); }
          break;
        case "r":
        case "R":
          if (!showRejectInput) {
            e.preventDefault();
            setShowRejectInput(true);
            setTimeout(() => rejectInputRef.current?.focus(), 50);
          }
          break;
        case "Escape":
          if (showRejectInput) {
            setShowRejectInput(false);
            setRejectReason("");
          } else {
            onExit();
          }
          break;
      }
    },
    [goNext, goPrev, showRejectInput, handleApprove, onExit]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // ─── Empty state ───────────────────────────────────────────────────────────
  if (visible.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-50">
          <Check size={28} className="text-green-500" />
        </div>
        <h2 className="text-lg font-semibold text-gray-900">All done</h2>
        <p className="mt-1 text-sm text-gray-500">You cleared the queue in Focus Mode.</p>
        <button
          onClick={onExit}
          className="mt-6 flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 shadow-sm hover:bg-gray-50 transition-colors"
        >
          <Minimize2 size={14} />
          Exit Focus Mode
        </button>
      </div>
    );
  }

  if (!item) return null;

  const cfg = TYPE_CONFIG[item.type as Exclude<ActionItemType, "follow_up">] ?? TYPE_CONFIG.email_draft;
  const sourceConflictTitle = item.metadata?.sourceConflictTitle as string | undefined;
  const isEmailDraft = item.type === "email_draft";

  return (
    <div className="mx-auto max-w-2xl">
      {/* Header bar */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={cfg.accentClass}>{cfg.icon}</span>
          <div>
            <span className="text-sm font-semibold text-gray-900">{cfg.label}</span>
            {item.priority <= 2 && (
              <span
                className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  item.priority === 1
                    ? "bg-red-100 text-red-600"
                    : "bg-amber-100 text-amber-600"
                }`}
              >
                P{item.priority}
              </span>
            )}
            {sourceConflictTitle && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-600 ring-1 ring-violet-200/60">
                <GitBranch size={9} />
                From conflict
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Navigation */}
          <div className="flex items-center gap-1">
            <button
              onClick={goPrev}
              disabled={clampedIdx === 0}
              className="rounded-lg border border-gray-200 bg-white p-1.5 text-gray-400 transition-colors hover:border-gray-300 hover:text-gray-600 disabled:opacity-30"
              title="Previous (K)"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="min-w-[48px] text-center text-xs text-gray-400 tabular-nums">
              {clampedIdx + 1} / {visible.length}
            </span>
            <button
              onClick={goNext}
              disabled={clampedIdx >= visible.length - 1}
              className="rounded-lg border border-gray-200 bg-white p-1.5 text-gray-400 transition-colors hover:border-gray-300 hover:text-gray-600 disabled:opacity-30"
              title="Next (J)"
            >
              <ChevronRight size={14} />
            </button>
          </div>

          <button
            onClick={onExit}
            title="Exit Focus Mode (Esc)"
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-700"
          >
            <Minimize2 size={12} />
            Exit
          </button>
        </div>
      </div>

      {/* Card */}
      <div className={`overflow-hidden rounded-2xl border-2 bg-white shadow-lg ${cfg.borderColor}`}>
        <div className="px-8 py-7">
          {/* Title */}
          <h2 className="text-xl font-bold leading-snug text-gray-900">{item.title}</h2>

          {/* CTA hint */}
          <p className={`mt-1.5 text-sm font-medium ${cfg.ctaColor}`}>{cfg.cta}</p>

          {/* Body */}
          <div className="mt-6 rounded-xl bg-gray-50 px-5 py-4">
            <BodyRenderer text={item.body} />
          </div>

          {/* Reject input */}
          {showRejectInput && (
            <div className="mt-4">
              <input
                ref={rejectInputRef}
                autoFocus
                type="text"
                placeholder="Reason for rejection (optional) — press Enter to confirm, Esc to cancel"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleReject(rejectReason || undefined);
                  if (e.key === "Escape") {
                    setShowRejectInput(false);
                    setRejectReason("");
                  }
                }}
                className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center justify-between gap-3 border-t border-gray-100 bg-gray-50/60 px-8 py-4">
          <div className="flex items-center gap-2">
            {onAskPulse && !showRejectInput && (
              <button
                onClick={() => onAskPulse(item.title, item.body)}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-white px-4 py-2 text-sm font-medium text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-50"
              >
                <MessageSquare size={14} />
                Ask Pulse
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!showRejectInput ? (
              <>
                {isEmailDraft && onDismiss && (
                  <button
                    onClick={() => void handleDismiss()}
                    disabled={busy}
                    title="Skip — handle outside Pulse"
                    className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-50"
                  >
                    Skip
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowRejectInput(true);
                    setTimeout(() => rejectInputRef.current?.focus(), 50);
                  }}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                >
                  <X size={14} />
                  Reject
                </button>
                {isEmailDraft && onEmailReview ? (
                  <button
                    onClick={() => onEmailReview(item)}
                    disabled={busy}
                    className="flex items-center gap-2 rounded-xl bg-green-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-green-700 active:scale-[0.98] disabled:opacity-50"
                  >
                    <Mail size={14} />
                    Review &amp; Send
                  </button>
                ) : (
                  <button
                    onClick={() => void handleApprove()}
                    disabled={busy}
                    className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 active:scale-[0.98] disabled:opacity-50"
                  >
                    {busy ? (
                      "…"
                    ) : (
                      <>
                        <Check size={14} />
                        Approve
                      </>
                    )}
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  onClick={() => { setShowRejectInput(false); setRejectReason(""); }}
                  className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleReject(rejectReason || undefined)}
                  disabled={busy}
                  className="rounded-xl bg-red-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 active:scale-[0.98] disabled:opacity-50"
                >
                  {busy ? "…" : "Confirm Reject"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Keyboard hint */}
      <p className="mt-4 text-center text-[10px] text-gray-400">
        <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono">J</kbd>
        {" / "}
        <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono">K</kbd>
        {" navigate · "}
        <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono">A</kbd>
        {" approve · "}
        <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono">R</kbd>
        {" reject · "}
        <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono">Esc</kbd>
        {" exit"}
      </p>

      {/* Unused items indicator */}
      {visible.length > 1 && (
        <div className="mt-3 flex justify-center gap-1">
          {visible.map((_, i) => (
            <button
              key={i}
              onClick={() => { setIdx(i); setShowRejectInput(false); }}
              className={`h-1.5 rounded-full transition-all ${
                i === clampedIdx
                  ? "w-4 bg-indigo-500"
                  : "w-1.5 bg-gray-300 hover:bg-gray-400"
              }`}
              aria-label={`Go to item ${i + 1}`}
            />
          ))}
        </div>
      )}

      {/* Hidden icon import to avoid tree-shaking FileText if used elsewhere */}
      <span className="hidden"><FileText size={0} /></span>
    </div>
  );
}
