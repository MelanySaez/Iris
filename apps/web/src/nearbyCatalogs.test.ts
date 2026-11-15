import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NEARBY_RADIUS_DEG,
  MAX_NEARBY_RESULTS,
  searchNearbyCatalogs,
} from './nearbyCatalogs';
import type { TocatsQueryResult } from './tocats';

const emptyTocatsResult: TocatsQueryResult = {
  sources: [], columns: {}, found: 0, truncated: false,
};

function tocatsSource(id: string, ra: number, dec: number) {
  return { id, ra, dec, data: { source_id: id } };
}

function options(overrides: Partial<Parameters<typeof searchNearbyCatalogs>[0]> = {}) {
  return {
    raDeg: 359.9,
    decDeg: 0,
    visibleCatalogIds: [] as const,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('searchNearbyCatalogs', () => {
  it('uses the 0.5-degree default cone and excludes visible layers from provider requests', async () => {
    const query = vi.fn().mockResolvedValue(emptyTocatsResult);
    const fetcher = vi.fn();
    const results = await searchNearbyCatalogs(options({ visibleCatalogIds: ['featured', 'gaia', 'simbad'] }), {
      tocatsClient: { query }, fetcher,
      featuredObjects: [],
    });

    expect(DEFAULT_NEARBY_RADIUS_DEG).toBe(0.5);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('catwise', {
      raDeg: 359.9, decDeg: 0, radiusDeg: 0.5,
    }, undefined);
    expect(fetcher).not.toHaveBeenCalled();
    expect(results.map(({ catalogId }) => catalogId)).toEqual(['catwise']);
  });

  it('passes exact coordinates and requested radius, while capping provider result counts', async () => {
    const query = vi.fn().mockResolvedValue({
      ...emptyTocatsResult,
      sources: Array.from({ length: MAX_NEARBY_RESULTS + 5 }, (_, index) => tocatsSource(String(index), 10, 2)),
    });
    const results = await searchNearbyCatalogs(options({ raDeg: 10, decDeg: 2, radiusDeg: 1.25, visibleCatalogIds: ['featured', 'simbad', 'catwise'] }), {
      tocatsClient: { query }, featuredObjects: [],
    });

    expect(query).toHaveBeenCalledWith('gaia', {
      raDeg: 10, decDeg: 2, radiusDeg: 1.25,
    }, undefined);
    expect(results[0].sources).toHaveLength(MAX_NEARBY_RESULTS);
  });

  it('spherically filters nearby featured sources across RA wraparound', async () => {
    const results = await searchNearbyCatalogs(options({
      raDeg: 359.99, decDeg: 0, visibleCatalogIds: ['gaia', 'simbad', 'catwise'],
    }), {
      featuredObjects: [
        { id: 'near', name: 'Across zero', ra_deg: 0.01, dec_deg: 0, type: 'star', description: '', coordinateFrame: 'ICRS', referenceEpoch: 'J2000', positionSource: 'fixture', positionSourceUrl: 'https://example.test' },
        { id: 'far', name: 'Outside', ra_deg: 1, dec_deg: 0, type: 'star', description: '', coordinateFrame: 'ICRS', referenceEpoch: 'J2000', positionSource: 'fixture', positionSourceUrl: 'https://example.test' },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0].catalogId).toBe('featured');
    expect(results[0].sources.map(({ id }) => id)).toEqual(['near']);
  });

  it('keeps successful providers when one hidden catalog fails', async () => {
    const query = vi.fn(async (catalogId: string) => {
      if (catalogId === 'gaia') throw new Error('Gaia unavailable');
      return emptyTocatsResult;
    });
    const results = await searchNearbyCatalogs(options({ visibleCatalogIds: ['featured', 'simbad'] }), {
      tocatsClient: { query }, featuredObjects: [],
    });

    expect(results.map(({ catalogId }) => catalogId)).toEqual(['gaia', 'catwise']);
    expect(results[0].error).toBe('Gaia unavailable');
    expect(results[1].error).toBeUndefined();
  });

  it('queries SIMBAD TAP and parses identifiers and row metadata', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      metadata: [{ name: 'main_id' }, { name: 'ra' }, { name: 'dec' }, { name: 'otype' }],
      data: [['* alf CMa', 101.287, -16.716, 'Star']],
    }), { headers: { 'content-type': 'application/json' } }));
    const results = await searchNearbyCatalogs(options({ raDeg: 101, decDeg: -16, radiusDeg: 0.2, visibleCatalogIds: ['featured', 'gaia', 'catwise'] }), {
      fetcher, featuredObjects: [],
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(fetcher.mock.calls[0][0] as string);
    expect(requestUrl.origin + requestUrl.pathname).toBe('https://simbad.cds.unistra.fr/simbad/sim-tap/sync');
    expect(decodeURIComponent(requestUrl.searchParams.get('QUERY') ?? '')).toContain("CIRCLE('ICRS', 101, -16, 0.2)");
    expect(results[0].sources[0]).toMatchObject({
      id: '* alf CMa', catalogId: 'simbad', raDeg: 101.287, decDeg: -16.716,
      data: { main_id: '* alf CMa', otype: 'Star' },
    });
  });

  it('rejects invalid coordinates and radii', async () => {
    await expect(searchNearbyCatalogs(options({ raDeg: Number.NaN }))).rejects.toThrow(/coordinates/i);
    await expect(searchNearbyCatalogs(options({ decDeg: 91 }))).rejects.toThrow(/coordinates/i);
    await expect(searchNearbyCatalogs(options({ radiusDeg: 0 }))).rejects.toThrow(/radius/i);
  });

  it('propagates aborts instead of returning per-catalog errors', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(searchNearbyCatalogs(options({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
