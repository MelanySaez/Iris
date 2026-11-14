import type { CubeSpectrumPoint } from './types';

/**
 * Categorical series colours (dark mode), validated against the sky surface
 * #0d1119 with the dataviz palette validator. Assigned in fixed order and kept
 * by each spectrum for its lifetime: colour follows the entity, never its rank.
 */
export const SERIES_COLORS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#0ca30c',
  '#9085e9',
  '#e66767',
] as const;

export const MAX_SPECTRA = SERIES_COLORS.length;

/** Lowest colour slot not held by a current spectrum, or null when all 8 are taken. */
export function nextColorSlot(usedSlots: number[]): number | null {
  for (let slot = 0; slot < SERIES_COLORS.length; slot += 1) {
    if (!usedSlots.includes(slot)) return slot;
  }
  return null;
}

/** Stable identity for a position, so the same object is never fetched twice. */
export function spectrumKey(raDeg: number, decDeg: number): string {
  const ra = ((raDeg % 360) + 360) % 360;
  return `${ra.toFixed(4)},${decDeg.toFixed(4)}`;
}

/** Round, human-friendly axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) return [min];
  const rawStep = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

export interface Domain {
  x: [number, number];
  y: [number, number];
}

/**
 * X covers every channel's band; Y starts at 0 (or below, for negative
 * surface brightness) and leaves 8% headroom above the highest value.
 */
export function computeDomain(series: CubeSpectrumPoint[][]): Domain | null {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = 0;
  let yMax = -Infinity;
  for (const points of series) {
    for (const p of points) {
      xMin = Math.min(xMin, p.wl_min_um);
      xMax = Math.max(xMax, p.wl_max_um);
      if (p.value !== null) {
        yMin = Math.min(yMin, p.value);
        yMax = Math.max(yMax, p.value);
      }
    }
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(yMax)) return null;
  const headroom = (yMax - yMin || Math.abs(yMax) || 1) * 0.08;
  return { x: [xMin, xMax], y: [yMin, yMax + headroom] };
}

export type Scale = (value: number) => number;

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/**
 * SVG path data per contiguous run of channels with data. A channel without
 * coverage breaks the line instead of being interpolated across.
 */
export function lineSegments(points: CubeSpectrumPoint[], x: Scale, y: Scale): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  const ordered = [...points].sort((a, b) => a.wavelength_um - b.wavelength_um);
  for (const p of ordered) {
    if (p.value === null) {
      if (current.length) segments.push(current.join(' '));
      current = [];
      continue;
    }
    const cmd = current.length ? 'L' : 'M';
    current.push(`${cmd}${x(p.wavelength_um).toFixed(2)},${y(p.value).toFixed(2)}`);
  }
  if (current.length) segments.push(current.join(' '));
  return segments;
}

/** Index of the channel whose centre wavelength is closest to `wavelength`. */
export function nearestChannel(points: CubeSpectrumPoint[], wavelength: number): number {
  let best = -1;
  let bestDistance = Infinity;
  points.forEach((p, index) => {
    const distance = Math.abs(p.wavelength_um - wavelength);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** Parse a user-typed coordinate pair; returns an error message when invalid. */
export function parseCoordinates(
  raText: string,
  decText: string,
): { ra: number; dec: number } | { error: string } {
  const ra = Number(raText.trim());
  const dec = Number(decText.trim());
  if (raText.trim() === '' || !Number.isFinite(ra) || ra < 0 || ra >= 360) {
    return { error: 'RA must be a number in degrees, 0 ≤ RA < 360.' };
  }
  if (decText.trim() === '' || !Number.isFinite(dec) || dec < -90 || dec > 90) {
    return { error: 'Dec must be a number in degrees, −90 ≤ Dec ≤ 90.' };
  }
  return { ra, dec };
}
