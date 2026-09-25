import type { ReactNode } from "react";
import { Component } from "react";

interface ErrorBoundaryProps {
  /** Label shown when the child tree throws (e.g. "3D intro"). */
  label: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Minimal crash containment for client-only trees (WebGL hero, dashboard).
 * A thrown error (bad WS URL, missing GPU, R3F failure) renders a static
 * fallback panel instead of blanking the whole page. No logging side-channel.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="glass-panel mx-auto flex w-full max-w-xl flex-col gap-2 px-6 py-8 text-center"
        >
          <p className="font-mono text-[11px] tracking-[0.25em] text-rose-200 uppercase">
            {this.props.label} unavailable
          </p>
          <p className="text-sm text-slate-300">
            Something failed to load here. Reload the page to try again.
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}
