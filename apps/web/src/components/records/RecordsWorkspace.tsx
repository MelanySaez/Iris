import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import {
  canOpenInPlate,
  describeSelectionRegion,
  describeSelectionView,
  failureDetails,
  RECORDS_PAGE_SIZE,
  removeSelection,
} from '../../records';
import { loadSelectionView } from '../../selectionView';
import type { FailureDetails } from '../../records';
import type { RegionRequest, SelectionSummary } from '../../types';

interface RecordsWorkspaceProps {
  onOpenPlate: (jobId: string) => void;
  /** Rebuild the selection box on the Sky map, back in the view where it was made. */
  onShowInSky?: (region: RegionRequest) => void;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.detail ?? err.message) : String(err);
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function FailureReason({ details }: { details: FailureDetails | null }) {
  if (!details) return null;
  return (
    <details className="records-status-error">
      <summary>
        <span className="when-closed">Show reason</span>
        <span className="when-open">Hide reason</span>
      </summary>
      <div className="records-failure">
        {(details.stage || details.kind) && (
          <dl className="records-failure-meta">
            {details.stage && (
              <>
                <dt>Stage</dt>
                <dd>{details.stage}</dd>
              </>
            )}
            {details.kind && (
              <>
                <dt>Kind</dt>
                <dd>{details.kind}</dd>
              </>
            )}
          </dl>
        )}
        <p className="records-failure-message">{details.message}</p>
        {details.timeline.length > 0 && (
          <ol className="records-failure-timeline" aria-label="Job timeline">
            {details.timeline.map((step, index) => (
              <li key={`${index}-${step.stage}`}>
                <span className="records-mono">{step.offset}</span> {step.stage}
              </li>
            ))}
          </ol>
        )}
        {details.trace && (
          <details className="records-failure-trace">
            <summary>Traceback</summary>
            <pre>{details.trace}</pre>
          </details>
        )}
      </div>
    </details>
  );
}

/** View mode the selection was made in: this browser's saved view first, else the recorded one. */
function ViewModeCell({ selection }: { selection: SelectionSummary }) {
  const view = describeSelectionView(selection, loadSelectionView(selection.region));
  if (!view) {
    return (
      <span className="records-muted" title="Selected before view modes were recorded">
        —
      </span>
    );
  }
  return (
    <span title={view.source === 'cache' ? 'Saved view in this browser' : 'Recorded by the backend'}>
      {view.label}
    </span>
  );
}

export function RecordsWorkspace({ onOpenPlate, onShowInSky }: RecordsWorkspaceProps) {
  const [items, setItems] = useState<SelectionSummary[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadPage = useCallback(async (before?: string) => {
    setLoading(true);
    try {
      const page = await api.listSelections({ limit: RECORDS_PAGE_SIZE, before });
      setItems((prev) => (before ? [...prev, ...page.items] : page.items));
      setNextBefore(page.next_before);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const handleDelete = async (selection: SelectionSummary) => {
    const label = describeSelectionRegion(selection);
    if (!window.confirm(`Delete the saved selection at ${label}?`)) return;
    setDeletingId(selection.id);
    try {
      await api.deleteSelection(selection.id);
      setItems((prev) => removeSelection(prev, selection.id));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="records-workspace" aria-labelledby="records-title">
      <header className="records-header">
        <div>
          <h2 id="records-title">Saved selections</h2>
          <p className="records-sub">Every region selected in Sky is saved automatically.</p>
        </div>
        <button type="button" className="records-btn" onClick={() => void loadPage()} disabled={loading}>
          Refresh
        </button>
      </header>

      {error && (
        <p className="records-error" role="alert">
          {error}
        </p>
      )}

      {!loading && !error && items.length === 0 && (
        <p className="records-empty">No saved selections yet. Select a region in Sky to create one.</p>
      )}

      {items.length > 0 && (
        <table className="records-table">
          <thead>
            <tr>
              <th scope="col">Last seen</th>
              <th scope="col">Region</th>
              <th scope="col">Channels</th>
              <th scope="col">View</th>
              <th scope="col">Products</th>
              <th scope="col">Coverage</th>
              <th scope="col">Status</th>
              <th scope="col">Hits</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((selection) => (
              <tr key={selection.id}>
                <td>{formatTimestamp(selection.last_seen_at)}</td>
                <td className="records-mono">{describeSelectionRegion(selection)}</td>
                <td className="records-mono">{selection.channels.join(', ')}</td>
                <td className="records-mono">
                  <ViewModeCell selection={selection} />
                </td>
                <td>{selection.products.join(', ')}</td>
                <td>{selection.region.coverage}</td>
                <td>
                  <span className={`records-status status-${selection.job_status}`}>{selection.job_status}</span>
                  <FailureReason details={failureDetails(selection)} />
                </td>
                <td className="records-mono">{selection.hits}</td>
                <td className="records-actions">
                  <div className="records-actions-inner">
                    {onShowInSky && (
                      <button
                        type="button"
                        className="records-btn"
                        title="Rebuild this selection on the Sky map"
                        onClick={() =>
                          onShowInSky({
                            ra_deg: selection.region.ra_deg,
                            dec_deg: selection.region.dec_deg,
                            size_arcmin: selection.region.size_arcmin,
                          })
                        }
                      >
                        Show in Sky
                      </button>
                    )}
                    <button
                      type="button"
                      className="records-btn"
                      disabled={!canOpenInPlate(selection)}
                      title={canOpenInPlate(selection) ? 'Open in Plate' : 'Only ready jobs can be opened'}
                      onClick={() => onOpenPlate(selection.job_id)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="records-btn danger"
                      disabled={deletingId === selection.id}
                      onClick={() => void handleDelete(selection)}
                    >
                      {deletingId === selection.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {loading && <p className="records-empty" role="status">Loading saved selections…</p>}

      {!loading && nextBefore && (
        <button type="button" className="records-btn records-more" onClick={() => void loadPage(nextBefore)}>
          Load more
        </button>
      )}
    </section>
  );
}
