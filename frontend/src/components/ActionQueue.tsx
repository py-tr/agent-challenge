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
  {
    label: string;
    cta: string;
    accentClass: string;
    badgeClass: string;
  }
> = {
  email_draft: {
    label: "Email Draft",
    cta: "Review this draft before sending",
    accentClass: "border-l-blue-700",
    badgeClass: "bg-blue-950/60 text-blue-400 border border-blue-800/40",
  },
  conflict_resolution: {
    label: "Calendar Conflict",
    cta: "Reschedule needed",
    accentClass: "border-l-red-700",
    badgeClass: "bg-red-950/60 text-red-400 border border-red-800/40",
  },
  slib_reminder: {
    label: "Commitment",
    cta: "You made a commitment — approve to confirm it's handled",
    accentClass: "border-l-amber-600",
    badgeClass: "bg-amber-950/60 text-amber-400 border border-amber-800/40",
  },
  follow_up: {
    label: "Follow-up",
    cta: "No reply received — approve to follow up",
    accentClass: "border-l-purple-700",
    badgeClass: "bg-purple-950/60 text-purple-400 border border-purple-800/40",
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

  const preview = item.body
    .split("\n")
    .find((l) => l.trim().length > 0 && !l.startsWith("#"))
    ?.replace(/\*\*(.+?)\*\*/g, "$1")
    .slice(0, 140);

  return (
    <article
      className={`animate-slide-in overflow-hidden rounded-lg border border-slate-800/60 border-l-2 bg-surface-2 transition-colors hover:bg-surface-3 ${meta.accentClass}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`badge text-xs ${meta.badgeClass}`}>{meta.label}</span>
            <span className="badge bg-surface-3 text-slate-600 border border-slate-800/40 text-xs">
              Priority {item.priority}
            </span>
          </div>
          <h3 className="mt-2 text-sm font-semibold leading-snug text-slate-100">
            {item.title}
          </h3>
          <p className="mt-1 text-xs text-slate-600 font-medium">{meta.cta}</p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 shrink-0 rounded p-1 text-slate-700 hover:text-slate-400 transition-colors"
          title={expanded ? "Collapse" : "Expand"}
        >
          <ChevronIcon rotated={expanded} />
        </button>
      </div>

      {/* Preview or expanded body */}
      <div className="px-4 pb-3">
        {expanded ? (
          <BodyRenderer text={item.body} />
        ) : (
          preview && (
            <p className="line-clamp-2 text-xs text-slate-500 leading-relaxed">{preview}</p>
          )
        )}
      </div>

      {/* Reject reason input */}
      {showRejectInput && (
        <div className="px-4 pb-3">
          <input
            autoFocus
            type="text"
            placeholder="Reason for rejection (optional)"
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
            className="w-full rounded-md border border-slate-700 bg-surface-1 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-700 focus:border-slate-500 focus:outline-none"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-slate-800/50 px-4 py-2.5">
        <span className="text-xs text-slate-700">
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
                Reject
              </button>
              <button
                onClick={() => handle(onApprove)}
                disabled={busy}
                className="btn-approve text-xs"
              >
                {busy ? "…" : "Approve"}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setShowRejectInput(false);
                  setRejectReason("");
                }}
                className="btn border border-slate-800 text-xs text-slate-600 hover:text-slate-400"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  void handle(() => onReject(rejectReason || undefined) as Promise<void>)
                }
                disabled={busy}
                className="btn border border-red-900/60 bg-red-950/40 text-xs text-red-400 hover:bg-red-950/70"
              >
                {busy ? "…" : "Confirm Reject"}
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
    <div className="space-y-2 pt-1">
      {parts.map((para, i) => {
        if (para.startsWith("> ")) {
          const inner = para.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          return (
            <blockquote
              key={i}
              className="border-l-2 border-slate-700 pl-3 text-xs italic text-slate-400"
              dangerouslySetInnerHTML={{ __html: inner }}
            />
          );
        }
        const html = para.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        return (
          <p
            key={i}
            className="text-xs leading-relaxed text-slate-400"
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
      <div className="space-y-4">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className="h-32 animate-pulse rounded-lg border border-slate-800/50 bg-surface-2"
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-800/60 py-14 px-8 text-center">
        <div className="mx-auto mb-4 h-8 w-8 rounded-full border border-slate-800 bg-surface-3 flex items-center justify-center">
          <svg className="h-4 w-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <p className="text-sm font-medium text-slate-500">Queue is clear</p>
        <p className="mt-2 text-xs text-slate-700 max-w-xs mx-auto leading-relaxed">
          Pulse scans your inbox and calendar every 6 hours. When something
          needs your attention, it will appear here for your approval.
        </p>
        <div className="mt-5 flex flex-col gap-1.5 items-center text-xs text-slate-800">
          <span>1. Pulse detects an email, conflict, or commitment</span>
          <span>2. The item appears here for your review</span>
          <span>3. You approve or reject — nothing is sent automatically</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (diff < 60_000) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function ChevronIcon({ rotated }: { rotated: boolean }) {
  return (
    <svg
      className={`h-4 w-4 transition-transform ${rotated ? "rotate-180" : ""}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}
