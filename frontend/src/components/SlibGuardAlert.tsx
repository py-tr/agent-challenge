/**
 * SlibGuardAlert — commitment reminder card.
 * Rendered by ActionQueue when item.type === "slib_reminder".
 */

import { useState } from "react";
import { Check, X } from "lucide-react";
import type { ActionItem } from "../api/pulseApi";

interface Props {
  item: ActionItem;
  onApprove: () => Promise<void>;
  onReject: (reason?: string) => Promise<void>;
}

function renderBody(text: string) {
  const parts = text.split(/\n\n+/);
  return parts.map((para, i) => {
    if (para.startsWith("> ")) {
      const inner = para.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      return (
        <blockquote
          key={i}
          className="border-l-[3px] border-amber-300 pl-3 text-sm italic text-gray-600 leading-relaxed"
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
  });
}

export function SlibGuardAlert({ item, onApprove, onReject }: Props) {
  const [busy, setBusy] = useState(false);
  const meta = item.metadata as {
    deadline?: string;
    recipient?: string;
    verbatim?: string;
  } | null;

  async function handle(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50 shadow-sm transition-shadow hover:shadow-md"
      style={{ borderLeft: "4px solid #f59e0b" }}
    >
      {/* Card body */}
      <div className="p-5">
        {/* Top row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="badge bg-amber-100 text-amber-700 ring-1 ring-amber-200/60 uppercase tracking-wide text-[10px] font-bold">
              Commitment Reminder
            </span>
            {item.priority <= 2 && (
              <span
                className={`badge text-xs font-semibold ${
                  item.priority === 1
                    ? "bg-red-50 text-red-600 ring-1 ring-red-200/60"
                    : "bg-amber-100 text-amber-600 ring-1 ring-amber-200/60"
                }`}
              >
                P{item.priority}
              </span>
            )}
            {meta?.deadline && (
              <span className="rounded-full border border-amber-200 bg-white px-2.5 py-0.5 text-[10px] font-semibold text-amber-700">
                Due {formatDeadline(meta.deadline)}
              </span>
            )}
          </div>
          <span className="shrink-0 text-xs text-amber-600/70">{relativeTime(item.createdAt)}</span>
        </div>

        {/* Title */}
        <h3 className="mt-3 text-base font-semibold leading-snug text-gray-900">{item.title}</h3>
        <p className="mt-1 text-xs italic text-amber-600">
          You made a commitment — approve to confirm it's handled
        </p>

        {/* Body */}
        <div className="mt-3 space-y-2">{renderBody(item.body)}</div>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-end gap-2 border-t border-amber-100 bg-amber-100/40 px-5 py-3">
        <button
          onClick={() => handle(onReject)}
          disabled={busy}
          className="btn border border-amber-200 bg-white py-1.5 px-3.5 text-xs text-amber-700 hover:border-amber-300 hover:bg-amber-50 disabled:opacity-50"
        >
          <X size={13} />
          Dismiss
        </button>
        <button
          onClick={() => handle(onApprove)}
          disabled={busy}
          className="btn bg-amber-500 py-1.5 px-3.5 text-xs text-white hover:bg-amber-600 active:scale-[0.97] disabled:opacity-50 shadow-sm"
        >
          {busy ? (
            "…"
          ) : (
            <>
              <Check size={13} />
              Mark Handled
            </>
          )}
        </button>
      </div>
    </article>
  );
}

function formatDeadline(deadline: string): string {
  try {
    return new Date(deadline + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return deadline;
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (diff < 60_000) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
