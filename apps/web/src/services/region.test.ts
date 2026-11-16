import { describe, expect, it } from 'vitest';
import {
  clampRegionSize,
  computeRegionFromPoints,
  MAX_REGION_SIZE_ARCMIN,
  MIN_REGION_SIZE_ARCMIN,
  moveRegion,
  REGION_EXCEEDS_LIMIT_MESSAGE,
  resizeRegion,
  validateCoordinates,
} from './region';

describe('region module', () => {
  describe('validateCoordinates', () => {
    it('accepts valid coordinates within allowable ranges', () => {
      const res = validateCoordinates(210.80227, 54.34895, 6.0);
      expect(res.valid).toBe(true);
      expect(res.error).toBeNull();
    });

    it('rejects non-finite Right Ascension', () => {
      expect(validateCoordinates(NaN, 50, 6).valid).toBe(false);
      expect(validateCoordinates(Infinity, 50, 6).valid).toBe(false);
    });

    it('rejects Declination outside [-90, +90]', () => {
      expect(validateCoordinates(100, 95, 6).valid).toBe(false);
      expect(validateCoordinates(100, -95, 6).valid).toBe(false);
      expect(validateCoordinates(100, 90, 6).valid).toBe(true);
      expect(validateCoordinates(100, -90, 6).valid).toBe(true);
    });

    it('rejects size smaller than minimum (1 arcmin)', () => {
      const res = validateCoordinates(100, 45, 0.5);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('smaller than 1 arcminute');
    });

    it('rejects size exceeding 60 arcmin with the exact contract message', () => {
      const res = validateCoordinates(100, 45, 65);
      expect(res.valid).toBe(false);
      expect(res.error).toBe(REGION_EXCEEDS_LIMIT_MESSAGE);
      expect(res.error).toBe(
        'This region exceeds the 60-arcmin single-FITS limit; multi-file mosaicking is pending.',
      );
    });
  });

  describe('clampRegionSize', () => {
    it('preserves valid sizes between 1 and 30 arcmin', () => {
      expect(clampRegionSize(6)).toBe(6);
      expect(clampRegionSize(29.5)).toBe(29.5);
      expect(clampRegionSize(1)).toBe(1);
      expect(clampRegionSize(30)).toBe(30);
    });

    it('clamps sizes less than 1 arcmin to 1', () => {
      expect(clampRegionSize(0.2)).toBe(MIN_REGION_SIZE_ARCMIN);
      expect(clampRegionSize(-5)).toBe(MIN_REGION_SIZE_ARCMIN);
    });

    it('clamps sizes greater than 60 arcmin to 60', () => {
      expect(clampRegionSize(75)).toBe(MAX_REGION_SIZE_ARCMIN);
      expect(clampRegionSize(120)).toBe(MAX_REGION_SIZE_ARCMIN);
    });

    it('handles non-finite values by falling back to 1 arcmin', () => {
      expect(clampRegionSize(NaN)).toBe(MIN_REGION_SIZE_ARCMIN);
    });
  });

  describe('computeRegionFromPoints', () => {
    it('computes center and angular size for standard points', () => {
      // 0.1 degree in Dec is 6.0 arcmin
      const p1: [number, number] = [10.0, 20.0];
      const p2: [number, number] = [10.0, 20.1];

      const res = computeRegionFromPoints(p1, p2);
      expect(res.ra_deg).toBeCloseTo(10.0);
      expect(res.dec_deg).toBeCloseTo(20.05);
      expect(res.raw_size_arcmin).toBeCloseTo(6.0);
      expect(res.clamped_size_arcmin).toBeCloseTo(6.0);
      expect(res.exceeds_limit).toBe(false);
    });

    it('flags exceeds_limit when raw size > 60 arcmin', () => {
      // 1.0 degree in Dec is 60 arcmin
      const p1: [number, number] = [0.0, 0.0];
      const p2: [number, number] = [0.0, 2.0];

      const res = computeRegionFromPoints(p1, p2);
      expect(res.raw_size_arcmin).toBeCloseTo(120.0);
      expect(res.exceeds_limit).toBe(true);
      expect(res.clamped_size_arcmin).toBe(60.0);
    });

    it('handles RA wrapping around the 0/360 boundary correctly', () => {
      const p1: [number, number] = [359.9, 0.0];
      const p2: [number, number] = [0.1, 0.0];

      const res = computeRegionFromPoints(p1, p2);
      // Delta RA should be 0.2 degrees (12 arcmin), not 359.8 degrees!
      expect(res.ra_deg).toBeCloseTo(0.0);
      expect(res.raw_size_arcmin).toBeCloseTo(12.0);
      expect(res.exceeds_limit).toBe(false);
    });

    it('applies cos(Dec) projection factor to RA width', () => {
      // At dec = 60°, cos(60°) = 0.5
      // 0.2 degrees in RA * cos(60°) = 0.1 degrees = 6.0 arcmin
      const p1: [number, number] = [100.0, 60.0];
      const p2: [number, number] = [100.2, 60.0];

      const res = computeRegionFromPoints(p1, p2);
      expect(res.raw_size_arcmin).toBeCloseTo(6.0);
    });
  });

  describe('moveRegion', () => {
    it('shifts the centre by the pointer delta and keeps the size', () => {
      const res = moveRegion({ ra_deg: 100, dec_deg: 10, size_arcmin: 6 }, [100.5, 10.2], [100.7, 10.1]);
      expect(res.ra_deg).toBeCloseTo(100.2);
      expect(res.dec_deg).toBeCloseTo(9.9);
      expect(res.size_arcmin).toBe(6);
    });

    it('wraps RA across the 0/360 boundary', () => {
      const res = moveRegion({ ra_deg: 359.95, dec_deg: 0, size_arcmin: 6 }, [359.9, 0], [0.1, 0]);
      expect(res.ra_deg).toBeCloseTo(0.15);
    });

    it('keeps Declination within [-90, +90]', () => {
      const res = moveRegion({ ra_deg: 10, dec_deg: 89.9, size_arcmin: 6 }, [10, 89], [10, 91]);
      expect(res.dec_deg).toBe(90);
    });
  });

  describe('resizeRegion', () => {
    it('sizes the square so the pointer sits on its edge, keeping the centre', () => {
      // 0.05 deg in Dec from the centre = 3 arcmin half side = 6 arcmin square
      const res = resizeRegion({ ra_deg: 100, dec_deg: 0, size_arcmin: 20 }, [100.01, 0.05]);
      expect(res.ra_deg).toBe(100);
      expect(res.dec_deg).toBe(0);
      expect(res.size_arcmin).toBeCloseTo(6);
    });

    it('applies cos(Dec) to the RA offset and wraps RA', () => {
      // 0.1 deg RA at dec 60 = 0.05 deg = 3 arcmin half side
      const res = resizeRegion({ ra_deg: 359.95, dec_deg: 60, size_arcmin: 20 }, [0.05, 60]);
      expect(res.size_arcmin).toBeCloseTo(6);
    });

    it('clamps the size to the allowed range', () => {
      const centre = { ra_deg: 100, dec_deg: 0, size_arcmin: 6 };
      expect(resizeRegion(centre, [100, 5]).size_arcmin).toBe(MAX_REGION_SIZE_ARCMIN);
      expect(resizeRegion(centre, [100, 0]).size_arcmin).toBe(MIN_REGION_SIZE_ARCMIN);
    });
  });
});
