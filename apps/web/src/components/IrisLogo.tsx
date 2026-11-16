/**
 * One arm of the spiral: a crescent between a tail tip on the rim (4.2, 17)
 * and a head tip beside the core (15, 14.2), bounded by two circular arcs.
 * The second arm is the same shape turned 180°. Keep in sync with
 * public/favicon.svg.
 */
export const IRIS_LOGO_ARM = 'M4.2 17 A8 8 0 1 1 15 14.2 A6.6 6.6 0 1 0 4.2 17Z';

/**
 * Iris mark: two crescent arms swirling around a core, like a spiral galaxy.
 * Colour comes from `currentColor`.
 */
export function IrisLogo() {
  return (
    <svg className="iris-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={IRIS_LOGO_ARM} />
      <path d={IRIS_LOGO_ARM} transform="rotate(180 12 12)" />
      <circle cx="12" cy="12" r="2.3" />
    </svg>
  );
}
