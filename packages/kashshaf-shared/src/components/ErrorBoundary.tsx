import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render error in what it wraps and shows a message in its place,
 * rather than letting React unmount the whole tree to a white window. Used
 * around the readers: a state loop there ("Maximum update depth exceeded")
 * once took the app down with it.
 *
 * "Try again" remounts the children from scratch.
 */
export interface ErrorBoundaryProps {
  /** What the message calls the thing that failed: "The reader". */
  what: string;
  children: ReactNode;
  /** Called with the error, for a log or a report. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
  /** Bumped by "Try again" to remount the children. */
  attempt: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  reset = () => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <div role="alert" data-testid="error-boundary" className="flex-1 min-w-0 min-h-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm font-medium text-app-text-primary">{this.props.what} ran into a problem and stopped.</p>
          <p className="text-xs text-app-text-secondary font-mono max-w-lg break-words">{this.state.error.message}</p>
          <button
            type="button"
            onClick={this.reset}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-app-border-medium text-app-text-primary hover:bg-app-accent-light hover:text-app-accent"
          >
            Try again
          </button>
        </div>
      );
    }
    // The key remounts the subtree on "Try again"; a fragment adds no box to
    // the flex row the children sit in.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
