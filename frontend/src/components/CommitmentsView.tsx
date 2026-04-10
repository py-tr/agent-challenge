/**
 * CommitmentsView — full-page view for slib_reminder items.
 * Shows Slib Guard–tracked commitments with due-date filtering.
 */

import { useState } from "react";
import { Shield } from "lucide-react";
import type { ActionItem } from "../api/pulseApi";
import { SlibGuardAlert } from "./SlibGuardAlert";

type Filter = "all" | "due_soon" | "overdue";

interface Props {
  items: ActionItem[];
  loading: boolean;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, reason?: string) => Promise<void>;
  onAskPulse?: (title: string, body: string) => void;
}

function deadlineDate(item: ActionItem): Date | null {
  const meta = item.metadata as { deadline?: string } | null;
  if (!meta?.deadline) return null;
  try {
    return new Date(meta.deadline + "T12:00:00");
  } catch {
    return null;
  }
}

function isOverdue(item: ActionItem): boolean {
  const d = deadlineDate(item);
  return d !== null && d.getTime() < Date.now();
}

function isDueSoon(item: ActionItem): boolean {
  const d = deadlineDate(item);
  if (!d) return false;
  const diff = d.getTime() - Date.now();
  return diff > 0 && diff < 48 * 60 * 60 * 1000;
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

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-gray-100 bg-white px-8 py-20 text-center shadow-sm">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-50">
        <Shield size={26} className="text-amber-400" />
      </div>
      {filtered ? (
        <>
          <h3 className="text-base font-semibold text-gray-900">No matches</h3>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-gray-500">
            No commitments match this filter right now.
          </p>
        </>
      ) : (
        <>
          <h3 className="text-base font-semibold text-gray-900">No active commitments</h3>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-gray-500">
            Slib Guard monitors your outgoing emails automatically. Commitments will appear here
            when a deadline approaches.
          </p>
        </>
      )}
    </div>
  );
}

export function CommitmentsView({ items, loading, onApprove, onReject, onAskPulse }: Props) {
  const [filter, setFilter] = useState<Filter>("all");

  const overdueItems  = items.filter(isOverdue);
  const dueSoonItems  = items.filter(isDueSoon);

  const filtered =
    filter === "overdue"  ? overdueItems :
    filter === "due_soon" ? dueSoonItems :
    items;

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((n) => (
          <div key={n} className="h-44 animate-pulse rounded-xl border border-gray-100 bg-white shadow-sm" />
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Description */}
      <p className="mb-5 text-sm text-gray-500">
        Phrases you've committed to in emails, tracked by Slib Guard.
      </p>

      {/* Filter pills — only show when there's something to filter */}
      {items.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          <FilterPill
            label="All"
            count={items.length}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {dueSoonItems.length > 0 && (
            <FilterPill
              label="Due Soon"
              count={dueSoonItems.length}
              active={filter === "due_soon"}
              onClick={() => setFilter("due_soon")}
            />
          )}
          {overdueItems.length > 0 && (
            <FilterPill
              label="Overdue"
              count={overdueItems.length}
              active={filter === "overdue"}
              onClick={() => setFilter("overdue")}
            />
          )}
        </div>
      )}

      {/* Cards */}
      {filtered.length === 0 ? (
        <EmptyState filtered={filter !== "all"} />
      ) : (
        <div className="space-y-4">
          {filtered.map((item) => (
            <SlibGuardAlert
              key={item.id}
              item={item}
              onApprove={() => onApprove(item.id)}
              onReject={(reason) => onReject(item.id, reason)}
              onAskPulse={onAskPulse ? () => onAskPulse(item.title, item.body) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
