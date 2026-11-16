import { useMemo } from 'react';
import { ACTIONS, Joyride, STATUS, type EventData } from 'react-joyride';
import { TOURS, type TourId } from './tourSteps';

/** Prefix of the per-workspace flags (`iris_tour_seen:sky`, …); alone it is the old single flag. */
export const TOUR_SEEN_KEY = 'iris_tour_seen';

const seenKey = (tour: TourId) => `${TOUR_SEEN_KEY}:${tour}`;

/** True once the visitor finished, skipped or closed this workspace's tour on this browser. */
export function hasSeenTour(tour: TourId): boolean {
  try {
    if (localStorage.getItem(seenKey(tour)) === '1') return true;
    // Before tours were remembered per workspace, one flag covered the landing's Sky tour.
    return tour === 'sky' && localStorage.getItem(TOUR_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberTour(tour: TourId) {
  try {
    localStorage.setItem(seenKey(tour), '1');
  } catch {
    // Private mode or blocked storage: the tour still works, it is just not remembered.
  }
}

/** A step is offered only when its anchor is on screen (e.g. the rail is a closed drawer on phones). */
function isOnScreen(selector: string): boolean {
  if (selector === 'body') return true;
  const element = document.querySelector<HTMLElement>(selector);
  return Boolean(element && element.getClientRects().length > 0);
}

/**
 * True once the workspace has drawn at least one element its tour points at, so a
 * first-visit tour does not start over a page that is still loading (e.g. the plate).
 */
export function tourAnchorsReady(tour: TourId): boolean {
  return TOURS[tour].some((step) => String(step.target) !== 'body' && isOnScreen(String(step.target)));
}

interface GuidedTourProps {
  /** Which workspace's tour to run. */
  tour: TourId;
  run: boolean;
  /** Called when the tour is finished or skipped. */
  onEnd: () => void;
}

/** React Joyride tour over the viewer, styled with the Iris palette. */
export function GuidedTour({ tour, run, onEnd }: GuidedTourProps) {
  // Re-evaluated each time the tour starts, so it adapts to the current layout.
  const steps = useMemo(
    () => (run ? TOURS[tour].filter((step) => isOnScreen(String(step.target))) : TOURS[tour]),
    [run, tour],
  );

  const handleEvent = (data: EventData) => {
    // Joyride's "close" (Escape, close button) only advances a step and keeps the
    // tour running; treating it as the end keeps the app's state in sync.
    const ended =
      data.status === STATUS.FINISHED || data.status === STATUS.SKIPPED || data.action === ACTIONS.CLOSE;
    if (ended) {
      rememberTour(tour);
      onEnd();
    }
  };

  return (
    <Joyride
      steps={steps}
      run={run}
      continuous
      onEvent={handleEvent}
      locale={{ back: 'Back', close: 'Close', last: 'Done', next: 'Next', skip: 'Skip tour', nextWithProgress: 'Next ({current}/{total})' }}
      options={{
        showProgress: true,
        skipBeacon: true,
        buttons: ['back', 'skip', 'primary'],
        overlayClickAction: false,
        primaryColor: '#f5b041',
        backgroundColor: '#18181b',
        textColor: '#f4f4f5',
        arrowColor: '#18181b',
        overlayColor: 'rgba(0, 0, 0, 0.6)',
        spotlightRadius: 6,
        zIndex: 400,
        width: 360,
      }}
    />
  );
}
