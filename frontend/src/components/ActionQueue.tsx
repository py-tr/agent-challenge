import { useState, useRef, useEffect, useCallback } from "react";
import { Check, X, ChevronDown, ChevronUp, CheckCircle2, MessageSquare, Mail, ArrowUpDown, GitBranch, Undo2, Calendar, ArrowRight, Loader2 } from "lucide-react";
import type { ActionItem, ActionItemType } from "../api/pulseApi";
import { pulseApi } from "../api/pulseApi";
import type { UndoEntry } from "../App";
import { SlibGuardAlert } from "./SlibGuardAlert";

const UNDO_DELAY_MS = 3_000;

interface Props {
  items: ActionItem[];
  loading: boolean;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, reason?: string) => Promise<void>;
  onDismiss?: (id: string) => Promise<void>;
  onAskPulse?: (item: ActionItem) => void;
  onEmailReview?: (item: ActionItem) => void;
  undoStates?: Map<string, UndoEntry>;
  onUndo?: (id: string) => void;
}

// ─── Type metadata ────────────────────────────────────────────────────────────

const TYPE_META: Record<
  ActionItemType,
  { label: string; cta: string; borderColor: string; badgeClass: string; filterLabel: string }
> = {
  email_draft: {
    label: "Email Draft",
    cta: "Draft ready to send — review before sending",
    borderColor: "#3b82f6",
    badgeClass: "bg-blue-50 text-blue-700 ring-1 ring-blue-200/60",
    filterLabel: "Email",
  },
  conflict_resolution: {
    label: "Calendar Conflict",
    cta: "Reschedule needed — approve to resolve",
    borderColor: "#ef4444",
    badgeClass: "bg-red-50 text-red-700 ring-1 ring-red-200/60",
    filterLabel: "Conflict",
  },
  slib_reminder: {
    label: "Commitment Reminder",
    cta: "Commitment reminder — approve to confirm handled",
    borderColor: "#f59e0b",
    badgeClass: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/60",
    filterLabel: "Commitment",
  },
  follow_up: {
    label: "Follow-up",
    cta: "No reply detected — send a follow-up nudge?",
    borderColor: "#8b5cf6",
    badgeClass: "bg-violet-50 text-violet-700 ring-1 ring-violet-200/60",
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
    <div className="space-y-2">
      {parts.map((para, i) => {
        if (para.startsWith("> ")) {
          return (
            <blockquote
              key={i}
              className="border-l-[3px] border-gray-200 pl-3 text-sm italic text-gray-500 leading-relaxed"
            >
              {renderBold(para.slice(2))}
            </blockquote>
          );
        }
        return (
          <p key={i} className="text-sm leading-relaxed text-gray-600">
            {renderBold(para)}
          </p>
        );
      })}
    </div>
  );
}

// ─── Undo card ────────────────────────────────────────────────────────────────

