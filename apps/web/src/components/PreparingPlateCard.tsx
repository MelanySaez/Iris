import type { JobSnapshot } from '../types';

interface PreparingPlateCardProps {
  job: JobSnapshot;
  onOpenPlate: (jobId: string) => void;
  onRetry: () => void;
  onDismiss?: () => void;
}

const STAGES = [
  { key: 'discovering', label: 'Discovering products' },
  { key: 'downloading', label: 'Downloading cutouts' },
  { key: 'extracting', label: 'Extracting LVF map' },
  { key: 'rendering', label: 'Rendering frames' },
];

function getStageIndex(status: string): number {
  switch (status) {
    case 'queued':
      return 0;
    case 'discovering':
      return 0;
    case 'downloading':
      return 1;
    case 'extracting':
      return 2;
    case 'rendering':
      return 3;
    case 'ready':
      return 4;
    default:
      return 0;
  }
}

export function PreparingPlateCard({
  job,
  onOpenPlate,
  onRetry,
  onDismiss,
}: PreparingPlateCardProps) {
  const currentStageIdx = getStageIndex(job.status);
  const isFailed = job.status === 'failed';
  const isReady = job.status === 'ready';

  return (
    <div
      className={`preparing-card float ${isFailed ? 'failed' : ''} ${isReady ? 'ready' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="preparing-header">
        <div>
          <h3 className="preparing-title">
            {isReady
              ? 'Spectral Plate Ready'
              : isFailed
                ? 'Plate Preparation Failed'
                : 'Preparing Spectral Plate'}
          </h3>
          <p className="preparing-sub">
            {job.region
              ? `${job.region.ra_deg.toFixed(4)}°, ${job.region.dec_deg.toFixed(4)}° · ${job.region.size_arcmin.toFixed(1)}′`
              : 'Selected region'}
          </p>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="card-close-btn"
            aria-label="Dismiss plate notification"
            onClick={onDismiss}
          >
            ×
          </button>
        )}
      </div>

      {!isFailed && (
        <div className="progress-section">
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{ transform: `scaleX(${Math.min(100, Math.max(0, job.progress)) / 100})` }}
            />
          </div>
          <div className="progress-info">
            <span className="stage-text">{job.stage || 'Processing DR1 assets...'}</span>
            <span className="progress-pct num">{job.progress}%</span>
          </div>
        </div>
      )}

      <small>Job {job.id} · {job.cache.hit ? 'Cache hit' : 'Preparing / computed'}</small>
      {Boolean(job.events?.length) && <details><summary>Execution trace</summary><ol>{job.events?.map((event, i) => <li key={i}>{new Date(event.at * 1000).toLocaleTimeString()} · {event.stage}</li>)}</ol></details>}
      {/* Staged checklist */}
      <ul className="stage-checklist">
        {STAGES.map((s, idx) => {
          let state = 'pending';
          if (isFailed) {
            state = idx <= currentStageIdx ? 'error' : 'pending';
          } else if (idx < currentStageIdx || isReady) {
            state = 'completed';
          } else if (idx === currentStageIdx) {
            state = 'active';
          }

          return (
            <li key={s.key} className={`checklist-item ${state}`}>
              <span className="stage-icon" aria-hidden="true">
                {state === 'completed' ? '✓' : state === 'error' ? '!' : state === 'active' ? '●' : '○'}
              </span>
              <span className="stage-name">
                {/* If active stage is downloading, display job.stage if it has details */}
                {s.key === 'downloading' && job.stage?.toLowerCase().includes('download')
                  ? job.stage
                  : s.label}
              </span>
            </li>
          );
        })}
      </ul>

      {isFailed && (
        <div className="error-box">
          <p className="error-detail">{job.error || 'Failed to prepare DR1 spectral cutout.'}</p>
          <button type="button" className="btn btn-retry" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {isReady && (
        <div className="ready-actions">
          <button
            type="button"
            className="btn btn-primary btn-open-plate"
            onClick={() => onOpenPlate(job.id)}
          >
            Open spectral plate →
          </button>
        </div>
      )}
    </div>
  );
}
