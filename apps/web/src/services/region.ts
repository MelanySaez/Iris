import type { RegionRequest } from '../types/types';

export const MIN_REGION_SIZE_ARCMIN = 1;
export const MAX_REGION_SIZE_ARCMIN = 60;

export const REGION_EXCEEDS_LIMIT_MESSAGE =
  'This region exceeds the 60-arcmin single-FITS limit; multi-file mosaicking is pending.';

export interface RegionBounds {
  ra_deg: number;
  dec_deg: number;
  raw_size_arcmin: number;
  clamped_size_arcmin: number;
  exceeds_limit: boolean;
}

export interface ValidationResult {
  valid: boolean;
  error: string | null;
}

export function validateCoordinates(
  ra: number,
  dec: number,
  sizeArcmin?: number,
): ValidationResult {
  if (!Number.isFinite(ra)) {
    return { valid: false, error: 'Right Ascension must be a finite number.' };
  }
  if (!Number.isFinite(dec)) {
    return { valid: false, error: 'Declination must be a finite number.' };
  }
  if (dec < -90 || dec > 90) {
    return { valid: false, error: 'Declination must be between -90° and +90°.' };
  }
  if (sizeArcmin !== undefined) {
    if (!Number.isFinite(sizeArcmin)) {
      return { valid: false, error: 'Region size must be a finite number.' };
    }
    if (sizeArcmin < MIN_REGION_SIZE_ARCMIN) {
      return {
        valid: false,
        error: `Region size cannot be smaller than ${MIN_REGION_SIZE_ARCMIN} arcminute.`,
      };
    }
    if (sizeArcmin > MAX_REGION_SIZE_ARCMIN) {
      return {
        valid: false,
        error: REGION_EXCEEDS_LIMIT_MESSAGE,
      };
    }
  }
  return { valid: true, error: null };
}

export function clampRegionSize(sizeArcmin: number): number {
  if (!Number.isFinite(sizeArcmin)) return MIN_REGION_SIZE_ARCMIN;
  return Math.min(MAX_REGION_SIZE_ARCMIN, Math.max(MIN_REGION_SIZE_ARCMIN, sizeArcmin));
}

export function computeRegionFromPoints(
  startWorld: [number, number],
  endWorld: [number, number],
): RegionBounds {
  let [ra1, dec1] = startWorld;
  let [ra2, dec2] = endWorld;

  let deltaRa = Math.abs(ra1 - ra2);
  let centerRa: number;

  if (deltaRa > 180) {
    // Crosses RA 0/360 boundary
    deltaRa = 360 - deltaRa;
    centerRa = ((ra1 + ra2 + 360) / 2) % 360;
  } else {
    centerRa = (ra1 + ra2) / 2;
  }

  const centerDec = (dec1 + dec2) / 2;
  const cosDec = Math.cos((centerDec * Math.PI) / 180);

  const widthArcmin = deltaRa * cosDec * 60;
  const heightArcmin = Math.abs(dec1 - dec2) * 60;

  const rawSize = Math.max(widthArcmin, heightArcmin);
  const exceedsLimit = rawSize > MAX_REGION_SIZE_ARCMIN;
  const clampedSize = clampRegionSize(rawSize);

  return {
    ra_deg: centerRa,
    dec_deg: centerDec,
    raw_size_arcmin: rawSize,
    clamped_size_arcmin: clampedSize,
    exceeds_limit: exceedsLimit,
  };
}

/** Signed RA difference `to - from` in degrees, taking the short way round 0/360. */
function wrappedRaDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Moves a region by the sky offset between two pointer positions; size is unchanged. */
export function moveRegion<T extends RegionRequest>(
  region: T,
  fromWorld: [number, number],
  toWorld: [number, number],
): T {
  const ra = (region.ra_deg + wrappedRaDelta(fromWorld[0], toWorld[0]) + 360) % 360;
  const dec = Math.min(90, Math.max(-90, region.dec_deg + toWorld[1] - fromWorld[1]));
  return { ...region, ra_deg: ra, dec_deg: dec };
}

/** Resizes a region around its centre so the pointer lies on its edge, clamped to the allowed range. */
export function resizeRegion<T extends RegionRequest>(region: T, pointerWorld: [number, number]): T {
  const cosDec = Math.cos((region.dec_deg * Math.PI) / 180);
  const halfRa = Math.abs(wrappedRaDelta(region.ra_deg, pointerWorld[0])) * cosDec;
  const halfDec = Math.abs(pointerWorld[1] - region.dec_deg);
  return { ...region, size_arcmin: clampRegionSize(2 * Math.max(halfRa, halfDec) * 60) };
}
