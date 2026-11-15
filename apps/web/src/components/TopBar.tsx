import { DataNotesPopover } from './DataNotesPopover';
import { PlanetIcon } from './SkyIcons';
import type { AppRoute } from '../router';

interface TopBarProps {
  currentRoute: AppRoute;
  activeJobId: string | null;
  onNavigate: (route: AppRoute | string) => void;
}

export function TopBar({ currentRoute, activeJobId, onNavigate }: TopBarProps) {
  const isSky = currentRoute.type === 'sky';
  const isPlate = currentRoute.type === 'plate';
  const isSpectral = currentRoute.type === 'spectral';
  const isRecords = currentRoute.type === 'records';

  return (
    <header className="app-topbar">
      <div className="topbar-left">
        <div className="brand" onClick={() => onNavigate('#/sky')} role="button" tabIndex={0}>
          <span className="brand-logo"><PlanetIcon /></span>
          <strong className="brand-name">Iris</strong>
          <span className="brand-sub">SPHEREx Explorer</span>
        </div>
        <span className="provenance-chip" title="Official SPHEREx DR1 Data Collection">
          SPHEREx · DR1
        </span>
      </div>

      <nav className="workspace-switch" aria-label="Workspace switch">
        <button
          type="button"
          className={`switch-btn ${isSky ? 'active' : ''}`}
          aria-pressed={isSky}
          onClick={() => onNavigate('#/sky')}
        >
          Sky
        </button>
        <button
          type="button"
          className={`switch-btn ${isPlate ? 'active' : ''}`}
          aria-pressed={isPlate}
          disabled={!activeJobId}
          title={activeJobId ? `Switch to Spectral Plate ${activeJobId}` : 'Select a region in Sky to open Plate'}
          onClick={() => {
            if (activeJobId) {
              onNavigate({ type: 'plate', jobId: activeJobId });
            }
          }}
        >
          Plate
        </button>
        <button
          type="button"
          className={`switch-btn ${isSpectral ? 'active' : ''}`}
          aria-pressed={isSpectral}
          title="Compare quick-look spectra from the All-Sky Cube"
          onClick={() => onNavigate('#/spectral')}
        >
          <span className="switch-label-long">Spectral </span>Lab
        </button>
        <button
          type="button"
          className={`switch-btn ${isRecords ? 'active' : ''}`}
          aria-pressed={isRecords}
          onClick={() => onNavigate('#/records')}
        >
          Records
        </button>
      </nav>

      <div className="topbar-right">
        <DataNotesPopover />
      </div>
    </header>
  );
}
