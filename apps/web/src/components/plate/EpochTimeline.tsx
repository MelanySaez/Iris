import { useEffect, useRef, useState } from 'react';
import { formatDateIso } from '../../format';
import type { JobEvent, JobFrame } from '../../types';
import { sourceLabel } from './SourceNotice';

interface EpochTimelineProps {
  jobId: string;
  channel: number;
  frames: JobFrame[];
  ready: boolean;
  epoch: number;
  onSelect: (epoch: number) => void;
  onPlaybackStart: () => void;
  reason?: string | null;
  paused?: boolean;
}

/** Playback is restricted to verified calibrated epochs; manual inspection is not. */
export function EpochTimeline({ jobId, channel, frames, ready, epoch, onSelect, onPlaybackStart, reason, paused = false }: EpochTimelineProps) {
  const epochs = [...new Map(frames.filter(f => f.channel === channel).map(f => [f.epoch, f])).values()]
    .sort((a, b) => a.date_iso.localeCompare(b.date_iso) || a.epoch - b.epoch).slice(0, 12);
  const calibrated = epochs.filter(f => f.calibrated === true);
  const canAnimate = ready && calibrated.length >= 2 && calibrated.every(f => f.product === 'image');
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const currentRef = useRef(epoch);
  currentRef.current = epoch;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const epochKey = epochs.map(f => `${f.epoch}:${f.calibrated}`).join(',');

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const update = () => { setReducedMotion(media.matches); if (media.matches) setPlaying(false); };
    update(); media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  useEffect(() => { setPlaying(false); }, [jobId, channel, epochKey]);
  useEffect(() => { if (paused) setPlaying(false); }, [paused]);
  useEffect(() => {
    if (!playing || !canAnimate || reducedMotion) return;
    const timer = window.setInterval(() => {
      const index = calibrated.findIndex(f => f.epoch === currentRef.current);
      const next = calibrated[(index + 1) % calibrated.length].epoch;
      currentRef.current = next;
      selectRef.current(next);
    }, 500);
    return () => window.clearInterval(timer);
  }, [playing, canAnimate, reducedMotion, epochKey]);

  const step = (direction: number) => {
    setPlaying(false);
    const index = epochs.findIndex(f => f.epoch === epoch);
    const next = epochs[(Math.max(0, index) + direction + epochs.length) % epochs.length];
    if (next) onSelect(next.epoch);
  };

  return <div className="epoch-timeline" aria-label="Epoch timeline">
    <div className="epoch-multi-controls">
      <div className="epoch-chips-list">
        {epochs.map(frame => <button key={frame.epoch} type="button"
          className={`epoch-chip num ${epoch === frame.epoch ? 'active' : ''}`}
          aria-pressed={epoch === frame.epoch} onClick={() => { setPlaying(false); onSelect(frame.epoch); }}>
          {frame.source === 'cube'
            ? `${sourceLabel(frame.source)} · combined, no epochs`
            : <>{formatDateIso(frame.date_iso)} · {sourceLabel(frame.source)}
              {frame.calibrated === true ? ' · calibrated' : ' · approximate'}</>}
        </button>)}
      </div>
      <div className="epoch-actions">
        <button type="button" className="btn-epoch-toggle" aria-label="Previous epoch"
          disabled={epochs.length < 2} onClick={() => step(-1)}>Previous</button>
        <button type="button" className={`btn-epoch-toggle ${playing ? 'active' : ''}`}
          aria-label={playing ? 'Pause epochs' : 'Play epochs'} aria-pressed={playing}
          disabled={!canAnimate || reducedMotion} onClick={() => { if (!playing) onPlaybackStart(); setPlaying(v => !v); }}>
          {playing ? 'Pause' : 'Play'} · 2 fps
        </button>
        <button type="button" className="btn-epoch-toggle" aria-label="Next epoch"
          disabled={epochs.length < 2} onClick={() => step(1)}>Next</button>
        {canAnimate && <a className="btn-epoch-toggle" download href={`/api/jobs/${encodeURIComponent(jobId)}/animation.gif?channel_id=${channel}`}>Download GIF</a>}
      </div>
    </div>
    <p className="epoch-single-note" role="status">
      {canAnimate ? `${calibrated.length} calibrated epochs · shared display stretch · GIF is a display derivative.`
        : reason || 'At least two verified calibrated epochs are needed for playback and GIF export.'}
      {reducedMotion && ' Reduced motion is enabled; use Previous and Next to compare.'}
    </p>
  </div>;
}

/** Provider failures remain visible independently from successful image rendering. */
export function ProviderTrace({ events }: { events: JobEvent[] }) {
  const trace = events.filter(e => e.provider || e.fallback || e.coverage_state);
  if (!trace.length) return null;
  return <details className="provider-trace" open={trace.some(e => e.outcome === 'failed' || e.fallback)}>
    <summary>Data source and service status</summary>
    <ul>{trace.map((event, index) => <li key={`${event.at}-${index}`}>
      <strong>{event.provider || 'Discovery'}</strong>: {event.message || event.detail || event.stage}
      {event.fallback && event.coverage_state !== 'cube_fallback' && ' · S3 fallback attempted'}
      {event.coverage_state === 'cube_fallback' && ' · No temporal information: the cube combines every DR1 observation into one image.'}
      {event.coverage_state === 'unknown_not_indexed' && ' · Coverage unknown: this region is not indexed.'}
      {event.coverage_state === 'indexed_matches' && ' · Indexed products found; global coverage is not guaranteed.'}
    </li>)}</ul>
  </details>;
}
