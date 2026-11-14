import type { RegionRequest } from '../../types';

export interface SpectrumTarget {
  ra_deg: number;
  dec_deg: number;
  label: string;
}

interface SelectionActionsProps {
  selection: RegionRequest | null;
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
  activeJobId,
  onOpenPlate,
  onViewSpectrum,
}: SelectionActionsProps) {
  if (!selection && !activeJobId) return null;
  return (
    <div className="sky-selection-actions float">
      {selection && (
        <button
          type="button"
          className="selection-action-btn"
          title={`Plot the spectrum at the centre of the selection (RA ${selection.ra_deg}°, Dec ${selection.dec_deg}°)`}
          onClick={() =>
            onViewSpectrum({
              ra_deg: selection.ra_deg,
              dec_deg: selection.dec_deg,
              label: `Selection centre (${selection.ra_deg.toFixed(3)}°, ${selection.dec_deg.toFixed(3)}°)`,
            })
          }
        >
          View spectrum →
        </button>
      )}
      {activeJobId && (
        <button type="button" className="selection-action-btn" onClick={() => onOpenPlate(activeJobId)}>
          Open spectral plate →
        </button>
      )}
    </div>
  );
}
