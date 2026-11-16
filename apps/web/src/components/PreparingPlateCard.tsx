import { useEffect, useState } from 'react';
import type { JobEvent, JobSnapshot } from '../types/types';

interface PreparingPlateCardProps {
  job: JobSnapshot;
  onOpenPlate: (jobId: string) => void;
  onRetry: () => void;
  onDismiss?: () => void;
  embedded?: boolean;
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

function getEventLabel(event: JobEvent): string {
  if (
    event.event_type !== 'discovery_attempt' ||
    !event.provider ||
    typeof event.attempt !== 'number' ||
    typeof event.max_attempts !== 'number'
  ) {
    return event.stage;
  }

  const outcome = event.outcome === 'started'
    ? 'in progress'
    : event.outcome === 'succeeded'
      ? `succeeded${typeof event.result_count === 'number' ? ` · ${event.result_count} products` : ''}`
      : event.outcome === 'failed'
        ? 'failed'
        : 'status unavailable';
  const retry = event.outcome === 'failed' && event.will_retry ? '; retrying' : '';
  return `${event.provider} · Attempt ${event.attempt} of ${event.max_attempts} ${outcome}${retry}`;
}

export function PreparingPlateCard({
  job,
  onOpenPlate,
  onRetry,
  onDismiss,
  embedded = false,
}: PreparingPlateCardProps) {
  const [now, setNow] = useState(() => Date.now());
  const currentStageIdx = getStageIndex(job.status);
  const isFailed = job.status === 'failed';
  const isReady = job.status === 'ready';
  const discoveryEvents = (job.events ?? []).filter(
    (event) => event.event_type === 'discovery_attempt',
  );
  const latestDiscoveryEvent = discoveryEvents[discoveryEvents.length - 1];
  const retryDeadline = job.status === 'discovering' && latestDiscoveryEvent?.outcome === 'failed' && latestDiscoveryEvent.will_retry
    ? latestDiscoveryEvent.at * 1000 + (latestDiscoveryEvent.retry_after_seconds ?? 0) * 1000
    : null;
  useEffect(() => {
    if (isFailed || isReady) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [isFailed, isReady]);
  const retrySeconds = retryDeadline === null ? null : Math.max(0, Math.ceil((retryDeadline - now) / 1000));
  const startedAt = job.events?.[0]?.at;
  const elapsedSeconds = typeof startedAt === 'number' ? Math.max(0, Math.floor((now - startedAt * 1000) / 1000)) : null;
  const discoveryAttemptCount = new Set(
    discoveryEvents
      .map((event) => event.attempt)
      .filter((attempt): attempt is number => typeof attempt === 'number'),
  ).size;

  return (
    <div
      className={`preparing-card float ${embedded ? 'embedded' : ''} ${isFailed ? 'failed' : ''} ${isReady ? 'ready' : ''}`}
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

      {retrySeconds !== null && !isFailed && (
        <p className="preparing-retry-note" aria-live="polite">
          {retrySeconds > 0 ? `Next discovery attempt in ${retrySeconds}s` : 'Starting the next discovery attempt…'}
        </p>
      )}

      <small>Job {job.id} · {job.cache.hit ? 'Cache hit' : 'Preparing / computed'}
        {elapsedSeconds !== null && ` · ${elapsedSeconds}s elapsed`}
      </small>
      {Boolean(job.events?.length) && (
        <details className="preparing-trace">
          <summary>
            Execution trace
            {discoveryAttemptCount > 0 && (
              <span> · {discoveryAttemptCount} discovery {discoveryAttemptCount === 1 ? 'attempt' : 'attempts'}</span>
            )}
          </summary>
          <ol className="preparing-trace-list">
            {job.events?.map((event, i) => {
              const occurredAt = new Date(event.at * 1000);
              const timeLabel = Number.isFinite(occurredAt.getTime())
                ? occurredAt.toLocaleTimeString()
                : 'Unknown time';
              return (
                <li
                  key={`${event.at}-${i}`}
                  className={`preparing-trace-event ${event.outcome ?? ''}`}
                >
                  <time className="preparing-trace-time">{timeLabel}</time>
                  <div className="preparing-trace-copy">
                    <span>{getEventLabel(event)}</span>
                    {event.detail && <span className="preparing-trace-detail">{event.detail}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </details>
      )}
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
          {latestDiscoveryEvent?.outcome === 'failed' &&
            !latestDiscoveryEvent.will_retry &&
            typeof latestDiscoveryEvent.attempt === 'number' &&
            typeof latestDiscoveryEvent.max_attempts === 'number' && (
            <p className="discovery-attempt-failure">
              {latestDiscoveryEvent.provider} failed on attempt {latestDiscoveryEvent.attempt} of{' '}
              {latestDiscoveryEvent.max_attempts}.
            </p>
          )}
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
