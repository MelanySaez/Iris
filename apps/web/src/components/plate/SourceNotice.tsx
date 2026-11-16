import { useState } from 'react';
import type { JobFrame, JobSnapshot } from '../../types/types';

type DataSource = JobFrame['source'];

const SOURCE_LABELS: Record<DataSource, string> = {
  remote: 'IRSA',
  s3: 'S3',
  mixed: 'MIXED',
  cube: 'DR1 All-Sky Cube (S3)',
  upload: 'Uploaded FITS',
};

/** Human-readable name of the service a frame or cutout came from. */
export function sourceLabel(source: string | null | undefined): string {
  if (!source) return '—';
  return SOURCE_LABELS[source as DataSource] ?? source.toUpperCase();
}

/** True when the job was served by the DR1 All-Sky Cube fallback. */
export function isCubeFallback(job: JobSnapshot): boolean {
  if (job.discovery?.coverage_state === 'cube_fallback') return true;
  return job.frames.length > 0 && job.frames.every(frame => frame.source === 'cube');
}

/**
 * Explains a cube fallback result: IRSA was unavailable, and the cube is one
 * combined image, so it carries no temporal information.
 */
export function CubeFallbackNotice({ job }: { job: JobSnapshot }) {
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  if (!isCubeFallback(job)) return null;
  if (dismissedFor === job.id) {
    return <button type="button" className="plate-fallback-chip" onClick={() => setDismissedFor(null)}>
      Fallback data: DR1 All-Sky Cube, no temporal information · show details
    </button>;
  }
  const notice = typeof job.discovery?.fallback_notice === 'string'
    ? job.discovery.fallback_notice
    : job.animation_reason ?? '';
  const span = notice.match(/from (\S+) to (\S+) into/);
  return <div className="plate-fallback-notice" role="status">
    <button type="button" className="notice-close-btn" aria-label="Dismiss fallback notice"
      onClick={() => setDismissedFor(job.id)}>×</button>
    <strong>Fallback data: IRSA TAP is unavailable.</strong>
    <p>
      This plate shows the SPHEREx DR1 All-Sky Cube read from S3
      {span ? `, which combines every observation from ${span[1]} to ${span[2]} into one image.` : ', which combines every observation into one image.'}
    </p>
    <p>
      <strong>No temporal information:</strong> individual epochs, timeline comparison and
      animation are unavailable for this result.
    </p>
    <p>The cube has no VARIANCE layer, and wavelengths are nominal channel centres, not calibrated values.</p>
  </div>;
}

/** States which of the user's files this plate shows and what it covers. */
export function UploadNotice({ job }: { job: JobSnapshot }) {
  const upload = job.upload;
  if (!upload) return null;
  const what = upload.format === 'dr1_cube_tile'
    ? 'DR1 All-Sky Cube tile · one image per channel, no epochs, no VARIANCE'
    : `SPHEREx Level-2 image · detector D${upload.detector}, one observation`;
  return <p className="plate-upload-notice" role="note">
    <strong>Your file:</strong> {upload.filename} · {what} · {upload.extent_arcmin.toFixed(1)}′ across.
  </p>;
}
