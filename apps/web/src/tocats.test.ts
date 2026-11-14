import { describe, expect, it, vi } from 'vitest';
import {
  buildTocatsConeUrl,
  buildTocatsDensityUrl,
  chooseTocatsDensityOrder,
  formatTocatsDensityPopup,
  parseTocatsDensityResponse,
  TocatsViewportCache,
  formatTocatsPopup,
  getTocatsMarkerOptions,
  getTocatsSourceTitle,
  MAX_TOCATS_MARKERS,
  parseTocatsResponse,
  TOCATS_CATALOGS,
  TocatsCatalogClient,
  type TocatsCatalogId,
} from './tocats';

const gaiaPayload = {
  metadata: {
    source_id: { ucd: 'meta.id;meta.main', unit: '--' },
    ra: { ucd: 'pos.eq.ra;meta.main', unit: 'deg' },
    dec: { ucd: 'pos.eq.dec;meta.main', unit: 'deg' },
    pmra: { ucd: 'pos.pm;pos.eq.ra', unit: 'mas/yr' },
    pmdec: { ucd: 'pos.pm;pos.eq.dec', unit: 'mas/yr' },
    phot_g_mean_mag: { ucd: 'phot.mag;em.opt', unit: 'mag' },
    phot_bp_mean_mag: { ucd: 'phot.mag;em.opt.B', unit: 'mag' },
    phot_rp_mean_mag: { ucd: 'phot.mag;em.opt.R', unit: 'mag' },
    ruwe: { ucd: 'stat.error', unit: '--' },
  },
  data: {
    qry_meta: { status: 0, errmsg: '', n_objs_found: 1, n_objs: 1 },
    objs: [['1234567890123456789', 12.5, -3.25, 4.5, -2.25, 10.1, 10.7, 9.5, 1.02]],
  },
};

const catwisePayload = {
  metadata: {
    source_name: { ucd: 'meta.id;meta.main', label: 'Source designation' },
    ra: { ucd: 'pos.eq.ra;meta.main', unit: 'deg' },
    dec: { ucd: 'pos.eq.dec;meta.main', unit: 'deg' },
    PMRA: { ucd: 'pos.pm;pos.eq.ra', unit: 'asec/yr', label: 'pmRA' },
    PMDec: { ucd: 'pos.pm;pos.eq.dec', unit: 'asec/yr', label: 'pmDec' },
    w1mpro: { ucd: 'phot.mag;em.IR.3-4um', label: 'WPRO band-1' },
    w2mpro: { ucd: 'phot.mag;em.IR.4-8um', label: 'WPRO band-2' },
    w1mJDmean: { ucd: 'time.epoch;stat.mean', unit: 'days', label: 'MJDmean' },
  },
  data: {
    qry_meta: { status: 0, errmsg: '', n_objs_found: 1, n_objs: 1 },
    objs: [['J000500.00-031500.0', 1.25, -3.25, 0.012, -0.034, 12.3, 11.9, 56766.25]],
  },
};

