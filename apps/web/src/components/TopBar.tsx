import { useLayoutEffect, useRef, useState } from 'react';
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

  // One underline shared by every tab, moved to the active one so it slides.
  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0, visible: false, ready: false });
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const place = () => {
      const active = nav.querySelector<HTMLElement>('.switch-btn.active');
      setIndicator((prev) => ({
        left: active ? active.offsetLeft : prev.left,
        width: active ? active.offsetWidth : prev.width,
        visible: Boolean(active),
        // Animate only after the first placement, so it never slides in from the edge.
        ready: prev.visible || prev.ready,
      }));
    };
    place();
    window.addEventListener('resize', place);
    void document.fonts?.ready.then(place);
    return () => window.removeEventListener('resize', place);
  }, [currentRoute.type, activeJobId]);

  return (
    <header className="app-topbar">
      <div className="topbar-left">
        <button type="button" className="brand" aria-label="Iris home" onClick={() => onNavigate('#/')}>
          <span className="brand-logo"><PlanetIcon /></span>
          <strong className="brand-name">Iris</strong>
          <span className="brand-sub">SPHEREx Explorer</span>
        </button>
        <span className="provenance-chip" title="Official SPHEREx DR1 Data Collection">
          SPHEREx · DR1
        </span>
      </div>

      <nav className="workspace-switch" aria-label="Workspace switch" ref={navRef}>
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
        <span
          className={`switch-indicator${indicator.ready ? ' ready' : ''}`}
          data-visible={indicator.visible}
          aria-hidden="true"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      </nav>

      <div className="topbar-right">
        <DataNotesPopover />
      </div>
    </header>
  );
}
