import { useEffect, useRef, useState } from 'react';
import type { JobSnapshot } from '../../types';
import { describeActivity } from './activity';

const TERMINAL = new Set(['ready', 'failed']);

function ProgressBar({ label, fraction }: { label: string; fraction: number | null }) {
  const determinate = fraction !== null;
  return <div
    className={`stage-progress-track ${determinate ? '' : 'indeterminate'}`}
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    {...(determinate ? { 'aria-valuenow': Math.round(fraction * 100) } : {})}
  >
    <div className="stage-progress-fill"
      style={determinate ? { transform: `scaleX(${fraction})` } : undefined} />
  </div>;
}

/** Live job progress shown inside the plate stage while the plate is prepared. */
export function StageProgress({ job }: { job: JobSnapshot }) {
  const [now, setNow] = useState(() => Date.now());
  const receivedAt = useRef(Date.now());
  const activityKey = JSON.stringify(job.activity ?? null);
  const lastKey = useRef(activityKey);
  if (lastKey.current !== activityKey) {
    lastKey.current = activityKey;
    receivedAt.current = Date.now();
  }
  const running = !TERMINAL.has(job.status);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);

  const activity = describeActivity(job.activity, Math.max(0, (now - receivedAt.current) / 1000));
  const startedAt = job.events?.[0]?.at;
  const total = typeof startedAt === 'number' ? Math.max(0, Math.round(now / 1000 - startedAt)) : null;
  const progress = Math.min(100, Math.max(0, job.progress));

  return <div className="stage-progress" role="status" aria-live="polite">
    <div className="stage-progress-head">
      <span className="stage-progress-stage">{job.stage || 'Preparing spectral plate'}</span>
      <span className="stage-progress-pct num">{progress}%</span>
    </div>
    <ProgressBar label="Overall progress" fraction={progress / 100} />
    {activity && <div className={`stage-progress-activity ${activity.overdue ? 'overdue' : ''}`}>
      <div className="stage-progress-head">
        <span>{activity.title}</span>
        <span className="num">{activity.detail}</span>
      </div>
      <ProgressBar label={activity.title} fraction={activity.fraction} />
    </div>}
    {total !== null && <small className="stage-progress-total num">Total {total} s</small>}
  </div>;
}

/** Compact status shown on the plate stage in every state. */
export function StageStatusChip({ job }: { job: JobSnapshot }) {
  const text = job.status === 'ready'
    ? 'Ready'
    : job.status === 'failed'
      ? `Failed${job.error_kind ? ` · ${job.error_kind}` : ''}`
      : `${job.progress}% · ${job.stage || job.status}`;
  return <span className={`stage-status-chip ${job.status}`} role="status">{text}</span>;
}
