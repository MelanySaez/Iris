import { useLayoutEffect, useRef, useState } from 'react';
import { DataNotesPopover } from './DataNotesPopover';
import { IrisLogo } from './IrisLogo';
import type { AppRoute } from '../core/router';

interface TopBarProps {
  currentRoute: AppRoute;
  activeJobId: string | null;
  onNavigate: (route: AppRoute | string) => void;
  /** Replays the guided tour. */
  onStartTour?: () => void;
}

export function TopBar({ currentRoute, activeJobId, onNavigate, onStartTour }: TopBarProps) {
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
          <span className="brand-logo"><IrisLogo /></span>
          <strong className="brand-name">Iris</strong>
          <span className="brand-sub">SPHEREx Explorer</span>
        </button>
        <span className="provenance-chip" title="Official SPHEREx DR1 Data Collection">
          SPHEREx · DR1
        </span>
      </div>

      <nav className="workspace-switch" aria-label="Workspace switch" ref={navRef} data-tour="workspaces">
        <button
          type="button"
          className={`switch-btn ${isSky ? 'active' : ''}`}
          aria-pressed={isSky}
          data-assistant-target="workspace-sky"
          onClick={() => onNavigate('#/sky')}
        >
          Sky
        </button>
        <button
          type="button"
          className={`switch-btn ${isPlate ? 'active' : ''}`}
          aria-pressed={isPlate}
          data-assistant-target="workspace-plate"
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
          data-assistant-target="workspace-spectral"
          title="Compare quick-look spectra from the All-Sky Cube"
          onClick={() => onNavigate('#/spectral')}
        >
          <span className="switch-label-long">Spectral </span>Lab
        </button>
        <button
          type="button"
          className={`switch-btn ${isRecords ? 'active' : ''}`}
          aria-pressed={isRecords}
          data-assistant-target="workspace-records"
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
        {onStartTour && (
          <button
            type="button"
            className="tour-help-btn"
            aria-label="Take the guided tour"
            title="Take the guided tour"
            data-tour="tour-help"
            onClick={onStartTour}
          >
            ?
          </button>
        )}
        <DataNotesPopover />
      </div>
    </header>
  );
}
