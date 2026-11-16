import { describe, expect, it, vi } from 'vitest';
import { querySimbadCone } from '../../src/api/nearbyCatalogs';
import { simbadViewportCone } from '../../src/api/simbadViewport';

describe('simbadViewportCone', () => {
  it('covers the visible field with a cone around the centre', () => {
    const cone = simbadViewportCone([10.68, 41.27], 1, 0.6);
    expect(cone).not.toBeNull();
    expect(cone!.raDeg).toBeCloseTo(10.68);
    expect(cone!.decDeg).toBeCloseTo(41.27);
    // Half the field diagonal: sqrt(1² + 0.6²) / 2.
    expect(cone!.radiusDeg).toBeCloseTo(Math.hypot(1, 0.6) / 2, 5);
  });

  it('wraps the right ascension into 0–360°', () => {
    expect(simbadViewportCone([-5, 0], 0.5, 0.5)!.raDeg).toBeCloseTo(355);
  });

  it('also covers wide fields, up to the whole sky, without asking to zoom in', () => {
    expect(simbadViewportCone([0, 0], 40, 30)!.radiusDeg).toBeCloseTo(25);
    expect(simbadViewportCone([0, 0], 360, 180)!.radiusDeg).toBe(180);
  });

  it('rejects positions that are not on the sky', () => {
    expect(simbadViewportCone([Number.NaN, 0], 1, 1)).toBeNull();
    expect(simbadViewportCone([0, 95], 1, 1)).toBeNull();
  });
});

describe('querySimbadCone', () => {
  it('queries the Harvard SIMBAD mirror for a cone and parses the objects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      metadata: [{ name: 'main_id' }, { name: 'ra' }, { name: 'dec' }, { name: 'otype' }],
      data: [['M  31', 10.684708, 41.26875, 'AGN']],
    })));
    const sources = await querySimbadCone({ raDeg: 10.68, decDeg: 41.27, radiusDeg: 0.4 }, fetcher);
    const url = new URL(fetcher.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('https://simbad.cfa.harvard.edu/simbad/sim-tap/sync');
    expect(url.searchParams.get('QUERY')).toContain("CIRCLE('ICRS', 10.68, 41.27, 0.4)");
    // The 300 most-cited objects, so the markers spread over the view instead of
    // being whatever SIMBAD stores first (often one long list of a single field).
    expect(url.searchParams.get('QUERY')).toMatch(/ORDER BY nbref DESC$/);
    expect(sources).toEqual([
      expect.objectContaining({ id: 'M  31', raDeg: 10.684708, decDeg: 41.26875, data: expect.objectContaining({ otype: 'AGN' }) }),
    ]);
  });

  it('asks for the whole sky when the cone covers more than a hemisphere (the mirror rejects larger circles)', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ metadata: [{ name: 'main_id' }, { name: 'ra' }, { name: 'dec' }], data: [] })));
    await querySimbadCone({ raDeg: 0, decDeg: 0, radiusDeg: 120 }, fetcher);
    const query = new URL(fetcher.mock.calls[0][0] as string).searchParams.get('QUERY') ?? '';
    expect(query).not.toContain('CIRCLE');
    expect(query).toMatch(/^SELECT TOP 300 .* FROM basic ORDER BY nbref DESC$/);
  });

  it('reports an HTTP failure from the mirror', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));
    await expect(querySimbadCone({ raDeg: 1, decDeg: 1, radiusDeg: 0.1 }, fetcher)).rejects.toThrow(/HTTP 503/);
  });
});