function UndoCard({
  item,
  undoEntry,
  onUndo,
}: {
  item: ActionItem;
  undoEntry: UndoEntry;
  onUndo: () => void;
}) {
  const meta = TYPE_META[item.type] ?? TYPE_META.email_draft;
  // Compute remaining time at mount so the CSS animation starts from the correct position
  const [remaining] = useState(() =>
    Math.max(0, UNDO_DELAY_MS - (Date.now() - undoEntry.startedAt))
  );
  const isApproved  = undoEntry.type === "approved";
  const isDismissed = undoEntry.type === "dismissed";
  const label       = isApproved ? "Approved ✓" : isDismissed ? "Skipped" : "Rejected ✗";
  const accentColor = isApproved ? "#22c55e" : "#ef4444";

  const sourceConflictTitle =
    item.type === "email_draft"
      ? (item.metadata?.sourceConflictTitle as string | undefined)
      : undefined;

  const preview = item.body
    .split("\n")
    .find((l) => l.trim().length > 0 && !l.startsWith("#"))
    ?.replace(/\*\*(.+?)\*\*/g, "$1")
    .slice(0, 180);

  const cardStyle: React.CSSProperties = { borderLeft: `4px solid ${accentColor}` };
  const cardClass = [
    "overflow-hidden rounded-xl border border-l-4 transition-all duration-300",
    isApproved ? "bg-green-50/60 border-green-200 shadow-sm" : "bg-red-50/40 border-red-200 shadow-sm",
  ].join(" ");

  return (
    <article className={cardClass} style={cardStyle}>
      <div className="p-5">
        {/* Header — same layout as ItemCard */}
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
            {sourceConflictTitle && (
              <span className="inline-flex items-center gap-1 badge text-xs bg-violet-50 text-violet-600 ring-1 ring-violet-200/60">
                <GitBranch size={10} />
                From conflict
              </span>
            )}
          </div>
          <div className="flex flex-col items-end gap-0.5">
            {item.type === "email_draft" && item.metadata && formatEmailDate((item.metadata as Record<string, unknown>).date) && (
              <span className="text-xs text-gray-400 flex items-center gap-1">
                <Mail size={10} className="text-gray-300" />
                received {formatEmailDate((item.metadata as Record<string, unknown>).date)}
              </span>
            )}
            <span className="text-xs text-gray-300">added {relativeTime(item.createdAt)}</span>
          </div>
        </div>

        <h3 className="mt-3 text-base font-semibold leading-snug text-gray-500 line-through decoration-1">
          {item.title}
        </h3>

        {preview && (
          <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-gray-400">{preview}</p>
        )}
      </div>

      {/* Action footer — replaced with confirmation + undo */}
      <div className="flex items-center justify-between gap-2 border-t px-5 py-3"
        style={{ borderColor: isApproved ? "#bbf7d0" : "#fecaca",
                 backgroundColor: isApproved ? "rgb(240 253 244 / 0.6)" : "rgb(254 242 242 / 0.4)" }}
      >
        <span className="text-sm font-semibold" style={{ color: accentColor }}>
          {label}
        </span>
        <button
          onClick={onUndo}
          className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 hover:border-gray-400 active:scale-[0.97] transition-all shadow-sm"
        >
          <Undo2 size={12} />
          Undo
        </button>
      </div>

      {/* Drain bar — animates from full width to zero over the remaining undo window */}
      <div className="h-1" style={{ backgroundColor: isApproved ? "#dcfce7" : "#fee2e2" }}>
        <div
          className="h-full origin-left"
          style={{
            backgroundColor: accentColor,
            animationName: "drain-bar",
            animationDuration: `${remaining}ms`,
            animationTimingFunction: "linear",
            animationFillMode: "forwards",
          }}
        />
      </div>
    </article>
  );
}

// ─── Conflict card ────────────────────────────────────────────────────────────

type ConflictStep = "pick-event" | "pick-slot" | "confirming";

interface FreeSlot { start: string; end: string; label: string; }

