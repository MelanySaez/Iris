import { useCallback, useState } from 'react';

const STORAGE_KEY = 'iris.plate.panels';

interface PanelState {
  sheetOpen: boolean;
  railOpen: boolean;
}

function readPanels(): PanelState {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<PanelState> | null;
    return { sheetOpen: saved?.sheetOpen !== false, railOpen: saved?.railOpen !== false };
  } catch {
    return { sheetOpen: true, railOpen: true };
  }
}

function writePanels(state: PanelState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage is a per-viewer convenience; the panels work without it.
  }
}

/** Open/closed state of the plate's two sidebars, remembered per browser. */
export function useCollapsiblePanels() {
  const [panels, setPanels] = useState<PanelState>(readPanels);
  const update = useCallback((change: (state: PanelState) => PanelState) => {
    setPanels(current => {
      const next = change(current);
      writePanels(next);
      return next;
    });
  }, []);
  return {
    ...panels,
    toggleSheet: () => update(state => ({ ...state, sheetOpen: !state.sheetOpen })),
    toggleRail: () => update(state => ({ ...state, railOpen: !state.railOpen })),
  };
}

interface PanelToggleProps {
  side: 'left' | 'right';
  label: string;
  /** id of the panel this strip collapses. */
  controls: string;
  open: boolean;
  onToggle: () => void;
}

/**
 * Full-height strip between a sidebar and the stage that collapses or expands
 * the sidebar. Same shape as the Spectral Lab sidebar toggle.
 */
export function PanelToggle({ side, label, controls, open, onToggle }: PanelToggleProps) {
  // The chevron points the way the panel will move.
  const pointsLeft = side === 'left' ? open : !open;
  return <button type="button" className={`panel-toggle panel-toggle-${side}`}
    aria-label={`${open ? 'Hide' : 'Show'} ${label}`} aria-expanded={open}
    aria-controls={controls} onClick={onToggle}>
    <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
      <path d={pointsLeft ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'} />
    </svg>
    <span>{open ? 'Hide' : 'Show'}</span>
  </button>;
}
