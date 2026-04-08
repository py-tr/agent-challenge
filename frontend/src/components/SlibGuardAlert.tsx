/**
 * SlibGuardAlert — highlighted amber card for commitment reminders.
 * Rendered by ActionQueue when item.type === "slib_reminder".
 */

import { useState } from "react";
import type { ActionItem } from "../api/pulseApi";

interface Props {
  item: ActionItem;
  onApprove: () => Promise<void>;
  onReject: (reason?: string) => Promise<void>;
}

/** Very minimal markdown: **bold**, > blockquote, \n\n paragraphs */
function renderBody(text: string) {
  const parts = text.split(/\n\n+/);
  return parts.map((para, i) => {
    if (para.startsWith("> ")) {
      const inner = para.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      return (
        <blockquote
          key={i}
          className="my-2 border-l-2 border-amber-500 pl-3 text-slate-300 italic"
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
    <article className="animate-slide-in overflow-hidden rounded-xl border border-amber-800/60 bg-amber-950/20">
      {/* Amber header stripe */}
      <div className="flex items-center justify-between border-b border-amber-800/40 bg-amber-950/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-amber-400">⏰</span>
          <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
            Slib Guard — Commitment Reminder
          </span>
        </div>
        {meta?.deadline && (
          <span className="rounded-full bg-amber-900/60 px-2.5 py-0.5 text-xs font-medium text-amber-300">
            Due {formatDeadline(meta.deadline)}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="space-y-2 px-4 py-4">
        <h3 className="font-semibold text-white">{item.title}</h3>
        <div className="space-y-1">{renderBody(item.body)}</div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-amber-800/30 px-4 py-3">
        <span className="text-xs text-slate-600">
          Detected {relativeTime(item.createdAt)}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => handle(onReject)}
            disabled={busy}
            className="btn border border-slate-700 text-slate-400 hover:border-amber-700 hover:text-amber-300 disabled:opacity-40"
          >
            Dismiss
          </button>
          <button
            onClick={() => handle(onApprove)}
            disabled={busy}
            className="btn bg-amber-600 text-white hover:bg-amber-500 active:scale-95 disabled:opacity-40"
          >
            {busy ? "…" : "✓ On track"}
          </button>
        </div>
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
