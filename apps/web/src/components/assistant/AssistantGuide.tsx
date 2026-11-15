import { useEffect, useRef, useState } from 'react';
import type { GuideCue } from '../../assistant';

/** Pause before measuring, so a workspace switch or map move can settle. */
export const GUIDE_DELAY_MS = 350;
/** How long each cue stays on screen (matches the CSS animations). */
export const GUIDE_DURATION_MS = 1800;

export interface GuideCueItem extends GuideCue {
  id: number;
}

interface Shown {
  cue: GuideCueItem;
  left: number;
  top: number;
  width: number;
  height: number;
}

function measure(cue: GuideCueItem): Shown | null {
  const rect = document.querySelector(cue.target)?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return { cue, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * Visual guide for the assistant's actions: a pulsing ring around the control
 * an action changes, or a reticle closing on the map position it moves to.
 * Cues play one after another; a cue whose target is not on screen is skipped.
 */
export function AssistantGuide({ cues }: { cues: GuideCueItem[] }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const next = useRef(0);

  useEffect(() => {
    if (shown || next.current >= cues.length) return undefined;
    const timer = setTimeout(() => {
      while (next.current < cues.length) {
        const found = measure(cues[next.current]);
        next.current += 1;
        if (found) {
          setShown(found);
          return;
        }
      }
    }, GUIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [cues, shown]);

  useEffect(() => {
    if (!shown) return undefined;
    const timer = setTimeout(() => setShown(null), GUIDE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  if (!shown) return null;
  const { cue, left, top, width, height } = shown;

  if (cue.kind === 'position') {
    const x = left + width / 2;
    const y = top + height / 2;
    return (
      <div className="assistant-guide" key={cue.id}>
        <div className="assistant-guide-reticle" style={{ left: `${x}px`, top: `${y}px` }} aria-hidden="true">
          <svg viewBox="0 0 64 64">
            <path d="M4 18V4h14M46 4h14v14M60 46v14H46M18 60H4V46" />
            <circle cx="32" cy="32" r="3" />
          </svg>
        </div>
        <div className="assistant-guide-label below" style={{ left: `${x}px`, top: `${y + 44}px` }} role="status">
          {cue.label}
        </div>
      </div>
    );
  }

  // Label above the field, or below when the field sits at the top of the screen.
  const above = top > 48;
  return (
    <div className="assistant-guide" key={cue.id}>
      <div
        className="assistant-guide-ring"
        style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}
        aria-hidden="true"
      />
      <div
        className={`assistant-guide-label ${above ? 'above' : 'below'}`}
        style={{ left: `${left + width / 2}px`, top: `${above ? top - 10 : top + height + 10}px` }}
        role="status"
      >
        {cue.label}
      </div>
    </div>
  );
}