function ConflictCard({
  item,
  focused,
  onApprove,
  onReject,
  onAskPulse,
}: {
  item: ActionItem;
  focused: boolean;
  onApprove: () => Promise<void>;
  onReject: (reason?: string) => Promise<void>;
  onAskPulse?: () => void;
}) {
  const meta = TYPE_META.conflict_resolution;
  const [step, setStep]       = useState<ConflictStep>("pick-event");
  const [slots, setSlots]     = useState<FreeSlot[]>([]);
  const [slotsErr, setSlotsErr] = useState<string | null>(null);
  const [chosenEventId, setChosenEventId] = useState<string | null>(null);
  const [chosenDuration, setChosenDuration] = useState(60);
  const [busy, setBusy]       = useState(false);
  const [expanded, setExpanded] = useState(false);

  const m = item.metadata as Record<string, unknown> | null;
  const eventAId    = m?.eventAId    as string | undefined;
  const eventBId    = m?.eventBId    as string | undefined;
  const eventATitle = (m?.eventATitle as string | undefined) ?? "Event A";
  const eventBTitle = (m?.eventBTitle as string | undefined) ?? "Event B";
  const eventAStart = m?.eventAStart as string | undefined;
  const eventBStart = m?.eventBStart as string | undefined;
  const eventAEnd   = m?.eventAEnd   as string | undefined;
  const eventBEnd   = m?.eventBEnd   as string | undefined;
  const date        = (m?.date       as string | undefined) ?? eventAStart?.slice(0, 10) ?? "";

  async function pickEvent(eventId: string, start?: string, end?: string) {
    setChosenEventId(eventId);
    const durMs = start && end
      ? new Date(end).getTime() - new Date(start).getTime()
      : 60 * 60_000;
    const dur = Math.max(15, Math.round(durMs / 60_000));
    setChosenDuration(dur);
    setStep("pick-slot");
    setBusy(true);
    setSlotsErr(null);
    try {
      const res = await pulseApi.findFreeSlots({
        date,
        durationMinutes: dur,
        excludeEventIds: [eventAId, eventBId].filter(Boolean) as string[],
      });
      setSlots(res.slots);
      if (res.slots.length === 0) setSlotsErr("No free slots found for this day.");
    } catch (e) {
      setSlotsErr(e instanceof Error ? e.message : "Failed to load slots");
    } finally {
      setBusy(false);
    }
  }

  async function pickSlot(slot: FreeSlot) {
    if (!chosenEventId) return;
    setBusy(true);
    setStep("confirming");
    try {
      await pulseApi.rescheduleEvent({
        eventId:  chosenEventId,
        newStart: slot.start,
        newEnd:   slot.end,
      });
      // Approve the item through the normal flow → triggers undo card + email draft
      await onApprove();
    } catch (e) {
      setSlotsErr(e instanceof Error ? e.message : "Reschedule failed");
      setStep("pick-slot");
      setBusy(false);
    }
  }

  const cardStyle: React.CSSProperties = focused
    ? { borderLeft: "4px solid #4f46e5" }
    : { borderLeft: `4px solid ${meta.borderColor}` };

  const cardClass = [
    "overflow-hidden rounded-xl border border-l-4 transition-all duration-300",
    focused ? "bg-indigo-50/30 border-indigo-200 shadow-md" : "bg-white border-gray-100 shadow-sm hover:shadow-md",
  ].join(" ");

  const preview = item.body
    .split("\n")
    .find((l) => l.trim().length > 0 && !l.startsWith("#"))
    ?.replace(/\*\*(.+?)\*\*/g, "$1")
    .slice(0, 180);

  return (
    <article className={cardClass} style={cardStyle}>
      <div className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`badge ${meta.badgeClass}`}>{meta.label}</span>
            {item.priority <= 2 && (
              <span className={`badge text-xs font-semibold ${
                item.priority === 1
                  ? "bg-red-50 text-red-600 ring-1 ring-red-200/60"
                  : "bg-amber-50 text-amber-600 ring-1 ring-amber-200/60"
              }`}>P{item.priority}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex flex-col items-end gap-0.5">
              {item.type === "email_draft" && item.metadata && formatEmailDate((item.metadata as Record<string, unknown>).date) && (
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <Mail size={10} className="text-gray-300" />
                  received {formatEmailDate((item.metadata as Record<string, unknown>).date)}
                </span>
              )}
              <span className="text-xs text-gray-300">added {relativeTime(item.createdAt)}</span>
            </div>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded-md p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-500 transition-colors"
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          </div>
        </div>

        <h3 className="mt-3 text-base font-semibold leading-snug text-gray-900">{item.title}</h3>

        {expanded ? (
          <div className="mt-3"><BodyRenderer text={item.body} /></div>
        ) : (
          preview && <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-gray-500">{preview}</p>
        )}

        {/* Step UI */}
        <div className="mt-4">
          {step === "pick-event" && (
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500 flex items-center gap-1.5">
                <Calendar size={12} className="text-red-400" />
                Which event should be rescheduled?
              </p>
              {!eventAId && !eventBId ? (
                <p className="text-xs text-gray-400 italic">
                  Calendar event IDs not available — use Ask Pulse to resolve this conflict via chat.
                </p>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  {[
                    { id: eventAId, title: eventATitle, start: eventAStart, end: eventAEnd },
                    { id: eventBId, title: eventBTitle, start: eventBStart, end: eventBEnd },
                  ].map((ev) => ev.id && (
                    <button
                      key={ev.id}
                      onClick={() => void pickEvent(ev.id!, ev.start, ev.end)}
                      disabled={busy}
                      className="flex flex-1 items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2 text-left text-xs font-medium text-red-800 hover:bg-red-100 hover:border-red-300 active:scale-[0.98] transition-all disabled:opacity-50"
                    >
                      <span className="truncate">{ev.title}</span>
                      <ArrowRight size={12} className="shrink-0 text-red-400" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === "pick-slot" && (
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500 flex items-center gap-1.5">
                <Calendar size={12} className="text-indigo-400" />
                Pick a new time:
              </p>
              {busy && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <Loader2 size={12} className="animate-spin" />
                  Finding free slots…
                </div>
              )}
              {!busy && slotsErr && (
                <p className="text-xs text-red-500">{slotsErr}</p>
              )}
              {!busy && !slotsErr && slots.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {slots.map((slot) => (
                    <button
                      key={slot.start}
                      onClick={() => void pickSlot(slot)}
                      disabled={busy}
                      className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 active:scale-[0.97] transition-all"
                    >
                      {slot.label}
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={() => setStep("pick-event")}
                disabled={busy}
                className="mt-2 text-xs text-gray-400 hover:text-gray-600 underline"
              >
                ← Back
              </button>
            </div>
          )}

          {step === "confirming" && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Loader2 size={12} className="animate-spin" />
              Rescheduling…
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-3">
        {onAskPulse ? (
          <button
            onClick={onAskPulse}
            disabled={busy}
            className="btn border border-indigo-200 bg-white py-1.5 px-3 text-xs font-medium text-indigo-600 hover:bg-indigo-50 hover:border-indigo-300 transition-colors disabled:opacity-50"
          >
            <MessageSquare size={12} />
            Ask Pulse
          </button>
        ) : <div />}
        <div className="flex items-center gap-2">
          <button
            onClick={() => void onReject()}
            disabled={busy}
            className="btn-reject py-1.5 px-3.5 text-xs"
          >
            <X size={13} />
            Reject
          </button>
          <button
            onClick={() => void onApprove()}
            disabled={busy}
            className="btn-approve py-1.5 px-3.5 text-xs"
          >
            <Check size={13} />
            Resolved
          </button>
        </div>
      </div>
    </article>
  );
}

// ─── Item card ────────────────────────────────────────────────────────────────

type FlashState = "idle" | "approve" | "reject";

function ItemCard({
  item,
  focused,
  onApprove,
  onReject,
  onDismiss,
  onAskPulse,
  onEmailReview,
}: {
  item: ActionItem;
  focused: boolean;
  onApprove: () => Promise<void>;
  onReject: (reason?: string) => Promise<void>;
  onDismiss?: () => Promise<void>;
  onAskPulse?: () => void;
  onEmailReview?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [flash, setFlash] = useState<FlashState>("idle");
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meta = TYPE_META[item.type] ?? TYPE_META.email_draft;

  // Detect if this draft was auto-created from a conflict resolution
  const sourceConflictTitle =
    item.type === "email_draft"
      ? (item.metadata?.sourceConflictTitle as string | undefined)
      : undefined;

  // Auto-fetch AI summary for email_draft items.
  // Strip agent-generated text (reply scaffold, action prompts) — only keep the
  // original sender's message so the LLM summarizes the actual email, not the draft.
  useEffect(() => {
    if (item.type !== "email_draft") return;
    const subject = typeof item.metadata?.subject === "string" ? item.metadata.subject : item.title;
    const from = typeof item.metadata?.from === "string" ? item.metadata.from : "";

    // Extract only the original message from the structured body.
    // Body format: **From:**\n**Subject:**\n---\n**Their message:**\n<original>\n---\n**Suggested reply scaffold:**...
    const ORIGINAL_MARKER = "**Their message:**\n";
    const SCAFFOLD_MARKER = "**Suggested reply scaffold:**";
    const APPROVE_MARKER  = "**Approve**";
    let bodyForSummary = item.body;
    const origStart = bodyForSummary.indexOf(ORIGINAL_MARKER);
    if (origStart !== -1) {
      const textStart = origStart + ORIGINAL_MARKER.length;
      const endA = bodyForSummary.indexOf("\n---\n", textStart);
      const endB = bodyForSummary.indexOf(SCAFFOLD_MARKER, textStart);
      const endC = bodyForSummary.indexOf(APPROVE_MARKER, textStart);
      const stop = Math.min(
        endA !== -1 ? endA : Infinity,
        endB !== -1 ? endB : Infinity,
        endC !== -1 ? endC : Infinity,
      );
      bodyForSummary = stop !== Infinity
        ? bodyForSummary.slice(textStart, stop).trim()
        : bodyForSummary.slice(textStart).trim();
    }
    // Fallback: strip everything after the first "---" separator
    if (!bodyForSummary || bodyForSummary === item.body) {
      const sepIdx = item.body.indexOf("\n---\n");
      if (sepIdx !== -1) bodyForSummary = item.body.slice(0, sepIdx).trim();
    }
    // If still nothing useful, use the snippet (first non-empty line)
    if (!bodyForSummary || bodyForSummary.length < 10) {
      bodyForSummary = item.body.split("\n").find((l) => l.trim().length > 10) ?? item.body;
    }

    pulseApi.summarizeEmail({ subject, from, body: bodyForSummary.slice(0, 500) })
      .then((r) => setAiSummary(r.summary))
      .catch(() => {}); // silent — summary is a nice-to-have
  }, [item.id, item.type]);

  useEffect(() => {
    return () => {
      if (animTimer.current) clearTimeout(animTimer.current);
    };
  }, []);

  async function handleApprove() {
    setFlash("approve");
    setBusy(true);
    try { await onApprove(); } finally { setBusy(false); }
  }

  async function handleReject(reason?: string) {
    setFlash("reject");
    setBusy(true);
    try { await onReject(reason); } finally {
      setBusy(false);
      setShowRejectInput(false);
      setRejectReason("");
    }
  }

  async function handleDismiss() {
    setFlash("reject");
    setBusy(true);
    try { await onDismiss?.(); } finally { setBusy(false); }
  }

  const preview = item.body
    .split("\n")
    .find((l) => l.trim().length > 0 && !l.startsWith("#"))
    ?.replace(/\*\*(.+?)\*\*/g, "$1")
    .slice(0, 180);

  const cardStyle: React.CSSProperties =
    flash === "approve"
      ? { borderLeft: "4px solid #22c55e" }
      : flash === "reject"
      ? { borderLeft: "4px solid #ef4444" }
      : focused
      ? { borderLeft: `4px solid #4f46e5` }
      : { borderLeft: `4px solid ${meta.borderColor}` };

  const cardClass = [
    "overflow-hidden rounded-xl border border-l-4 transition-all duration-300",
    flash === "approve" ? "bg-green-50/70 border-green-200 shadow-sm" :
    flash === "reject"  ? "bg-red-50/70 border-red-200 shadow-sm" :
    focused             ? "bg-indigo-50/30 border-indigo-200 shadow-md" :
                          "bg-white border-gray-100 shadow-sm hover:shadow-md",
  ].join(" ");

  return (
    <article className={cardClass} style={cardStyle}>
      <div className="p-5">
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
            {sourceConflictTitle && (
              <span className="inline-flex items-center gap-1 badge text-xs bg-violet-50 text-violet-600 ring-1 ring-violet-200/60">
                <GitBranch size={10} />
                From conflict
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex flex-col items-end gap-0.5">
              {item.type === "email_draft" && item.metadata && formatEmailDate((item.metadata as Record<string, unknown>).date) && (
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <Mail size={10} className="text-gray-300" />
                  received {formatEmailDate((item.metadata as Record<string, unknown>).date)}
                </span>
              )}
              <span className="text-xs text-gray-300">added {relativeTime(item.createdAt)}</span>
            </div>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded-md p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-500 transition-colors"
              title={expanded ? "Collapse" : "Expand"}
              aria-label={expanded ? "Collapse item" : "Expand item"}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          </div>
        </div>

        <h3 className="mt-3 text-base font-semibold leading-snug text-gray-900">{item.title}</h3>

        <p className="mt-1 text-xs font-medium" style={{ color: meta.borderColor }}>
          {meta.cta}
        </p>

        {/* AI summary chip — email_draft only */}
        {aiSummary && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md bg-indigo-50 px-2.5 py-1.5">
            <span className="mt-0.5 shrink-0 text-[10px] font-bold text-indigo-400 uppercase tracking-wide">AI</span>
            <p className="text-xs leading-relaxed text-indigo-700">{aiSummary}</p>
          </div>
        )}

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

      <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-3">
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

        <div className="flex items-center gap-2">
          {!showRejectInput ? (
            <>
              {/* Skip (email drafts only) — semantically "I'll handle outside Pulse" */}
              {item.type === "email_draft" && onDismiss && (
                <button
                  onClick={() => void handleDismiss()}
                  disabled={busy}
                  title="Skip — dismiss without rejecting. Handle outside Pulse."
                  className="btn border border-gray-200 bg-white py-1.5 px-3.5 text-xs text-gray-500 hover:bg-gray-50 hover:border-gray-300 active:scale-[0.97] disabled:opacity-50"
                >
                  Skip
                </button>
              )}
              <button
                onClick={() => setShowRejectInput(true)}
                disabled={busy}
                className="btn-reject py-1.5 px-3.5 text-xs"
              >
                <X size={13} />
                Reject
              </button>
              {item.type === "email_draft" && onEmailReview ? (
                <button
                  onClick={onEmailReview}
                  disabled={busy}
                  className="btn py-1.5 px-3.5 text-xs bg-green-600 text-white hover:bg-green-700 active:scale-[0.97]"
                >
                  <Mail size={13} />
                  Review &amp; Send
                </button>
              ) : (
                <button
                  onClick={() => void handleApprove()}
                  disabled={busy}
                  className="btn-approve py-1.5 px-3.5 text-xs"
                >
                  {busy ? "…" : (<><Check size={13} />Approve</>)}
                </button>
              )}
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

function EmptyState({ hasEverHadItems }: { hasEverHadItems: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-gray-100 bg-white px-8 py-24 text-center shadow-sm">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-green-50">
        <CheckCircle2 size={32} className="text-green-500" />
      </div>
      {hasEverHadItems ? (
        <>
          <h3 className="text-lg font-semibold text-gray-900">You're all caught up</h3>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-gray-500">
            Pulse will add items here as emails arrive, calendar conflicts are detected,
            and commitments come due.
          </p>
        </>
      ) : (
        <>
          <h3 className="text-lg font-semibold text-gray-900">No items yet</h3>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-gray-500">
            Click <strong>Check for New Emails</strong> above to fetch and classify your inbox.
            Pulse will create action items for anything that needs your attention.
          </p>
        </>
      )}
      <p className="mt-4 text-xs text-gray-400">Nothing is sent or acted on without your approval</p>
    </div>
  );
}

// ─── Keyboard shortcut hint ───────────────────────────────────────────────────

function KeyboardHint() {
  return (
    <p className="mb-3 text-right text-[10px] text-gray-400">
      <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono text-[10px]">J</kbd>
      {" / "}
      <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono text-[10px]">K</kbd>
      {" navigate · "}
      <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono text-[10px]">A</kbd>
      {" approve · "}
      <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono text-[10px]">R</kbd>
      {" reject"}
    </p>
  );
}

// ─── Action Queue ─────────────────────────────────────────────────────────────

export function ActionQueue({ items, loading, onApprove, onReject, onDismiss, onAskPulse, onEmailReview, undoStates, onUndo }: Props) {
  const [filter, setFilter] = useState<FilterType>("all");
  const [sortByPriority, setSortByPriority] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);

  const filtered = (() => {
    const base = filter === "all" ? items : items.filter((i) => i.type === filter);
    return sortByPriority ? [...base].sort((a, b) => a.priority - b.priority) : base;
  })();

  // Track whether items have ever existed (for empty state differentiation)
  const hasEverHadItems = items.length > 0 || !loading;

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't fire when user is typing in an input/textarea
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) return;

      if (filtered.length === 0) return;

      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        setFocusedIdx((prev) =>
          prev === null ? 0 : Math.min(prev + 1, filtered.length - 1)
        );
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setFocusedIdx((prev) =>
          prev === null ? filtered.length - 1 : Math.max(prev - 1, 0)
        );
      } else if ((e.key === "a" || e.key === "A") && focusedIdx !== null) {
        e.preventDefault();
        const item = filtered[focusedIdx];
        if (item) void onApprove(item.id);
      } else if ((e.key === "r" || e.key === "R") && focusedIdx !== null) {
        e.preventDefault();
        const item = filtered[focusedIdx];
        if (item) void onReject(item.id);
      } else if (e.key === "Escape") {
        setFocusedIdx(null);
      }
    },
    [filtered, focusedIdx, onApprove, onReject]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

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

  if (items.length === 0) return <EmptyState hasEverHadItems={hasEverHadItems} />;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <FilterPills items={items} active={filter} onChange={setFilter} />
        <button
          onClick={() => setSortByPriority((v) => !v)}
          title={sortByPriority ? "Switch to chronological order" : "Sort by priority (P1 first)"}
          className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
            sortByPriority
              ? "border-indigo-300 bg-indigo-50 text-indigo-700"
              : "border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:text-gray-700"
          }`}
        >
          <ArrowUpDown size={11} />
          {sortByPriority ? "Priority order" : "Sort by priority"}
        </button>
      </div>

      {filtered.length > 0 && <KeyboardHint />}

      <div className="space-y-4">
        {filtered.map((item, idx) => {
          const undoEntry = undoStates?.get(item.id);
          if (undoEntry) {
            return (
              <UndoCard
                key={item.id}
                item={item}
                undoEntry={undoEntry}
                onUndo={() => onUndo?.(item.id)}
              />
            );
          }
          if (item.type === "slib_reminder") {
            return (
              <SlibGuardAlert
                key={item.id}
                item={item}
                onApprove={() => onApprove(item.id)}
                onReject={(reason) => onReject(item.id, reason)}
                onAskPulse={onAskPulse ? () => onAskPulse(item) : undefined}
              />
            );
          }
          if (item.type === "conflict_resolution") {
            return (
              <ConflictCard
                key={item.id}
                item={item}
                focused={focusedIdx === idx}
                onApprove={() => onApprove(item.id)}
                onReject={(reason) => onReject(item.id, reason)}
                onAskPulse={onAskPulse ? () => onAskPulse(item) : undefined}
              />
            );
          }
          return (
            <ItemCard
              key={item.id}
              item={item}
              focused={focusedIdx === idx}
              onApprove={() => onApprove(item.id)}
              onReject={(reason) => onReject(item.id, reason)}
              onDismiss={onDismiss ? () => onDismiss(item.id) : undefined}
              onAskPulse={onAskPulse ? () => onAskPulse(item) : undefined}
              onEmailReview={onEmailReview ? () => onEmailReview(item) : undefined}
            />
          );
        })}

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
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Format an email received date from metadata.
 * Gmail `date` field is typically an RFC 2822 string or Unix timestamp in ms.
 * Returns a short human-readable label, e.g. "Mon 14 Apr, 09:32" or "2d ago".
 */
function formatEmailDate(raw: unknown): string | null {
  if (!raw) return null;
  let d: Date;
  if (typeof raw === "number") {
    d = new Date(raw > 1e12 ? raw : raw * 1000); // ms vs s
  } else if (typeof raw === "string") {
    d = new Date(raw);
  } else {
    return null;
  }
  if (isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days >= 7) return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  if (days >= 1) return `${days}d ago`;
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
