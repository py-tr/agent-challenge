import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Optional slot rendered above the default error card. */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console — never sent to an external service, no data leakage.
    console.error("[Pulse] Uncaught render error:", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div
        className="flex min-h-screen items-center justify-center p-8"
        style={{ backgroundColor: "#0f172a" }}
      >
        <div
          className="w-full max-w-md rounded-xl p-8 text-center space-y-5"
          style={{ backgroundColor: "#1e293b", border: "1px solid #334155" }}
        >
          <div className="flex justify-center">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-full"
              style={{ backgroundColor: "#450a0a" }}
            >
              <AlertTriangle size={28} style={{ color: "#ef4444" }} />
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-lg font-semibold text-white">
              Something went wrong
            </h1>
            <p className="text-sm" style={{ color: "#94a3b8" }}>
              An unexpected error occurred. Your data is safe — this is a
              display issue only.
            </p>
          </div>

          {/* Collapsed error detail — visible only in dev builds */}
          {import.meta.env.DEV && (
            <details className="text-left">
              <summary
                className="cursor-pointer text-xs font-mono select-none"
                style={{ color: "#ef4444" }}
              >
                {error.message}
              </summary>
              <pre
                className="mt-2 overflow-auto rounded p-3 text-[10px] font-mono leading-relaxed"
                style={{ backgroundColor: "#0f172a", color: "#f87171", maxHeight: "160px" }}
              >
                {error.stack}
              </pre>
            </details>
          )}

          <div className="flex justify-center gap-3 pt-1">
            <button
              onClick={this.handleReset}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
              style={{ backgroundColor: "#334155" }}
            >
              Try again
            </button>
            <button
              onClick={this.handleReload}
              className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
              style={{ backgroundColor: "#4f46e5" }}
            >
              <RefreshCw size={14} />
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
