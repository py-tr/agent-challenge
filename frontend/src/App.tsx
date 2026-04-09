import { useActionQueue } from "./hooks/useActionQueue";
import { StatusBar } from "./components/StatusBar";
import { ActionQueue } from "./components/ActionQueue";
import { DecisionHistory } from "./components/DecisionHistory";

export default function App() {
  const {
    items,
    status,
    decisions,
    loading,
    error,
    lastUpdated,
    approve,
    reject,
    refresh,
  } = useActionQueue();

  return (
    <div className="min-h-screen bg-surface-0 text-slate-200">
      <StatusBar
        status={status}
        lastUpdated={lastUpdated}
        error={error}
        onRefresh={refresh}
      />

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          {/* Left / main column: approval queue */}
          <section className="lg:col-span-2">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h1 className="text-sm font-semibold uppercase tracking-widest text-slate-500">
                  Approval Queue
                </h1>
                <p className="mt-1 text-xs text-slate-600">
                  {loading
                    ? "Loading…"
                    : items.length === 0
                    ? "Nothing pending"
                    : `${items.length} item${items.length === 1 ? "" : "s"} awaiting your decision`}
                </p>
              </div>

              <div className="hidden flex-wrap items-center gap-3 pt-0.5 sm:flex">
                <Legend color="bg-red-600" label="Conflict" />
                <Legend color="bg-amber-500" label="Commitment" />
                <Legend color="bg-blue-600" label="Email" />
                <Legend color="bg-purple-600" label="Follow-up" />
              </div>
            </div>

            <ActionQueue
              items={items}
              loading={loading}
              onApprove={approve}
              onReject={reject}
            />
          </section>

          {/* Right column: decision history */}
          <section className="lg:col-span-1">
            <div className="mb-6">
              <h1 className="text-sm font-semibold uppercase tracking-widest text-slate-500">
                Decision History
              </h1>
              <p className="mt-1 text-xs text-slate-600">Your past approvals and rejections</p>
            </div>
            <DecisionHistory data={decisions} loading={loading} />
          </section>
        </div>

        <footer className="mt-16 border-t border-slate-900 pt-6 text-center text-xs text-slate-800">
          Pulse runs on{" "}
          <span className="text-slate-700">Nosana decentralised GPU</span>
          {" "}·{" "}
          Nothing is auto-sent · You decide everything
        </footer>
      </main>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-600">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}
