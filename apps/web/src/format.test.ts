import { describe, expect, it } from 'vitest';
import {
  formatAngle,
  formatArcmin,
  formatBandwidth,
  formatDateIso,
  formatDec,
  formatFlux,
  formatFov,
  formatMjd,
  formatRa,
  formatRaDec,
  formatWavelength,
} from './format';

describe('format utilities', () => {
  describe('RA and Dec coordinate formatting', () => {
    it('formats Right Ascension to 5 decimals with degree symbol', () => {
      expect(formatRa(270.693033)).toBe('270.69303°');
      expect(formatRa(0)).toBe('0.00000°');
    });

    it('normalizes RA out-of-bounds values into [0, 360)', () => {
      expect(formatRa(365)).toBe('5.00000°');
      expect(formatRa(-10)).toBe('350.00000°');
    });

    it('formats Declination with explicit sign and 5 decimals', () => {
      expect(formatDec(61.876516)).toBe('+61.87652°');
      expect(formatDec(-7.2451)).toBe('-7.24510°');
      expect(formatDec(0)).toBe('+0.00000°');
    });

    it('combines RA and Dec cleanly', () => {
      expect(formatRaDec(210.80227, 54.34895)).toBe('210.80227°, +54.34895°');
    });

    it('handles non-finite coordinates gracefully', () => {
      expect(formatRa(NaN)).toBe('—');
      expect(formatDec(Infinity)).toBe('—');
      expect(formatRaDec(NaN, 50)).toBe('—, +50.00000°');
    });
  });

  describe('Wavelength λ and bandwidth formatting', () => {
    it('formats wavelength to 4 decimals in micrometres', () => {
      expect(formatWavelength(2.089)).toBe('2.0890 µm');
      expect(formatWavelength(0.753123)).toBe('0.7531 µm');
    });

    it('returns dash for null or non-finite wavelength', () => {
      expect(formatWavelength(null)).toBe('—');
      expect(formatWavelength(undefined)).toBe('—');
      expect(formatWavelength(NaN)).toBe('—');
    });

    it('formats bandwidth as half-width window', () => {
      expect(formatBandwidth(0.04)).toBe('±0.0200 µm');
    });
  });

  describe('Angle and FOV formatting', () => {
    it('formats degrees for angles >= 1°', () => {
      expect(formatAngle(180)).toBe('180.0°');
      expect(formatAngle(4.5)).toBe('4.50°');
    });

    it('formats arcminutes for angles < 1° and >= 1 arcmin', () => {
      expect(formatAngle(0.1)).toBe('6.00′');
      expect(formatAngle(0.5)).toBe('30.0′');
    });

    it('formats arcseconds for angles < 1 arcmin', () => {
      expect(formatAngle(0.005)).toBe('18.0″');
    });

    it('formats FOV square box label', () => {
      expect(formatFov(6.0)).toBe('6.0′ × 6.0′');
      expect(formatFov(12.5)).toBe('12.5′ × 12.5′');
    });

    it('formats arcminute values', () => {
      expect(formatArcmin(8.25)).toBe('8.3′');
    });
  });

  describe('Date and MJD formatting', () => {
    it('formats ISO dates cleanly', () => {
      const formatted = formatDateIso('2025-09-18T05:04:37Z');
      expect(formatted).toContain('2025-09-18');
      expect(formatted).toContain('UTC');
    });

    it('returns original or dash for invalid date', () => {
      expect(formatDateIso(null)).toBe('—');
      expect(formatDateIso('not-a-date')).toBe('not-a-date');
    });

    it('formats Modified Julian Date to 4 decimals', () => {
      expect(formatMjd(60805.711548)).toBe('MJD 60805.7115');
      expect(formatMjd(null)).toBe('—');
    });
  });

  describe('Flux formatting', () => {
    it('formats standard flux with unit', () => {
      expect(formatFlux(0.42, 'MJy/sr')).toBe('0.4200 MJy/sr');
    });

    it('formats very small or very large flux with exponential notation', () => {
      expect(formatFlux(0.000012, 'MJy/sr')).toBe('1.2000e-5 MJy/sr');
      expect(formatFlux(50000, 'MJy/sr')).toBe('5.0000e+4 MJy/sr');
    });
  });
});
