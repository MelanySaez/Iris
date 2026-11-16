import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Name shown to the visitor, for example "Spectral Lab". */
  workspace: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Without a boundary, any render error unmounts the whole app and leaves a
 * black screen. This keeps the failure inside one workspace: the top bar and
 * the other tabs stay usable, and the visitor can retry or reload.
 */
export class WorkspaceErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Iris] ${this.props.workspace} crashed:`, error, info.componentStack ?? '');
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="workspace-error" role="alert">
        <h2>Something went wrong in {this.props.workspace}</h2>
        <p className="workspace-error-message">{error.message || String(error)}</p>
        <p>The other tabs still work. Try again, or reload the page if it keeps happening.</p>
        <div className="workspace-error-actions">
          <button type="button" onClick={this.retry}>Try again</button>
          <button type="button" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </div>
    );
  }
}