function responseFor(id: TocatsCatalogId): Response {
  return new Response(JSON.stringify(id === 'gaia' ? gaiaPayload : catwisePayload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TOCats cone queries', () => {
  it('builds bounded API path queries using the provider catalogue names', () => {
    const region = { raDeg: 10.12349, decDeg: -20.12349, radiusDeg: 0.043 };

    expect(buildTocatsConeUrl('gaia', region)).toBe(
      'https://cats.oas.inaf.it/gaiadr3/radius=0.06&ra=10.123&dec=-20.123&limit=300&json',
    );
    expect(buildTocatsConeUrl('catwise', region)).toContain('/catwise_mini/');
  });

  it('decodes Gaia row arrays without confusing identifiers, units, or photometry', () => {
    const result = parseTocatsResponse(gaiaPayload, 'gaia');

    expect(result.found).toBe(1);
    expect(result.sources[0]).toMatchObject({
      id: '1234567890123456789',
      ra: 12.5,
      dec: -3.25,
      data: {
        source_id: '1234567890123456789',
        pmra: 4.5,
        pmdec: -2.25,
        phot_g_mean_mag: 10.1,
        phot_bp_mean_mag: 10.7,
        phot_rp_mean_mag: 9.5,
      },
    });
    expect(result.columns.pmra.unit).toBe('mas/yr');
    expect(formatTocatsPopup('gaia', result.sources[0], result.columns)).toContain('G mean magnitude');
  });

  it('keeps CatWISE identifiers, W1/W2 magnitudes, epochs, and proper-motion units distinct', () => {
    const result = parseTocatsResponse(catwisePayload, 'catwise');
    const source = result.sources[0];
    const popup = formatTocatsPopup('catwise', source, result.columns);

    expect(source.id).toBe('J000500.00-031500.0');
    expect(source.data.PMRA).toBe(0.012);
    expect(result.columns.PMRA.unit).toBe('asec/yr');
    expect(popup).toContain('W1 magnitude');
    expect(popup).toContain('W2 magnitude');
    expect(popup).toContain('W1 mean observation MJD');
    expect(popup).toContain('MJD 57170 (2015-05-28)');
    expect(popup).toContain('Coordinates (ICRS)');
    expect(popup).not.toContain('G mean magnitude');
  });

  it('escapes catalogue-controlled identifiers in selectable marker titles and popups', () => {
    const payload = {
      ...catwisePayload,
      data: {
        ...catwisePayload.data,
        objs: [['<img src=x onerror=alert(1)>', 1.25, -3.25, 0.012, -0.034, 12.3, 11.9, 56766.25]],
      },
    };
    const result = parseTocatsResponse(payload, 'catwise');
    const title = getTocatsSourceTitle('catwise', result.sources[0]);
    const popup = formatTocatsPopup('catwise', result.sources[0], result.columns);

    expect(title).toContain('&lt;img');
    expect(popup).not.toContain('<img');
    expect(popup).toContain('&lt;img');
  });

  it('reports TOCats application errors even when the HTTP response itself succeeded', () => {
    expect(() => parseTocatsResponse({ qry_meta: { status: -1, errmsg: 'Bad coordinates' } }, 'gaia'))
      .toThrow('Bad coordinates');
  });

  it('drops rows with invalid coordinates and caps renderable sources', () => {
    const manyRows = Array.from({ length: MAX_TOCATS_MARKERS + 2 }, (_, index) => [
      `source-${index}`,
      index === 0 ? Number.NaN : 12.5,
      -3.25,
      4.5,
      -2.25,
      10.1,
      10.7,
      9.5,
      1.02,
    ]);
    const result = parseTocatsResponse({
      ...gaiaPayload,
      data: {
        qry_meta: { status: 0, errmsg: '', n_objs_found: manyRows.length, n_objs: manyRows.length },
        objs: manyRows,
      },
    }, 'gaia');

    expect(result.sources).toHaveLength(MAX_TOCATS_MARKERS);
    expect(result.found).toBe(MAX_TOCATS_MARKERS + 2);
    expect(result.truncated).toBe(true);
  });

  it('caches the same normalized spatial query but keeps providers independent', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseFor('gaia'));
    const client = new TocatsCatalogClient({ fetcher });
    const first = { raDeg: 10.1234, decDeg: -20.1234, radiusDeg: 0.043 };
    const sameCell = { raDeg: 10.12349, decDeg: -20.12349, radiusDeg: 0.043 };

    await client.query('gaia', first);
    await client.query('gaia', sameCell);
    await client.query('catwise', first);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('calls the default fetcher with the global receiver', async () => {
    let receiver: unknown;
    const fetchMock = function (this: unknown): Promise<Response> {
      receiver = this;
      return Promise.resolve(responseFor('gaia'));
    };
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      await new TocatsCatalogClient().query('gaia', { raDeg: 10, decDeg: -20, radiusDeg: 0.04 });
      expect(receiver).toBe(globalThis);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not cache a response that became obsolete while in flight', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    let calls = 0;
    const fetcher = vi.fn(() => {
      calls += 1;
      if (calls === 1) return new Promise<Response>((resolve) => { resolveResponse = resolve; });
      return Promise.resolve(responseFor('gaia'));
    });
    const client = new TocatsCatalogClient({ fetcher });
    const controller = new AbortController();
    const pending = client.query('gaia', { raDeg: 10, decDeg: -20, radiusDeg: 0.04 }, controller.signal);
    controller.abort();
    resolveResponse?.(responseFor('gaia'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await client.query('gaia', { raDeg: 10, decDeg: -20, radiusDeg: 0.04 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('TOCats marker presentation', () => {
  it('uses catalog-colored shapes with a restrained but visible source size', () => {
    expect(TOCATS_CATALOGS.gaia.sourceSize).toBe(10);
    expect(TOCATS_CATALOGS.catwise.sourceSize).toBe(10);
  });

  it('disables Aladin’s generic marker icon without losing catalogue popups', () => {
    const result = parseTocatsResponse(gaiaPayload, 'gaia');
    const options = getTocatsMarkerOptions('gaia', result.sources[0], result.columns);

    expect(options.useMarkerDefaultIcon).toBe(false);
    expect(options.popupTitle).not.toBe('');
    expect(options.popupDesc).toContain('Coordinates (ICRS)');
  });
});

describe('TOCats progressive density', () => {
  const childPayload = {
    metadata: {
      healpID_nest_7: {}, Nobjs: {}, avgRAmas: {}, avgDECmas: {},
      RAmas: {}, DECmas: {}, phot_g_mean_mag: {},
    },
    data: {
      qry_meta: { status: 0, n_fields: 5, n_objs_found: 1145, n_objs: 2 },
      objs: [[1234, 824, 247.268609, -26.010841, 10.6653], [1235, 321, 247.35, -26.1, 11.2]],
    },
  };

  it('uses bounded HEALPix child tables at wide FOV and decodes their five aliases, not seven metadata columns', () => {
    expect(chooseTocatsDensityOrder(90)).toBe(3);
    expect(chooseTocatsDensityOrder(3.46)).toBe(7);
    expect(buildTocatsDensityUrl('gaia', { raDeg: 247.203, decDeg: -25.944, radiusDeg: 90 }, 3))
      .toContain('/gaiadr3_hips3/radius=90.01&ra=247.203&dec=-25.944&limit=500&json');
    const result = parseTocatsDensityResponse(childPayload, 'gaia', 7);
    expect(result.cells).toEqual([
      { id: 'gaia:7:1234', healpixId: 1234, order: 7, count: 824, ra: 247.268609, dec: -26.010841, magnitude: 10.6653 },
      { id: 'gaia:7:1235', healpixId: 1235, order: 7, count: 321, ra: 247.35, dec: -26.1, magnitude: 11.2 },
    ]);
    expect(result.totalSources).toBe(1145);
    expect(result.foundCells).toBe(2);
    expect(result.truncated).toBe(false);
    expect(formatTocatsDensityPopup('gaia', result.cells[0])).toContain('Representative Gaia G magnitude');
    expect(formatTocatsDensityPopup('catwise', result.cells[0])).toContain('Representative WISE W1 magnitude');
    expect(formatTocatsDensityPopup('gaia', result.cells[0])).toContain('not an individual source');
  });

  it('retains and deduplicates cells across nearby views while bounding cached records', () => {
    const cache = new TocatsViewportCache(3);
    const result = parseTocatsDensityResponse(childPayload, 'gaia', 7);
    const region = { raDeg: 247.2, decDeg: -26, radiusDeg: 3 };
    cache.mergeDensity(result);
    cache.recordDensityCoverage(region, 7);
    cache.mergeDensity(result);
    expect(cache.cells.size).toBe(2);
    expect(cache.hasDensityCoverage({ raDeg: 247.3, decDeg: -26, radiusDeg: 2.5 }, 7)).toBe(true);
    expect(cache.visibleCells(region, 7)).toHaveLength(2);
    expect(cache.visibleCells({ raDeg: 100, decDeg: 10, radiusDeg: 1 }, 7)).toHaveLength(0);
    expect(cache.cells.size).toBe(2); // a failed subsequent request must not clear existing data
  });

  it('keeps intersecting HEALPix tiles when the representative lies just outside a narrow cone', () => {
    const cache = new TocatsViewportCache();
    cache.mergeDensity({
      cells: [{ id: 'gaia:9:1', healpixId: 1, order: 9, count: 824, ra: 0.15, dec: 0, magnitude: 10 }],
      foundCells: 1, totalSources: 824, truncated: false, order: 9,
    });
    expect(cache.visibleCells({ raDeg: 0, decDeg: 0, radiusDeg: 0.1 }, 9)).toHaveLength(1);
  });

  it('queries the child table once for an identical region and keeps failed requests out of the cache', async () => {
    const payload = new Response(JSON.stringify(childPayload), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const fetcher = vi.fn().mockResolvedValueOnce(payload)
      .mockResolvedValueOnce(new Response('unavailable', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(childPayload), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    const client = new TocatsCatalogClient({ fetcher });
    const region = { raDeg: 247.203, decDeg: -25.944, radiusDeg: 3.46 };
    await client.queryDensity('gaia', region, 7);
    await client.queryDensity('gaia', region, 7);
    await expect(client.queryDensity('catwise', region, 7)).rejects.toThrow('HTTP 500');
    await client.queryDensity('catwise', region, 7);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0][0])).toContain('/gaiadr3_hips7/');
    expect(String(fetcher.mock.calls[1][0])).toContain('/catwise_mini_hips7/');
  });

  it('keeps source identities separate from density cells and caps source drill-down by estimated count', () => {
    const cache = new TocatsViewportCache();
    const region = { raDeg: 12.5, decDeg: -3.25, radiusDeg: 0.1 };
    const result = parseTocatsResponse(gaiaPayload, 'gaia');
    cache.mergeSources(result);
    cache.recordSourceCoverage(region);
    cache.mergeSources(result);
    expect(cache.sources.size).toBe(1);
    expect(cache.hasSourceCoverage({ raDeg: 12.51, decDeg: -3.25, radiusDeg: 0.08 })).toBe(true);
    expect(cache.visibleSources(region)).toHaveLength(1);
  });
});
