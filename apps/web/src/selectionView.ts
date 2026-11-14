import type { RgbChannels } from './rgb';
import type { RegionRequest } from './types';
import { validateCoordinates } from './region';

/**
 * Everything needed to put the Sky map back where a selection was made: the
 * region box itself plus the map view around it. Fields the coordinates alone
 * cannot recover are null when the view was rebuilt instead of cached.
 */
export interface SelectionView {
  region: RegionRequest;
  center: [number, number];
  fov_deg: number;
  projection: string | null;
  channel: number | null;
  /** Composite drawn at the time, or null for the single-channel view. */
  rgb: RgbChannels | null;
}

export interface ResolvedSelectionView {
  view: SelectionView;
  /** `cache`: the saved view; `coordinates`: rebuilt from the record's region. */
  source: 'cache' | 'coordinates';
}

type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;

const KEY_PREFIX = 'planetx_selection_view:';
const FORMAT_HEADER = 'planetx-selection-view v1';

/**
 * Rounds the shortest decimal form of `value` half-to-even, like the server's
 * `Decimal(repr(value)).quantize(...)`, so client and server agree on ties.
 */
function quantize(value: number, digits: number): string {
  const [mantissa, exponent = '0'] = String(Math.abs(value)).toLowerCase().split('e');
  const [intPart, fracPart = ''] = mantissa.split('.');
  // Shift the decimal point by the exponent, working on digit strings only.
  let digitsAll = intPart + fracPart;
  let point = intPart.length + Number(exponent);
  if (point < 0) {
    digitsAll = '0'.repeat(-point) + digitsAll;
    point = 0;
  }
  digitsAll = digitsAll.padEnd(point + digits + 1, '0');
  const kept = digitsAll.slice(0, point + digits);
  const rest = digitsAll.slice(point + digits);
  const lastKeptOdd = Number(kept.at(-1) ?? '0') % 2 === 1;
  const roundUp = rest[0] > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || lastKeptOdd));
  const scaled = (BigInt(kept || '0') + (roundUp ? 1n : 0n)).toString().padStart(digits + 1, '0');
  const result = `${scaled.slice(0, -digits)}.${scaled.slice(-digits)}`;
  // Never emit -0: the same region must always get the same key.
  return value < 0 && /[1-9]/.test(result) ? `-${result}` : result;
}

/**
 * Region identity exactly as the server stores it: RA wrapped to [0, 360) and
 * values rounded half-even to the column scales (Numeric 8,5 / 7,5 / 5,3).
 */
export function regionKey(region: RegionRequest): string {
  // Python's `ra % 360`: keep in-range values bit-exact, only wrap the negatives.
  let wrapped = region.ra_deg % 360;
  if (wrapped < 0) wrapped += 360;
  let ra = quantize(wrapped + 0, 5);
  if (Number(ra) >= 360) ra = '0.00000';
  return `${ra},${quantize(region.dec_deg, 5)},${quantize(region.size_arcmin, 3)}`;
}

/** Field of view that frames a region with some context around it. */
export function contextFovDeg(sizeArcmin: number): number {
  return Math.min(60, Math.max(0.1, (sizeArcmin * 2) / 60));
}

/** Plain `key=value` lines, one field per line, readable and editable by hand. */
export function serializeSelectionView(view: SelectionView): string {
  const { region, rgb } = view;
  return [
    FORMAT_HEADER,
    `region=${region.ra_deg},${region.dec_deg},${region.size_arcmin}`,
    `center=${view.center[0]},${view.center[1]}`,
    `fov=${view.fov_deg}`,
    `projection=${view.projection ?? ''}`,
    `channel=${view.channel ?? ''}`,
    `rgb=${rgb ? `${rgb.r},${rgb.g},${rgb.b}` : 'off'}`,
    '',
  ].join('\n');
}

function numbers(value: string | undefined, count: number): number[] | null {
  if (value === undefined) return null;
  const parts = value.split(',').map((part) => (part.trim() === '' ? NaN : Number(part)));
  return parts.length === count && parts.every(Number.isFinite) ? parts : null;
}

/** Parses text written by `serializeSelectionView`; null when anything is missing or invalid. */
export function parseSelectionView(text: string): SelectionView | null {
  const lines = text.split('\n');
  if (lines[0] !== FORMAT_HEADER) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const eq = line.indexOf('=');
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
  }

  const region = numbers(fields.get('region'), 3);
  const center = numbers(fields.get('center'), 2);
  const fov = numbers(fields.get('fov'), 1);
  if (!region || !center || !fov || fov[0] <= 0) return null;
  if (!validateCoordinates(region[0], region[1], region[2]).valid) return null;
  if (!validateCoordinates(center[0], center[1]).valid) return null;

  const channelText = fields.get('channel');
  const channel = channelText ? numbers(channelText, 1) : null;
  if (channelText && !channel) return null;

  const rgbText = fields.get('rgb');
  const rgb = rgbText === undefined || rgbText === 'off' ? null : numbers(rgbText, 3);
  if (rgbText !== undefined && rgbText !== 'off' && !rgb) return null;

  return {
    region: { ra_deg: region[0], dec_deg: region[1], size_arcmin: region[2] },
    center: [center[0], center[1]],
    fov_deg: fov[0],
    projection: fields.get('projection') || null,
    channel: channel ? channel[0] : null,
    rgb: rgb ? { r: rgb[0], g: rgb[1], b: rgb[2] } : null,
  };
}

function defaultStorage(): ViewStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Saves the view for its region; storage failures are ignored (the coordinates remain the fallback). */
export function saveSelectionView(view: SelectionView, storage: ViewStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(KEY_PREFIX + regionKey(view.region), serializeSelectionView(view));
  } catch {
    // Private mode, quota or blocked storage: restoring falls back to the coordinates.
  }
}

/** The cached view for a region, or null when absent, unreadable or corrupt. */
export function loadSelectionView(
  region: RegionRequest,
  storage: ViewStorage | null = defaultStorage(),
): SelectionView | null {
  try {
    const text = storage?.getItem(KEY_PREFIX + regionKey(region));
    return text ? parseSelectionView(text) : null;
  } catch {
    return null;
  }
}

/** The cached view when there is a valid one, otherwise one rebuilt from the region coordinates. */
export function resolveSelectionView(
  region: RegionRequest,
  storage: ViewStorage | null = defaultStorage(),
): ResolvedSelectionView {
  const cached = loadSelectionView(region, storage);
  if (cached) return { view: cached, source: 'cache' };
  return {
    view: {
      region,
      center: [region.ra_deg, region.dec_deg],
      fov_deg: contextFovDeg(region.size_arcmin),
      projection: null,
      channel: null,
      rgb: null,
    },
    source: 'coordinates',
  };
}
