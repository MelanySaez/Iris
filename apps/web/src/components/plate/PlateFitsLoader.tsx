import { useState } from 'react';
import { api, ApiError } from '../../api/api';
import type { JobSnapshot } from '../../types/types';

interface PlateFitsLoaderProps {
  /** Called with the ready plate once the server has read the file. */
  onOpened: (job: JobSnapshot) => void;
  /** The other way into Plate: select a region in Sky. */
  onBrowseSky: () => void;
}

type LoaderState =
  | { kind: 'idle' }
  | { kind: 'uploading'; name: string; percent: number }
  | { kind: 'processing'; name: string }
  | { kind: 'error'; message: string };

const ACCEPT = '.fits,.fit,.fts,application/fits,image/fits';
const MAX_UPLOAD_BYTES = 350_000_000;

/** Plate without a job: open the user's own SPHEREx FITS. */
export function PlateFitsLoader({ onOpened, onBrowseSky }: PlateFitsLoaderProps) {
  const [state, setState] = useState<LoaderState>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const busy = state.kind === 'uploading' || state.kind === 'processing';

  const open = async (file: File | undefined) => {
    if (!file || busy) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setState({ kind: 'error', message: 'The file exceeds the 350 MB upload limit. Choose a smaller FITS file.' });
      return;
    }
    setState({ kind: 'uploading', name: file.name, percent: 0 });
    try {
      const job = await api.uploadFits(file, (sent, total) => {
        const percent = total > 0 ? Math.round((sent / total) * 100) : 0;
        setState(sent >= total
          ? { kind: 'processing', name: file.name }
          : { kind: 'uploading', name: file.name, percent });
      });
      setState({ kind: 'idle' });
      onOpened(job);
    } catch (err) {
      const message = err instanceof ApiError ? (err.detail ?? err.message) : String(err);
      setState({ kind: 'error', message });
    }
  };

  return <section
    className={`plate-fits-loader ${dragging ? 'dragging' : ''}`}
    aria-label="Open a SPHEREx FITS"
    onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={(e) => {
      e.preventDefault();
      setDragging(false);
      void open(e.dataTransfer?.files?.[0]);
    }}
  >
    <h2>Open a spectral plate</h2>
    <p className="plate-fits-lead">
      Drop your own SPHEREx FITS here, or select a region in Sky to load DR1 data for it.
    </p>

    <label className={`plate-fits-pick ${busy ? 'disabled' : ''}`}>
      <input type="file" accept={ACCEPT} disabled={busy} aria-label="Choose a FITS file"
        onChange={(e) => { void open(e.target.files?.[0]); e.target.value = ''; }} />
      Choose a FITS file
    </label>

    {state.kind === 'uploading' && <div className="plate-fits-progress">
      <span>Uploading {state.name} · {state.percent}%</span>
      <div className="stage-progress-track" role="progressbar" aria-label={`Uploading ${state.name}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}>
        <div className="stage-progress-fill" style={{ transform: `scaleX(${state.percent / 100})` }} />
      </div>
    </div>}
    {state.kind === 'processing' && <div className="plate-fits-progress" role="status">
      <span>Reading {state.name} on the server…</span>
      <div className="stage-progress-track indeterminate" role="progressbar" aria-label={`Reading ${state.name}`}
        aria-valuemin={0} aria-valuemax={100}>
        <div className="stage-progress-fill" />
      </div>
    </div>}
    {state.kind === 'error' && <p className="plate-fits-error" role="alert">{state.message}</p>}

    <div className="plate-fits-formats">
      <h3>Files Plate can open</h3>
      <ul>
        <li>
          <strong>SPHEREx Level-2 image or cutout</strong> with IMAGE, VARIANCE and FLAGS
          and the WCS-WAVE table: every plate tool works for its detector&apos;s 17 channels.
        </li>
        <li>
          <strong>DR1 All-Sky Cube tile</strong> (<code>Npix…_cube.fits</code>), the format of
          the cube fallback: one image per channel, no VARIANCE and no epochs.
        </li>
      </ul>
      <p className="plate-fits-note">Up to 350 MB. Opened files are not saved in Records.</p>
    </div>

    <button type="button" className="plate-fits-sky" onClick={onBrowseSky}>
      Select a region in Sky
    </button>
  </section>;
}
