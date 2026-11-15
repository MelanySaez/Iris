import { useLayoutEffect, useRef } from 'react';
import type { ConsentLevel } from '../../consent';

/** CSS variable other fixed bottom elements (the chat button) offset themselves by. */
const HEIGHT_VARIABLE = '--consent-bar-height';

interface ConsentBarProps {
  onChoose: (level: ConsentLevel) => void;
  saving: boolean;
  error: string | null;
}

/** Footer bar asking for cookie consent; Records are saved only after accepting. */
export function ConsentBar({ onChoose, saving, error }: ConsentBarProps) {
  const barRef = useRef<HTMLElement>(null);

  // Publish the bar height so the chat button moves above it; clearing it on
  // close lets the button slide back to its place (see .assistant-launcher).
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(HEIGHT_VARIABLE, `${bar.offsetHeight}px`);
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(HEIGHT_VARIABLE);
    };
  }, []);

  return (
    <section ref={barRef} className="consent-bar" role="region" aria-label="Cookie consent">
      <p className="consent-bar-text">
        Iris has no accounts, so it uses a cookie to keep your saved selections in this browser. The
        necessary cookies are enough to save them; without cookies your selections (Records) cannot be
        saved.
      </p>
      {error && (
        <p className="consent-bar-error" role="alert">
          Could not save your choice: {error}
        </p>
      )}
      <div className="consent-bar-actions">
        <button type="button" className="records-btn" disabled={saving} onClick={() => onChoose('none')}>
          Reject all
        </button>
        <button type="button" className="records-btn" disabled={saving} onClick={() => onChoose('necessary')}>
          Accept necessary
        </button>
        <button
          type="button"
          className="records-btn consent-bar-primary"
          disabled={saving}
          onClick={() => onChoose('all')}
        >
          Accept all
        </button>
      </div>
    </section>
  );
}
