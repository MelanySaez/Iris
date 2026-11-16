// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const aladin = vi.hoisted(() => {
  const layer = { show: vi.fn(), hide: vi.fn(), addSources: vi.fn(), remove: vi.fn() };
  return {
    layer,
    catalog: vi.fn(() => layer),
    marker: vi.fn((ra: number, dec: number, options: Record<string, unknown>) => ({ ra, dec, ...options })),
  };
});
vi.mock('aladin-lite', () => ({ default: { catalog: aladin.catalog, marker: aladin.marker } }));
const query = vi.hoisted(() => vi.fn());
vi.mock('../api/nearbyCatalogs', () => ({ querySimbadCone: query, MAX_NEARBY_RESULTS: 300 }));

import { useSimbadViewportLayer } from './useSimbadViewportLayer';

function setup(overrides: Partial<Parameters<typeof useSimbadViewportLayer>[0]> = {}) {
  const viewer = { addCatalog: vi.fn() };
  const onStatus = vi.fn();
  const props = {
    visible: true,
    aladinReady: true,
    viewerRef: { current: viewer as never },
    centerCoords: [10.68, 41.27] as [number, number],
    fovWidth: 1,
    fovHeight: 0.6,
    onStatus,
    ...overrides,
  };
  const hook = renderHook((p: typeof props) => useSimbadViewportLayer(p), { initialProps: props });
  return { ...hook, props, viewer, onStatus };
}

describe('useSimbadViewportLayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('queries the visible field once the view settles and draws the objects', async () => {
    query.mockResolvedValue([
      { id: 'M  31', catalogId: 'simbad', catalogLabel: 'SIMBAD', raDeg: 10.684708, decDeg: 41.26875, data: { otype: 'AGN' } },
    ]);
    const { onStatus, viewer } = setup();
    expect(query).not.toHaveBeenCalled(); // debounced while the map moves
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ raDeg: 10.68, decDeg: 41.27 }),
      expect.anything(),
      expect.anything(),
    );
    expect(viewer.addCatalog).toHaveBeenCalledTimes(1);
    expect(aladin.layer.addSources).toHaveBeenCalledWith([
      expect.objectContaining({ ra: 10.684708, dec: 41.26875, popupTitle: 'M  31', popupDesc: 'AGN' }),
    ]);
    expect(onStatus).toHaveBeenLastCalledWith({ loading: false, message: '1 SIMBAD object in view (Harvard mirror).' });
  });

  it('skips SIMBAD objects already drawn as featured objects', async () => {
    query.mockResolvedValue([
      { id: "Barnard's Star", catalogId: 'simbad', catalogLabel: 'SIMBAD', raDeg: 269.45, decDeg: 4.69, data: {} },
    ]);
    const { onStatus } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(aladin.layer.addSources).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith({ loading: false, message: '0 SIMBAD objects in view (Harvard mirror).' });
  });

  it('loads the most-cited objects of a wide field too, and says that zooming shows more', async () => {
    query.mockResolvedValue(Array.from({ length: 300 }, (_, i) => (
      { id: `obj ${i}`, catalogId: 'simbad', catalogLabel: 'SIMBAD', raDeg: i, decDeg: 0, data: {} }
    )));
    const { onStatus } = setup({ fovWidth: 180, fovHeight: 180 });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(query).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith({
      loading: false,
      message: 'The 300 most-cited SIMBAD objects in view; zoom in for more (Harvard mirror).',
    });
  });

  it('reports the mirror being unreachable', async () => {
    query.mockRejectedValue(new Error('SIMBAD TAP returned HTTP 503.'));
    const { onStatus } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(onStatus).toHaveBeenLastCalledWith({
      loading: false,
      message: 'SIMBAD could not be reached (SIMBAD TAP returned HTTP 503.). Move the map to retry.',
    });
  });

  it('hides the layer and stops querying when turned off', async () => {
    query.mockResolvedValue([]);
    const { rerender, props } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    rerender({ ...props, visible: false, centerCoords: [20, 20] });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(aladin.layer.hide).toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
