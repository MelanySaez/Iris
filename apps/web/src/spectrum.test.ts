import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { parseHash, routeToHash } from './router';
import {
  MAX_SPECTRA,
  SERIES_COLORS,
  computeDomain,
  lineSegments,
  linearScale,
  nearestChannel,
  nextColorSlot,
  niceTicks,
  parseCoordinates,
  spectrumKey,
} from './spectrum';
import type { CubeSpectrumPoint } from './types';

function point(channel: number, wavelength: number, value: number | null): CubeSpectrumPoint {
  return {
    channel,
    detector: Math.floor(channel / 17) + 1,
    subchannel: (channel % 17) + 1,
    wavelength_um: wavelength,
    bandwidth_um: 0.02,
    wl_min_um: wavelength - 0.01,
    wl_max_um: wavelength + 0.01,
    value,
    nhits: value === null ? 0 : 5,
    flags: 0,
    available: value !== null,
  };
}

describe('spectral lab routing', () => {
  it('parses and builds the #/spectral route', () => {
    expect(parseHash('#/spectral')).toEqual({ type: 'spectral' });
    expect(routeToHash({ type: 'spectral' })).toBe('#/spectral');
  });

  it('keeps the existing sky and plate routes unchanged', () => {
    expect(parseHash('#/sky')).toEqual({ type: 'sky' });
    expect(parseHash('')).toEqual({ type: 'sky' });
    expect(parseHash('#/spectral-x')).toEqual({ type: 'sky' });
    expect(parseHash('#/plate/abc%20123')).toEqual({ type: 'plate', jobId: 'abc 123' });
    expect(routeToHash({ type: 'plate', jobId: 'abc 123' })).toBe('#/plate/abc%20123');
    expect(routeToHash({ type: 'sky' })).toBe('#/sky');
  });
});

describe('series colour slots', () => {
  it('offers eight fixed colours', () => {
    expect(MAX_SPECTRA).toBe(8);
    expect(new Set(SERIES_COLORS).size).toBe(8);
  });

  it('reuses only freed slots so survivors keep their colour', () => {
    expect(nextColorSlot([])).toBe(0);
    expect(nextColorSlot([0, 1, 2])).toBe(3);
    // Removing the spectrum in slot 1 frees exactly that slot; 0 and 2 stay put.
    expect(nextColorSlot([0, 2])).toBe(1);
    expect(nextColorSlot([0, 1, 2, 3, 4, 5, 6, 7])).toBeNull();
  });
});

describe('spectrumKey', () => {
  it('normalises RA into [0, 360) and rounds to 4 decimals', () => {
    expect(spectrumKey(148.888, 69.065)).toBe('148.8880,69.0650');
    expect(spectrumKey(-10, 5)).toBe(spectrumKey(350, 5));
    expect(spectrumKey(360, 0)).toBe(spectrumKey(0, 0));
  });
});

describe('niceTicks', () => {
  it('returns round steps inside the range', () => {
    expect(niceTicks(0, 210, 5)).toEqual([0, 50, 100, 150, 200]);
    expect(niceTicks(0.74, 5.0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles degenerate ranges', () => {
    expect(niceTicks(3, 3)).toEqual([3]);
    expect(niceTicks(NaN, 1)).toEqual([]);
  });
});

describe('computeDomain', () => {
  it('spans every channel band and starts y at zero with headroom', () => {
    const domain = computeDomain([
      [point(0, 0.75, 80), point(1, 0.77, null)],
      [point(0, 0.75, 20), point(101, 4.99, 100)],
    ]);
    expect(domain?.x[0]).toBeCloseTo(0.74);
    expect(domain?.x[1]).toBeCloseTo(5.0);
    expect(domain?.y[0]).toBe(0);
    expect(domain?.y[1]).toBeCloseTo(108);
  });

  it('extends below zero for negative surface brightness', () => {
    const domain = computeDomain([[point(0, 1, -10), point(1, 2, 10)]]);
    expect(domain?.y[0]).toBe(-10);
  });

  it('returns null when nothing has data', () => {
    expect(computeDomain([])).toBeNull();
    expect(computeDomain([[point(0, 1, null)]])).toBeNull();
  });
});

describe('lineSegments', () => {
  const x = linearScale([0, 10], [0, 100]);
  const y = linearScale([0, 10], [100, 0]);

  it('breaks the line at channels without coverage instead of bridging them', () => {
    const segments = lineSegments(
      [point(0, 1, 1), point(1, 2, 2), point(2, 3, null), point(3, 4, 4), point(4, 5, 5)],
      x,
      y,
    );
    expect(segments).toEqual(['M10.00,90.00 L20.00,80.00', 'M40.00,60.00 L50.00,50.00']);
  });

  it('orders points by wavelength', () => {
    expect(lineSegments([point(1, 2, 2), point(0, 1, 1)], x, y)).toEqual([
      'M10.00,90.00 L20.00,80.00',
    ]);
  });
});

describe('nearestChannel', () => {
  it('picks the channel closest to the hovered wavelength', () => {
    const points = [point(0, 1, 1), point(1, 2, 2), point(2, 3, 3)];
    expect(nearestChannel(points, 2.4)).toBe(1);
    expect(nearestChannel(points, 9)).toBe(2);
    expect(nearestChannel([], 1)).toBe(-1);
  });
});

describe('parseCoordinates', () => {
  it('accepts degrees in range', () => {
    expect(parseCoordinates(' 148.888 ', '69.065')).toEqual({ ra: 148.888, dec: 69.065 });
    expect(parseCoordinates('0', '-90')).toEqual({ ra: 0, dec: -90 });
  });

  it('rejects empty, non-numeric and out-of-range values', () => {
    expect(parseCoordinates('', '1')).toEqual({
      error: 'RA must be a number in degrees, 0 ≤ RA < 360.',
    });
    expect(parseCoordinates('360', '1')).toHaveProperty('error');
    expect(parseCoordinates('abc', '1')).toHaveProperty('error');
    expect(parseCoordinates('10', '91')).toEqual({
      error: 'Dec must be a number in degrees, −90 ≤ Dec ≤ 90.',
    });
    expect(parseCoordinates('10', '')).toHaveProperty('error');
  });
});

describe('api.getSpectrum', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls GET /api/spectrum with ra and dec', async () => {
    const body = { points: [] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getSpectrum(148.888, 69.065)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/spectrum?ra=148.888&dec=69.065', expect.any(Object));
  });

  it('surfaces the backend detail on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ detail: 'No All-Sky Cube tile covers this position.' }),
      }),
    );
    const error = await api.getSpectrum(1, 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).toBe('No All-Sky Cube tile covers this position.');
  });
});
