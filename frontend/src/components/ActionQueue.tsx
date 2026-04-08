import { useState } from "react";
import type { ActionItem, ActionItemType } from "../api/pulseApi";
import { SlibGuardAlert } from "./SlibGuardAlert";

interface Props {
  items: ActionItem[];
  loading: boolean;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, reason?: string) => Promise<void>;
}

// ─── Type metadata ────────────────────────────────────────────────────────────

const TYPE_META: Record<
  ActionItemType,
  { label: string; icon: string; borderColor: string; badgeClass: string }
> = {
  email_draft: {
    label: "Email Draft",
    icon: "✉",
    borderColor: "border-blue-800/50",
    badgeClass: "bg-blue-900/60 text-blue-300",
  },
  conflict_resolution: {
    label: "Calendar Conflict",
    icon: "📅",
    borderColor: "border-red-800/50",
    badgeClass: "bg-red-900/60 text-red-300",
  },
  slib_reminder: {
    label: "Commitment",
    icon: "⏰",
    borderColor: "border-amber-800/50",
    badgeClass: "bg-amber-900/60 text-amber-300",
  },
  follow_up: {
    label: "Follow-up",
    icon: "↩",
    borderColor: "border-purple-800/50",
    badgeClass: "bg-purple-900/60 text-purple-300",
  },
};

// ─── Item card ────────────────────────────────────────────────────────────────

function ItemCard({
  item,
  onApprove,
  onReject,
}: {
  item: ActionItem;
  onApprove: () => Promise<void>;
  onReject: (reason?: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const meta = TYPE_META[item.type] ?? TYPE_META.email_draft;

  async function handle(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      setShowRejectInput(false);
    }
  }

  // Preview: first non-empty line of body
  const preview = item.body
    .split("\n")
    .find((l) => l.trim().length > 0 && !l.startsWith("#"))
    ?.replace(/\*\*(.+?)\*\*/g, "$1")
    .slice(0, 120);

  return (
    <article
      className={`animate-slide-in overflow-hidden rounded-xl border bg-surface-2 transition-all duration-200 hover:bg-surface-3 ${meta.borderColor}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 shrink-0 text-base">{meta.icon}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge ${meta.badgeClass}`}>{meta.label}</span>
              <span className="badge bg-slate-800 text-slate-400">
                Priority {item.priority}
              </span>
            </div>
            <h3 className="mt-1.5 text-sm font-semibold leading-snug text-white">
              {item.title}
            </h3>
          </div>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 shrink-0 rounded p-1 text-slate-500 hover:text-slate-300 transition-colors"
          title={expanded ? "Collapse" : "Expand"}
        >
          <svg
            className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Preview or expanded body */}
      <div className="px-4 py-3">
        {expanded ? (
          <BodyRenderer text={item.body} />
        ) : (
          preview && (
            <p className="line-clamp-2 text-sm text-slate-400">{preview}</p>
          )
        )}
      </div>

      {/* Reject reason input */}
      {showRejectInput && (
        <div className="px-4 pb-3">
          <input
            autoFocus
            type="text"
            placeholder="Reason (optional)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                void handle(() => onReject(rejectReason || undefined) as Promise<void>);
              if (e.key === "Escape") {
                setShowRejectInput(false);
                setRejectReason("");
              }
            }}
            className="w-full rounded-lg border border-slate-700 bg-surface-1 px-3 py-1.5 text-sm text-white placeholder-slate-600 focus:border-slate-500 focus:outline-none"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3">
        <span className="text-xs text-slate-600">
          {relativeTime(item.createdAt)}
        </span>
        <div className="flex gap-2">
          {!showRejectInput ? (
            <>
              <button
                onClick={() => setShowRejectInput(true)}
                disabled={busy}
                className="btn-reject text-xs"
              >
                ✕ Reject
              </button>
              <button
                onClick={() => handle(onApprove)}
                disabled={busy}
                className="btn-approve text-xs"
              >
                {busy ? "…" : "✓ Approve"}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setShowRejectInput(false);
                  setRejectReason("");
                }}
                className="btn border border-slate-700 text-xs text-slate-400"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  void handle(() => onReject(rejectReason || undefined) as Promise<void>)
                }
                disabled={busy}
                className="btn border border-red-800 bg-red-950/50 text-xs text-red-300 hover:bg-red-900/50"
              >
                {busy ? "…" : "Confirm reject"}
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

// ─── Markdown body renderer ───────────────────────────────────────────────────

function BodyRenderer({ text }: { text: string }) {
  const parts = text.split(/\n\n+/);
  return (
    <div className="space-y-2">
      {parts.map((para, i) => {
        if (para.startsWith("> ")) {
          const inner = para.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          return (
            <blockquote
              key={i}
              className="border-l-2 border-slate-600 pl-3 text-sm italic text-slate-300"
              dangerouslySetInnerHTML={{ __html: inner }}
            />
          );
        }
        const html = para.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        return (
          <p
            key={i}
            className="text-sm leading-relaxed text-slate-300"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      })}
    </div>
  );
}

// ─── Action Queue ─────────────────────────────────────────────────────────────

export function ActionQueue({ items, loading, onApprove, onReject }: Props) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className="h-28 animate-pulse rounded-xl border border-slate-800 bg-surface-2"
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 py-16 text-center">
        <span className="mb-3 text-3xl">✓</span>
        <p className="font-medium text-slate-400">All clear</p>
        <p className="mt-1 text-sm text-slate-600">
          No pending items — Pulse will notify you when something needs attention.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) =>
        item.type === "slib_reminder" ? (
          <SlibGuardAlert
            key={item.id}
            item={item}
            onApprove={() => onApprove(item.id)}
            onReject={(reason) => onReject(item.id, reason)}
          />
        ) : (
          <ItemCard
            key={item.id}
            item={item}
            onApprove={() => onApprove(item.id)}
            onReject={(reason) => onReject(item.id, reason)}
          />
        )
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (diff < 60_000) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
