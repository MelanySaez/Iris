import { spectrumLabel, type SpectrumOrigin } from '../../spectrumLabel';
import type { RegionRequest } from '../../types';

export interface SpectrumTarget {
  ra_deg: number;
  dec_deg: number;
  label: string;
}

interface SelectionActionsProps {
  selection: RegionRequest | null;
  /** Object the region was created from, if any; names the spectrum while the centre is on it. */
  origin?: SpectrumOrigin | null;
  /** The region has been confirmed (its spectral job is being prepared). */
  confirmed: boolean;
  activeJobId: string | null;
  onOpenPlate: (jobId: string) => void;
  onViewSpectrum: (target: SpectrumTarget) => void;
}

/**
 * Floating actions for the Sky selection: open the spectral plate of the
 * active job, and plot the spectrum at the centre of the selected region.
 * The Spectral Lab samples one point, so the centre is what it receives.
 */
export function SelectionActions({
  selection,
  origin = null,
  confirmed,
  activeJobId,
  onOpenPlate,
  onViewSpectrum,
}: SelectionActionsProps) {
  // Both actions belong to a confirmed region: nothing while it is a draft or absent.
  if (!selection || !confirmed) return null;
  return (
    <div className="sky-selection-actions">
      <button
        type="button"
        className="selection-action-btn"
        title={`Plot the spectrum at the centre of the selection (RA ${selection.ra_deg}°, Dec ${selection.dec_deg}°)`}
        onClick={() =>
          onViewSpectrum({
            ra_deg: selection.ra_deg,
            dec_deg: selection.dec_deg,
            label: spectrumLabel(selection, origin),
          })
        }
      >
        <svg className="selection-action-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M2 15 6 9l3 3 4-7 5 8" />
        </svg>
        <span className="selection-action-label">Visualize spectrum</span>
        <svg className="selection-action-arrow" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      </button>
      {activeJobId && (
        <button type="button" className="selection-action-btn" onClick={() => onOpenPlate(activeJobId)}>
          <svg className="selection-action-icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 3h14v14H3zM3 8h14M3 13h14M8 3v14M13 3v14" />
          </svg>
          <span className="selection-action-label">Open spectral plate</span>
          <svg className="selection-action-arrow" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
        </button>
      )}
    </div>
  );
}
