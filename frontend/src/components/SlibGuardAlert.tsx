/**
 * SlibGuardAlert — highlighted card for commitment reminders.
 * Rendered by ActionQueue when item.type === "slib_reminder".
 */

import { useState } from "react";
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
          className="my-2 border-l-2 border-amber-700/60 pl-3 text-xs italic text-slate-400"
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
    <article className="animate-slide-in overflow-hidden rounded-lg border border-l-2 border-amber-800/50 border-l-amber-600 bg-surface-2">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-amber-900/30 bg-amber-950/20 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="badge bg-amber-950/60 text-amber-400 border border-amber-800/40 text-xs">
            Commitment
          </span>
          <span className="text-xs text-amber-500/80">
            You made a commitment — approve to confirm it's handled
          </span>
        </div>
        {meta?.deadline && (
          <span className="shrink-0 rounded bg-amber-950/60 border border-amber-800/40 px-2 py-0.5 text-xs text-amber-500">
            Due {formatDeadline(meta.deadline)}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="space-y-2 px-4 py-4">
        <h3 className="text-sm font-semibold text-slate-100">{item.title}</h3>
        <div className="space-y-1">{renderBody(item.body)}</div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-slate-800/50 px-4 py-2.5">
        <span className="text-xs text-slate-700">
          Detected {relativeTime(item.createdAt)}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => handle(onReject)}
            disabled={busy}
            className="btn border border-slate-800 text-xs text-slate-600 hover:border-slate-700 hover:text-slate-400 disabled:opacity-40"
          >
            Dismiss
          </button>
          <button
            onClick={() => handle(onApprove)}
            disabled={busy}
            className="btn bg-amber-700 text-xs text-white hover:bg-amber-600 active:scale-95 disabled:opacity-40"
          >
            {busy ? "…" : "Mark Handled"}
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
