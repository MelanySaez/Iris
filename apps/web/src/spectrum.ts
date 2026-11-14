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
  // Round first, then wrap RA, so 359.99999 and 360 both become 0; adding 0
  // turns a rounded -0 into +0 so "-0.0000" never appears in a key.
  const ra = ((Math.round(raDeg * 1e4) / 1e4) % 360 + 360) % 360 + 0;
  const dec = Math.round(decDeg * 1e4) / 1e4 + 0;
  return `${ra.toFixed(4)},${dec.toFixed(4)}`;
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

export type YScaleMode = 'linear' | 'log';

/**
 * X covers every channel's band. Linear Y starts at 0 (or below, for negative
 * surface brightness) with 8% headroom; log Y spans whole decades around the
 * positive values only, since zero and negative values have no logarithm.
 */
export function computeDomain(
  series: CubeSpectrumPoint[][],
  mode: YScaleMode = 'linear',
): Domain | null {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = mode === 'log' ? Infinity : 0;
  let yMax = -Infinity;
  for (const points of series) {
    for (const p of points) {
      xMin = Math.min(xMin, p.wl_min_um);
      xMax = Math.max(xMax, p.wl_max_um);
      if (p.value === null || (mode === 'log' && p.value <= 0)) continue;
      yMin = Math.min(yMin, p.value);
      yMax = Math.max(yMax, p.value);
    }
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(yMax)) return null;
  if (mode === 'log') {
    const low = 10 ** Math.floor(Math.log10(yMin));
    const high = 10 ** Math.ceil(Math.log10(yMax));
    return { x: [xMin, xMax], y: [low, high > low ? high : low * 10] };
  }
  const headroom = (yMax - yMin || Math.abs(yMax) || 1) * 0.08;
  return { x: [xMin, xMax], y: [yMin, yMax + headroom] };
}

/** Log10 scale; values ≤ 0 map to NaN so the chart leaves a gap there. */
export function logScale(domain: [number, number], range: [number, number]): Scale {
  const l0 = Math.log10(domain[0]);
  const l1 = Math.log10(domain[1]);
  const span = l1 - l0 || 1;
  const [r0, r1] = range;
  return (value) => (value > 0 ? r0 + ((Math.log10(value) - l0) / span) * (r1 - r0) : NaN);
}

/** Ticks at powers of ten; adds ×2 and ×5 when the axis covers ≤ 2 decades. */
export function logTicks(min: number, max: number): number[] {
  if (!(min > 0) || !(max > min)) return [];
  const first = Math.floor(Math.log10(min));
  const last = Math.ceil(Math.log10(max));
  const multipliers = last - first <= 2 ? [1, 2, 5] : [1];
  const ticks: number[] = [];
  for (let e = first; e <= last; e += 1) {
    for (const m of multipliers) {
      const v = Number((m * 10 ** e).toPrecision(12));
      if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) ticks.push(v);
    }
  }
  return ticks;
}

/** Points with a value that a log axis cannot draw (zero or negative). */
export function countNonPositive(series: CubeSpectrumPoint[][]): number {
  return series.reduce(
    (total, points) => total + points.filter((p) => p.value !== null && p.value <= 0).length,
    0,
  );
}

export type Scale = (value: number) => number;

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/**
 * SVG path data per contiguous run of drawable channels. A channel without
 * coverage, or one the y scale cannot place (≤ 0 on a log axis), breaks the
 * line instead of being interpolated across.
 */
export function lineSegments(points: CubeSpectrumPoint[], x: Scale, y: Scale): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  const ordered = [...points].sort((a, b) => a.wavelength_um - b.wavelength_um);
  for (const p of ordered) {
    const py = p.value === null ? NaN : y(p.value);
    if (!Number.isFinite(py)) {
      if (current.length) segments.push(current.join(' '));
      current = [];
      continue;
    }
    const cmd = current.length ? 'L' : 'M';
    current.push(`${cmd}${x(p.wavelength_um).toFixed(2)},${py.toFixed(2)}`);
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

/**
 * Apply a fetch result only when it belongs to the entry's current request.
 * A spectrum removed and re-added while loading gets a new requestId, so the
 * superseded request can never overwrite the newer one. Returns the same
 * array when nothing changes.
 */
export function applyIfCurrent<T extends { key: string; requestId: number }>(
  entries: T[],
  key: string,
  requestId: number,
  patch: Partial<T>,
): T[] {
  const index = entries.findIndex((e) => e.key === key && e.requestId === requestId);
  if (index === -1) return entries;
  const next = [...entries];
  next[index] = { ...entries[index], ...patch };
  return next;
}

/**
 * Decide whether a spectrum can join the comparison: rejects duplicates and a
 * ninth series, otherwise returns the colour slot it will keep.
 */
export function planAdd(
  entries: { key: string; slot: number }[],
  key: string,
  label: string,
): { slot: number } | { error: string } {
  if (entries.some((e) => e.key === key)) {
    return { error: `${label} is already in the comparison.` };
  }
  const slot = nextColorSlot(entries.map((e) => e.slot));
  if (slot === null) {
    return { error: `Compare at most ${MAX_SPECTRA} spectra; remove one first.` };
  }
  return { slot };
}
