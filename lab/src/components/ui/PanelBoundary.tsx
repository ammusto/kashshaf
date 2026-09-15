import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * What a panel does when it throws.
 *
 * A panel reads data shaped by the backend, and a shape it did not expect
 * used to take the whole window white: the network panel crashed on every
 * unlinked transmitter because it read a node id as an object when the wire
 * carries a bare string. One panel's wrong assumption should cost that
 * panel, not the app, and it should say enough to be reported.
 */

interface Props {
  /** The panel's name, shown in the message and used to reset on switch. */
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

export class PanelBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? null });
    console.error(`[lab] ${this.props.name} panel failed`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    // Switching panels clears the failure: the next one deserves a chance.
    if (prev.name !== this.props.name && this.state.error) {
      this.setState({ error: null, stack: null });
    }
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-6" role="alert" data-testid="panel-error">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-app-error">The {this.props.name} panel could not draw.</h2>
          <p className="mt-2 text-sm text-app-text-secondary">
            Everything else still works, and nothing you have confirmed is affected. Switch panels and
            come back, or reopen the text. If it keeps happening, the message below is what to report.
          </p>
          <pre className="mt-4 p-3 text-xs bg-app-surface-variant border border-app-border-light rounded overflow-x-auto whitespace-pre-wrap">
            {error.message || String(error)}
          </pre>
          {stack && (
            <details className="mt-2">
              <summary className="text-xs text-app-text-secondary cursor-pointer">Where it happened</summary>
              <pre className="mt-2 p-3 text-[11px] bg-app-surface-variant border border-app-border-light rounded overflow-x-auto whitespace-pre-wrap">
                {stack.trim()}
              </pre>
            </details>
          )}
          <button
            onClick={() => this.setState({ error: null, stack: null })}
            className="mt-4 px-3 py-1.5 text-sm border border-app-border-medium rounded hover:bg-app-surface-variant"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
