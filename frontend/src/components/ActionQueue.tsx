import { useState, useRef } from "react";
import { Check, X, ChevronDown, ChevronUp, CheckCircle2, MessageSquare } from "lucide-react";
import type { ActionItem, ActionItemType } from "../api/pulseApi";
import { SlibGuardAlert } from "./SlibGuardAlert";

interface Props {
  items: ActionItem[];
  loading: boolean;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, reason?: string) => Promise<void>;
  onAskPulse?: (title: string, body: string) => void;
}

// ─── Type metadata ────────────────────────────────────────────────────────────

const TYPE_META: Record<
  ActionItemType,
  { label: string; cta: string; borderColor: string; badgeClass: string; filterLabel: string }
> = {
  email_draft: {
    label: "Email Draft",
    cta: "Review this draft before sending",
    borderColor: "#3b82f6",
    badgeClass: "bg-blue-50 text-blue-700 ring-1 ring-blue-200/60",
    filterLabel: "Email",
  },
  conflict_resolution: {
    label: "Calendar Conflict",
    cta: "Reschedule needed",
    borderColor: "#ef4444",
    badgeClass: "bg-red-50 text-red-700 ring-1 ring-red-200/60",
    filterLabel: "Conflict",
  },
  slib_reminder: {
    label: "Commitment",
    cta: "You made a commitment — approve to confirm it's handled",
    borderColor: "#f59e0b",
    badgeClass: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/60",
    filterLabel: "Commitment",
  },
  follow_up: {
    label: "Follow-up",
    cta: "No reply received — approve to follow up",
    borderColor: "#8b5cf6",
    badgeClass: "bg-purple-50 text-purple-700 ring-1 ring-purple-200/60",
    filterLabel: "Follow-up",
  },
};

type FilterType = ActionItemType | "all";

// ─── Filter pills ─────────────────────────────────────────────────────────────

