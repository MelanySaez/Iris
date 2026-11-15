import { useId } from 'react';

/**
 * Iris mark: a solid planet with a tilted ring. The back of the ring hides
 * behind the planet and the front crosses it with a small cut, so the ring
 * reads in depth at any size. Colour comes from `currentColor`.
 */
export function IrisLogo() {
  const id = useId().replace(/:/g, '');
  const back = `${id}-back`;
  const front = `${id}-front`;
  // Ring: ellipse centred on the planet, tilted 22° up to the right.
  const ringBack = 'M1.4 12 A10.6 2.9 0 0 1 22.6 12';
  const ringFront = 'M1.4 12 A10.6 2.9 0 0 0 22.6 12';
  return (
    <svg className="iris-logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <defs>
        {/* Hide the back half of the ring where the planet covers it, with a small gap. */}
        <mask id={back} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="#fff" />
          <circle cx="12" cy="12" r="6.5" fill="#000" />
        </mask>
        {/* Cut the planet where the front half of the ring passes over it. */}
        <mask id={front} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="#fff" />
          <g transform="rotate(-22 12 12)">
            <path d={ringFront} fill="none" stroke="#000" strokeWidth="3" />
          </g>
        </mask>
      </defs>
      <circle cx="12" cy="12" r="5.6" fill="currentColor" mask={`url(#${front})`} />
      <g transform="rotate(-22 12 12)" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d={ringBack} mask={`url(#${back})`} />
        <path d={ringFront} />
      </g>
    </svg>
  );
}
