import type { CubeSpectrumPoint } from '../types/types';

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

/** A chart-only point; inferred flux is never written back to the API response. */
export interface DerivedSpectrumPoint extends CubeSpectrumPoint {
  interpolated: boolean;
}

/** Longest gap filled by default: a fifth of the channels, never fewer than two. */
export function defaultEstimateGap(channels: number): number {
  return Math.max(2, Math.floor(channels / 5));
}

/**
 * Fill interior runs of null flux bounded by finite observations, including
 * the blank channels between detectors. Runs longer than `maxGap` (by default
 * a fifth of the channels, 20 of 102) and edge gaps remain missing; the API's available flag only mirrors
 * whether value is finite and cannot independently exclude a null. Output is
 * a fresh chart representation and never mutates the source measurements.
 */
export function interpolateMissingFlux(
  points: CubeSpectrumPoint[],
  maxGap = defaultEstimateGap(points.length),
): DerivedSpectrumPoint[] {
  const result = points.map((point) => ({ ...point, interpolated: false }));
  const ordered = points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => a.point.wavelength_um - b.point.wavelength_um);
  const limit = Number.isFinite(maxGap) ? Math.max(0, Math.floor(maxGap)) : 0;

  for (let i = 0; i < ordered.length;) {
    if (ordered[i].point.value !== null) {
      i += 1;
      continue;
    }
    const start = i;
    while (
      i < ordered.length &&
      ordered[i].point.value === null
    ) i += 1;
    const count = i - start;
    const left = ordered[start - 1]?.point;
    const right = ordered[i]?.point;
    if (
      count > limit || !left || !right || left.value === null || right.value === null || !Number.isFinite(left.value) ||
      !Number.isFinite(right.value) || !Number.isFinite(left.wavelength_um) ||
      !Number.isFinite(right.wavelength_um) || right.wavelength_um <= left.wavelength_um
    ) continue;

    for (let j = start; j < i; j += 1) {
      const { point, index } = ordered[j];
      const fraction = (point.wavelength_um - left.wavelength_um) /
        (right.wavelength_um - left.wavelength_um);
      result[index] = {
        ...point,
        value: left.value + fraction * (right.value - left.value),
        interpolated: true,
      };
    }
  }
  return result;
}

/** Dashed chart-only links wherever a line segment touches an inferred point. */
/**
 * Measured channels whose neighbours (by wavelength) are both missing or only
 * estimated. A line needs two measured points, so these would otherwise not be
 * drawn at all; the chart marks them with a dot.
 */
export function isolatedMeasurements<T extends CubeSpectrumPoint & { interpolated?: boolean }>(points: T[]): T[] {
  const ordered = [...points].sort((a, b) => a.wavelength_um - b.wavelength_um);
  const measured = (p: T | undefined) =>
    p !== undefined && p.value !== null && Number.isFinite(p.value) && !p.interpolated;
  return ordered.filter((p, i) => measured(p) && !measured(ordered[i - 1]) && !measured(ordered[i + 1]));
}

/** A run of consecutive estimated channels, in wavelength order. */
export interface EstimatedRun {
  points: DerivedSpectrumPoint[];
}

export function estimatedRuns(points: DerivedSpectrumPoint[]): EstimatedRun[] {
  const ordered = [...points].sort((a, b) => a.wavelength_um - b.wavelength_um);
  const runs: EstimatedRun[] = [];
  let current: DerivedSpectrumPoint[] = [];
  const close = () => {
    if (!current.length) return;
    runs.push({ points: current });
    current = [];
  };
  for (const p of ordered) {
    if (p.interpolated && p.value !== null) current.push(p);
    else close();
  }
  close();
  return runs;
}

/**
 * Dashed segments for estimates that span two or more channels. A single
 * estimated channel is drawn as a circle instead, so it gets no segments.
 */
export function interpolatedLineSegments(
  points: DerivedSpectrumPoint[],
  x: Scale,
  y: Scale,
): string[] {
  const ordered = [...points].sort((a, b) => a.wavelength_um - b.wavelength_um);
  const lone = new Set(estimatedRuns(points).filter((r) => r.points.length === 1).map((r) => r.points[0]));
  const segments: string[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const a = ordered[i - 1];
    const b = ordered[i];
    if ((!a.interpolated && !b.interpolated) || a.value === null || b.value === null) continue;
    if (lone.has(a) || lone.has(b)) continue;
    const ay = y(a.value);
    const by = y(b.value);
    if (!Number.isFinite(ay) || !Number.isFinite(by)) continue;
    segments.push(`M${x(a.wavelength_um).toFixed(2)},${ay.toFixed(2)} L${x(b.wavelength_um).toFixed(2)},${by.toFixed(2)}`);
  }
  return segments;
}

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

function domainTransform(value: number, logarithmic: boolean): number {
  return logarithmic ? Math.log10(value) : value;
}

function domainInverse(value: number, logarithmic: boolean): number {
  return logarithmic ? 10 ** value : value;
}

/** Zoom around a normalized pointer location (0 is lower/left, 1 is upper/right). */
export function zoomDomainAt(
  domain: [number, number],
  factor: number,
  anchor: number,
  logarithmic = false,
): [number, number] {
  const [start, end] = domain.map((value) => domainTransform(value, logarithmic)) as [number, number];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !(factor > 0)) return domain;
  const fraction = Math.min(1, Math.max(0, anchor));
  const nextSpan = (end - start) / factor;
  const anchorValue = start + (end - start) * fraction;
  return [
    domainInverse(anchorValue - nextSpan * fraction, logarithmic),
    domainInverse(anchorValue + nextSpan * (1 - fraction), logarithmic),
  ];
}

/** Shift a domain by a fraction of its current span, clamped to its data extent. */
export function panDomain(
  domain: [number, number],
  fraction: number,
  bounds: [number, number],
  logarithmic = false,
): [number, number] {
  const start = domainTransform(domain[0], logarithmic);
  const end = domainTransform(domain[1], logarithmic);
  const boundStart = domainTransform(bounds[0], logarithmic);
  const boundEnd = domainTransform(bounds[1], logarithmic);
  const span = end - start;
  if (![start, end, boundStart, boundEnd, fraction].every(Number.isFinite) || span <= 0) return domain;
  if (span >= boundEnd - boundStart) return bounds;
  const shift = span * fraction;
  const nextStart = Math.min(boundEnd - span, Math.max(boundStart, start + shift));
  return [domainInverse(nextStart, logarithmic), domainInverse(nextStart + span, logarithmic)];
}

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