function FilterPills({
  items,
  active,
  onChange,
}: {
  items: ActionItem[];
  active: FilterType;
  onChange: (f: FilterType) => void;
}) {
  const types = (Object.keys(TYPE_META) as ActionItemType[]).filter((t) =>
    items.some((i) => i.type === t)
  );

  if (types.length <= 1) return null;

  return (
    <div className="mb-5 flex flex-wrap gap-2">
      <FilterPill label="All" count={items.length} active={active === "all"} onClick={() => onChange("all")} />
      {types.map((t) => {
        const meta = TYPE_META[t];
        const count = items.filter((i) => i.type === t).length;
        return (
          <FilterPill
            key={t}
            label={meta.filterLabel}
            count={count}
            active={active === t}
            onClick={() => onChange(t)}
          />
        );
      })}
    </div>
  );
}

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-indigo-300 bg-indigo-50 text-indigo-700"
          : "border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:text-gray-700"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
          active ? "bg-indigo-100 text-indigo-600" : "bg-gray-100 text-gray-500"
        }`}
      >
        {count}
      </span>
    </button>
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
              className="border-l-[3px] border-gray-200 pl-3 text-sm italic text-gray-500 leading-relaxed"
              dangerouslySetInnerHTML={{ __html: inner }}
            />
          );
        }
        const html = para.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        return (
          <p
            key={i}
            className="text-sm leading-relaxed text-gray-600"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      })}
    </div>
  );
}

// ─── Item card ────────────────────────────────────────────────────────────────

type FlashState = "idle" | "approve" | "reject" | "exit";

function ItemCard({
  item,
  onApprove,
  onReject,
  onAskPulse,
}: {
  item: ActionItem;
  onApprove: () => Promise<void>;
  onReject: (reason?: string) => Promise<void>;
  onAskPulse?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [flash, setFlash] = useState<FlashState>("idle");
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meta = TYPE_META[item.type] ?? TYPE_META.email_draft;

  function triggerExit(type: "approve" | "reject") {
    if (animTimer.current) clearTimeout(animTimer.current);
    setFlash(type);
    animTimer.current = setTimeout(() => setFlash("exit"), 200);
  }

  async function handleApprove() {
    triggerExit("approve");
    setBusy(true);
    try { await onApprove(); } finally { setBusy(false); }
  }

  async function handleReject(reason?: string) {
    triggerExit("reject");
    setBusy(true);
    try { await onReject(reason); } finally {
      setBusy(false);
      setShowRejectInput(false);
      setRejectReason("");
    }
  }

  const preview = item.body
    .split("\n")
    .find((l) => l.trim().length > 0 && !l.startsWith("#"))
    ?.replace(/\*\*(.+?)\*\*/g, "$1")
    .slice(0, 180);

  // Dynamic inline style: flash overrides the type-based left border color
  const cardStyle: React.CSSProperties =
    flash === "approve"
      ? { borderLeft: "4px solid #22c55e" }
      : flash === "reject"
      ? { borderLeft: "4px solid #ef4444" }
      : { borderLeft: `4px solid ${meta.borderColor}` };

  const cardClass = [
    "overflow-hidden rounded-xl border border-l-4 transition-all duration-300",
    flash === "approve" ? "bg-green-50/70 border-green-200 shadow-sm" :
    flash === "reject"  ? "bg-red-50/70 border-red-200 shadow-sm" :
    flash === "exit"    ? "opacity-0 -translate-y-2 scale-[0.97] shadow-none pointer-events-none" :
                          "bg-white border-gray-100 shadow-sm hover:shadow-md",
  ].join(" ");

  return (
    <article className={cardClass} style={cardStyle}>
      {/* Card body */}
      <div className="p-5">
        {/* Top row: badges left, timestamp + expand right */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`badge ${meta.badgeClass}`}>{meta.label}</span>
            {item.priority <= 2 && (
              <span
                className={`badge text-xs font-semibold ${
                  item.priority === 1
                    ? "bg-red-50 text-red-600 ring-1 ring-red-200/60"
                    : "bg-amber-50 text-amber-600 ring-1 ring-amber-200/60"
                }`}
              >
                P{item.priority}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-gray-400">{relativeTime(item.createdAt)}</span>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded-md p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-500 transition-colors"
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          </div>
        </div>

        {/* Title */}
        <h3 className="mt-3 text-base font-semibold leading-snug text-gray-900">{item.title}</h3>

        {/* CTA */}
        <p className="mt-1 text-xs italic text-gray-400">{meta.cta}</p>

        {/* Body */}
        {expanded ? (
          <div className="mt-3">
            <BodyRenderer text={item.body} />
          </div>
        ) : (
          preview && (
            <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-gray-500">{preview}</p>
          )
        )}
      </div>

      {/* Reject reason input */}
      {showRejectInput && (
        <div className="border-t border-gray-100 px-5 py-3">
          <input
            autoFocus
            type="text"
            placeholder="Reason for rejection (optional — press Enter to confirm)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleReject(rejectReason || undefined);
              if (e.key === "Escape") { setShowRejectInput(false); setRejectReason(""); }
            }}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-3">
        {/* Ask Pulse — left side */}
        {onAskPulse && !showRejectInput ? (
          <button
            onClick={onAskPulse}
            disabled={busy}
            className="btn border border-indigo-200 bg-white py-1.5 px-3 text-xs font-medium text-indigo-600 hover:bg-indigo-50 hover:border-indigo-300 transition-colors disabled:opacity-50"
          >
            <MessageSquare size={12} />
            Ask Pulse
          </button>
        ) : (
          <div />
        )}

        {/* Approve / Reject — right side */}
        <div className="flex items-center gap-2">
          {!showRejectInput ? (
            <>
              <button
                onClick={() => setShowRejectInput(true)}
                disabled={busy}
                className="btn-reject py-1.5 px-3.5 text-xs"
              >
                <X size={13} />
                Reject
              </button>
              <button
                onClick={() => void handleApprove()}
                disabled={busy}
                className="btn-approve py-1.5 px-3.5 text-xs"
              >
                {busy ? "…" : (<><Check size={13} />Approve</>)}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => { setShowRejectInput(false); setRejectReason(""); }}
                className="btn border border-gray-200 bg-white py-1.5 px-3.5 text-xs text-gray-500 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleReject(rejectReason || undefined)}
                disabled={busy}
                className="btn bg-red-600 py-1.5 px-3.5 text-xs text-white hover:bg-red-700 active:scale-[0.97]"
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

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-gray-100 bg-white px-8 py-24 text-center shadow-sm">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-green-50">
        <CheckCircle2 size={32} className="text-green-500" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900">You're all caught up</h3>
      <p className="mt-2 max-w-xs text-sm leading-relaxed text-gray-500">
        Pulse will notify you when new items need your attention. Calendar conflicts, email
        drafts, and commitment reminders will appear here.
      </p>
      <p className="mt-4 text-xs text-gray-400">Nothing is sent or acted on without your approval</p>
    </div>
  );
}

// ─── Action Queue ─────────────────────────────────────────────────────────────

export function ActionQueue({ items, loading, onApprove, onReject, onAskPulse }: Props) {
  const [filter, setFilter] = useState<FilterType>("all");

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className="h-44 animate-pulse rounded-xl border border-gray-100 bg-white shadow-sm"
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) return <EmptyState />;

  const filtered = filter === "all" ? items : items.filter((i) => i.type === filter);

  return (
    <div>
      <FilterPills items={items} active={filter} onChange={setFilter} />

      <div className="space-y-4">
        {filtered.map((item) =>
          item.type === "slib_reminder" ? (
            <SlibGuardAlert
              key={item.id}
              item={item}
              onApprove={() => onApprove(item.id)}
              onReject={(reason) => onReject(item.id, reason)}
              onAskPulse={onAskPulse ? () => onAskPulse(item.title, item.body) : undefined}
            />
          ) : (
            <ItemCard
              key={item.id}
              item={item}
              onApprove={() => onApprove(item.id)}
              onReject={(reason) => onReject(item.id, reason)}
              onAskPulse={onAskPulse ? () => onAskPulse(item.title, item.body) : undefined}
            />
          )
        )}

        {filtered.length === 0 && filter !== "all" && (
          <p className="py-6 text-center text-sm text-gray-400">
            No {TYPE_META[filter as ActionItemType]?.filterLabel.toLowerCase()} items pending
          </p>
        )}
      </div>
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
