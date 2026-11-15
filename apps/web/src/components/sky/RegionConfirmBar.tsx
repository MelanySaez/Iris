import { formatDec, formatRa } from '../../format';
import type { RegionRequest } from '../../types';

interface RegionConfirmBarProps {
  region: RegionRequest;
  onConfirm: () => void;
  /** Throws the draft region away. */
  onDiscard: () => void;
}

/** Draft region card above the channel dock: confirm it, or discard it with the close button. */
export function RegionConfirmBar({ region, onConfirm, onDiscard }: RegionConfirmBarProps) {
  return (
    <div className="region-confirm-bar float" role="group" aria-label="Confirm selected region">
      <span className="num">
        {formatRa(region.ra_deg)} {formatDec(region.dec_deg)} · {region.size_arcmin.toFixed(1)}′
      </span>
      <span className="region-confirm-hint">Pan inside · top grip moves · corners resize</span>
      <button type="button" className="region-confirm-btn" onClick={onConfirm}>
        Confirm region
      </button>
      <button type="button" className="region-discard-btn" aria-label="Discard region" title="Discard region" onClick={onDiscard}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3 9 9M9 3 3 9" />
        </svg>
      </button>
    </div>
  );
}
