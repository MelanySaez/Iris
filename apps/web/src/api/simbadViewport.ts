export interface SimbadCone {
  raDeg: number;
  decDeg: number;
  /** Up to 180° (the whole sky); the query falls back to the whole sky above a hemisphere. */
  radiusDeg: number;
}

/**
 * Cone that covers the visible field (half its diagonal, at most the whole sky),
 * or null when the position is not on the sky. Any field is queried: SIMBAD
 * returns the 300 most-cited objects, so wide views show the best-known ones.
 */
export function simbadViewportCone(
  center: [number, number],
  fovWidthDeg: number,
  fovHeightDeg: number,
): SimbadCone | null {
  const [ra, dec] = center;
  if (![ra, dec, fovWidthDeg, fovHeightDeg].every(Number.isFinite) || dec < -90 || dec > 90) return null;
  const radiusDeg = Math.min(180, Math.hypot(fovWidthDeg, fovHeightDeg) / 2);
  if (radiusDeg <= 0) return null;
  // Only shift negative RAs: ((ra % 360) + 360) % 360 adds float noise to in-range values.
  const wrapped = ra % 360;
  return { raDeg: wrapped < 0 ? wrapped + 360 : wrapped, decDeg: dec, radiusDeg };
}
