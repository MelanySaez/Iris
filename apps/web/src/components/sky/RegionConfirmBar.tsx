import { useState } from 'react';
import { MAX_SELECTION_NAME_LENGTH, normalizeSelectionName } from '../../services/records';
import { formatDec, formatRa } from '../../utils/format';
import type { RegionRequest } from '../../types/types';

interface RegionConfirmBarProps {
  region: RegionRequest;
  onConfirm: (name?: string) => void;
  /** Throws the draft region away. */
  onDiscard: () => void;
}

/** Draft region card above the channel dock: confirm it, or discard it with the close button. */
export function RegionConfirmBar({ region, onConfirm, onDiscard }: RegionConfirmBarProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="region-confirm-bar float" role="group" aria-label="Confirm selected region"
      onSubmit={(event) => {
        event.preventDefault();
        const normalized = normalizeSelectionName(name);
        if ('error' in normalized) { setError(normalized.error); return; }
        if (normalized.name) onConfirm(normalized.name);
        else onConfirm();
      }}>
      <span className="num">
        {formatRa(region.ra_deg)} {formatDec(region.dec_deg)} · {region.size_arcmin.toFixed(1)}′
      </span>
      <span className="region-confirm-hint">Pan inside · top grip moves · corners resize</span>
      {/* Name field and confirm button share one row, aligned on the input. */}
      <div className="region-name-row">
        <label className="region-name-field">
          <span>Selection name (optional)</span>
          <input type="text" value={name} maxLength={MAX_SELECTION_NAME_LENGTH}
            placeholder="e.g. M101 core" aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'region-name-error' : undefined}
            onChange={(event) => { setName(event.target.value); setError(null); }} />
        </label>
        <button type="submit" className="region-confirm-btn">
          Confirm region
        </button>
      </div>
      {error && <span id="region-name-error" className="region-name-error" role="alert">{error}</span>}
      <button type="button" className="region-discard-btn" aria-label="Discard region" title="Discard region" onClick={onDiscard}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3 9 9M9 3 3 9" />
        </svg>
      </button>
    </form>
  );
}
