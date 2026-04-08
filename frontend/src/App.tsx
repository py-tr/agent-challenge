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

      <main className="mx-auto max-w-7xl px-6 py-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left / main column: approval queue */}
          <section className="lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h1 className="text-lg font-semibold text-white">
                  Approval Queue
                </h1>
                <p className="text-xs text-slate-500">
                  {loading
                    ? "Loading…"
                    : items.length === 0
                    ? "Nothing pending"
                    : `${items.length} item${items.length === 1 ? "" : "s"} need your attention`}
                </p>
              </div>

              {/* Priority legend */}
              <div className="hidden flex-wrap gap-2 sm:flex">
                <Legend color="border-red-700 text-red-400" label="Conflict" />
                <Legend color="border-amber-700 text-amber-400" label="Commitment" />
                <Legend color="border-blue-700 text-blue-400" label="Email" />
                <Legend color="border-purple-700 text-purple-400" label="Follow-up" />
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
            <div className="mb-4">
              <h1 className="text-lg font-semibold text-white">History</h1>
              <p className="text-xs text-slate-500">Your past decisions</p>
            </div>
            <DecisionHistory data={decisions} loading={loading} />
          </section>
        </div>

        {/* Footer */}
        <footer className="mt-12 border-t border-slate-900 pt-6 text-center text-xs text-slate-700">
          Pulse runs on{" "}
          <span className="text-slate-500">Nosana decentralised GPU</span> ·
          Nothing is auto-sent · You decide everything
        </footer>
      </main>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span
      className={`badge border bg-transparent text-xs ${color}`}
    >
      {label}
    </span>
  );
}
