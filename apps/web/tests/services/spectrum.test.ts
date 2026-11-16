import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, CURATED_CATALOG_FALLBACK } from '../../src/api/api';
import { parseHash, routeToHash } from '../../src/core/router';
import {
  MAX_SPECTRA,
  SERIES_COLORS,
  computeDomain,
  lineSegments,
  linearScale,
  nearestChannel,
  applyIfCurrent,
  planAdd,
  logScale,
  logTicks,
  countNonPositive,
  nextColorSlot,
  niceTicks,
  parseCoordinates,
  spectrumKey,
  interpolateMissingFlux,
  estimatedRuns,
  zoomDomainAt,
  panDomain,
} from '../../src/services/spectrum';
import type { CubeSpectrumPoint } from '../../src/types/types';

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
    expect(parseHash('')).toEqual({ type: 'landing' }); // empty address opens the landing page
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

  it('gives the same key to positions that round to the same place', () => {
    expect(spectrumKey(10, -0.00001)).toBe(spectrumKey(10, 0));
    expect(spectrumKey(359.99999, 5)).toBe(spectrumKey(0, 5));
    expect(spectrumKey(-0.00001, 5)).toBe(spectrumKey(0, 5));
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

describe('chart domain interactions', () => {
  it('zooms around a pointer anchor in both linear and logarithmic domains', () => {
    expect(zoomDomainAt([0, 100], 2, 0.25)).toEqual([12.5, 62.5]);
    const logDomain = zoomDomainAt([1, 1000], 2, 0.25, true);
    expect(logDomain[0]).toBeCloseTo(10 ** 0.375);
    expect(logDomain[1]).toBeCloseTo(10 ** 1.875);
  });

  it('pans domains while clamping to valid bounds and keeping log values positive', () => {
    expect(panDomain([20, 60], -0.5, [0, 100])).toEqual([0, 40]);
    const panned = panDomain([10, 100], 0.5, [1, 1000], true);
    expect(panned[0]).toBeGreaterThan(0);
    expect(panned[1]).toBeLessThanOrEqual(1000);
  });
});

describe('interpolateMissingFlux', () => {
  it('linearly fills short interior null runs by wavelength without mutating raw points', () => {
    const raw = [point(0, 1, 10), { ...point(1, 2, null), available: true }, point(2, 4, 30)];
    const before = structuredClone(raw);
    const result = interpolateMissingFlux(raw, 2);
    expect(result[0].value).toBe(10);
    expect(result[1].value).toBeCloseTo(50 / 3);
    expect(result[2].value).toBe(30);
    expect(result[1].interpolated).toBe(true);
    expect(result[0].interpolated).toBe(false);
    expect(raw).toEqual(before);
  });

  it('interpolates nulls even when the endpoint marks them unavailable, but not edge gaps or long runs', () => {
    const unavailable = { ...point(2, 3, null), available: false };
    const raw = [
      { ...point(0, 0, null), available: true }, point(1, 1, 10),
      { ...point(2, 2, null), available: true }, unavailable,
      point(4, 4, 50), { ...point(5, 5, null), available: true },
      { ...point(6, 6, null), available: true }, { ...point(7, 7, null), available: true }, point(8, 8, 90),
    ];
    const values = interpolateMissingFlux(raw, 2).map((p) => p.value);
    expect(values[0]).toBeNull();
    expect(values[1]).toBe(10);
    expect(values[2]).toBeCloseTo(70 / 3);
    expect(values[3]).toBeCloseTo(110 / 3);
    expect(values.slice(4)).toEqual([50, null, null, null, 90]);
  });

  it('bridges the blank channels between two detectors with an estimate', () => {
    // Channels 49 (D3) and 52 (D4) straddle the blank channels 50-51.
    const raw = [
      point(48, 2.40, 10), point(49, 2.42, 12),
      { ...point(50, 2.44, null), available: false }, { ...point(51, 2.46, null), available: false },
      point(52, 2.48, 18), point(53, 2.50, 20),
    ];
    const result = interpolateMissingFlux(raw, 2);
    expect(result[2].value).toBeCloseTo(14);
    expect(result[3].value).toBeCloseTo(16);
    expect(result.filter((p) => p.interpolated).map((p) => p.channel)).toEqual([50, 51]);
  });

  it('by default fills gaps up to a fifth of the spectrum (20 of 102 channels) and no longer', () => {
    const spectrum102 = (gapStart: number, gapLength: number) =>
      Array.from({ length: 102 }, (_, c) =>
        point(c, 0.75 + c * 0.04, c >= gapStart && c < gapStart + gapLength ? null : 100));
    const filled = interpolateMissingFlux(spectrum102(10, 20));
    expect(filled.filter((p) => p.interpolated)).toHaveLength(20);
    expect(filled.every((p) => p.value === 100)).toBe(true);

    const tooLong = interpolateMissingFlux(spectrum102(10, 21));
    expect(tooLong.some((p) => p.interpolated)).toBe(false);
    expect(tooLong.filter((p) => p.value === null)).toHaveLength(21);
  });

  it('leaves every gap empty when maxGap is 0', () => {
    const raw = [point(0, 1, 10), { ...point(1, 2, null), available: true }, point(2, 3, 30)];
    const result = interpolateMissingFlux(raw, 0);
    expect(result[1].value).toBeNull();
    expect(result[1].interpolated).toBe(false);
  });
});

describe('estimatedRuns', () => {
  it('groups consecutive estimates into runs', () => {
    const raw = [
      point(0, 1, 10), { ...point(1, 2, null), available: false }, point(2, 3, 30),
      { ...point(3, 4, null), available: false }, { ...point(4, 5, null), available: false }, point(5, 6, 60),
    ];
    const runs = estimatedRuns(interpolateMissingFlux(raw, 2));
    expect(runs.map((r) => r.points.map((p) => p.channel))).toEqual([[1], [3, 4]]);
  });

  it('returns nothing when no channel was estimated', () => {
    expect(estimatedRuns(interpolateMissingFlux([point(0, 1, 10), point(1, 2, 20)]))).toEqual([]);
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

describe('applyIfCurrent', () => {
  type Entry = { key: string; requestId: number; status: string };
  const loading: Entry[] = [
    { key: 'a', requestId: 2, status: 'loading' },
    { key: 'b', requestId: 1, status: 'ready' },
  ];

  it('applies the result of the request that is still current', () => {
    const next = applyIfCurrent(loading, 'a', 2, { status: 'ready' });
    expect(next[0]).toEqual({ key: 'a', requestId: 2, status: 'ready' });
    expect(next[1]).toBe(loading[1]);
  });

  it('drops a stale result after the spectrum was removed and re-added', () => {
    // Request 1 for "a" was superseded by request 2 when the user re-added it.
    expect(applyIfCurrent(loading, 'a', 1, { status: 'error' })).toBe(loading);
  });

  it('drops a result for a spectrum that was removed', () => {
    expect(applyIfCurrent(loading, 'gone', 3, { status: 'ready' })).toBe(loading);
  });
});

describe('planAdd', () => {
  const entry = (key: string, slot: number) => ({ key, slot });

  it('assigns the lowest free colour slot to a new position', () => {
    expect(planAdd([entry('a', 0), entry('b', 2)], 'c', 'C')).toEqual({ slot: 1 });
  });

  it('rejects a position that is already compared', () => {
    expect(planAdd([entry('a', 0)], 'a', 'M81')).toEqual({
      error: 'M81 is already in the comparison.',
    });
  });

  it('rejects a ninth spectrum', () => {
    const full = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => entry(`k${s}`, s));
    expect(planAdd(full, 'new', 'X')).toEqual({
      error: 'Compare at most 8 spectra; remove one first.',
    });
  });
});

describe('logarithmic y axis', () => {
  it('spans whole decades around the positive values', () => {
    const domain = computeDomain([[point(0, 1, 3), point(1, 2, 250)]], 'log');
    expect(domain?.y).toEqual([1, 1000]);
  });

  it('ignores zero and negative values when sizing a log axis', () => {
    const domain = computeDomain([[point(0, 1, -4), point(1, 2, 0), point(2, 3, 0.5), point(3, 4, 20)]], 'log');
    expect(domain?.y).toEqual([0.1, 100]);
  });

  it('returns null for a log axis when nothing is positive', () => {
    expect(computeDomain([[point(0, 1, -1), point(1, 2, 0)]], 'log')).toBeNull();
  });

  it('keeps the linear domain unchanged by default', () => {
    expect(computeDomain([[point(0, 1, 50), point(1, 2, 100)]])?.y[0]).toBe(0);
  });

  it('maps decades evenly and non-positive values to NaN', () => {
    const y = logScale([1, 100], [200, 0]);
    expect(y(1)).toBe(200);
    expect(y(10)).toBe(100);
    expect(y(100)).toBe(0);
    expect(y(0)).toBeNaN();
    expect(y(-3)).toBeNaN();
  });

  it('puts ticks on powers of ten, adding 2 and 5 when the range is narrow', () => {
    expect(logTicks(0.1, 1000)).toEqual([0.1, 1, 10, 100, 1000]);
    expect(logTicks(1, 100)).toEqual([1, 2, 5, 10, 20, 50, 100]);
  });

  it('breaks the line where a value cannot be drawn on the log axis', () => {
    const x = linearScale([0, 10], [0, 100]);
    const y = logScale([1, 100], [100, 0]);
    const segments = lineSegments([point(0, 1, 10), point(1, 2, 100), point(2, 3, -1), point(3, 4, 10)], x, y);
    expect(segments).toEqual(['M10.00,50.00 L20.00,0.00', 'M40.00,50.00']);
  });

  it('counts the points a log axis has to hide', () => {
    expect(countNonPositive([[point(0, 1, 0), point(1, 2, 5)], [point(0, 1, -2), point(1, 2, null)]])).toBe(2);
  });
});

describe('curated catalog fallback', () => {
  const byId = new Map(CURATED_CATALOG_FALLBACK.map((o) => [o.id, o]));

  it('labels the notebook demo field as M101, where it really points', () => {
    expect(byId.has('m81-field')).toBe(false);
    expect(byId.get('m101-field')).toMatchObject({ name: 'M101 field', ra_deg: 210.80227, dec_deg: 54.34895 });
  });

  it('includes M81 at its real J2000 position', () => {
    const m81 = byId.get('m81');
    expect(m81?.name).toBe("M81 (Bode's Galaxy)");
    expect(m81?.ra_deg).toBeCloseTo(148.888221, 6);
    expect(m81?.dec_deg).toBeCloseTo(69.065294, 6);
  });
});
