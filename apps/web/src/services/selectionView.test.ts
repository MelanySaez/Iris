import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadSelectionView,
  parseSelectionView,
  regionKey,
  resolveSelectionView,
  saveSelectionView,
  serializeSelectionView,
  type SelectionView,
} from './selectionView';

const view: SelectionView = {
  region: { ra_deg: 270.69303, dec_deg: 61.87652, size_arcmin: 6 },
  center: [270.7, 61.9],
  fov_deg: 0.35,
  projection: 'AIT',
  channel: 44,
  rgb: { r: 16, g: 32, b: 46 },
};

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe('selectionView', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('keys a region at the precision the database stores it', () => {
    expect(regionKey({ ra_deg: 270.693031, dec_deg: -0.000001, size_arcmin: 6 })).toBe(
      '270.69303,0.00000,6.000',
    );
  });

  it('normalises and rounds exactly like the server (RA mod 360, half-even)', () => {
    expect(regionKey({ ra_deg: -10, dec_deg: 0.000005, size_arcmin: 6.0005 })).toBe('350.00000,0.00000,6.000');
    expect(regionKey({ ra_deg: 360, dec_deg: 0.000015, size_arcmin: 6.0015 })).toBe('0.00000,0.00002,6.002');
    expect(regionKey({ ra_deg: 359.999996, dec_deg: -45.123456, size_arcmin: 60 })).toBe('0.00000,-45.12346,60.000');
    // An in-range RA must not pass through float arithmetic before rounding (tie stays a tie).
    expect(regionKey({ ra_deg: 348.539155, dec_deg: 0, size_arcmin: 6 })).toBe('348.53916,0.00000,6.000');
  });

  it('serializes the view as plain key=value text and parses it back', () => {
    const text = serializeSelectionView(view);
    expect(text).toContain('projection=AIT\n');
    expect(text).toContain('rgb=16,32,46');
    expect(parseSelectionView(text)).toEqual(view);
  });

  it('round-trips a single-channel view', () => {
    const single = { ...view, rgb: null };
    expect(serializeSelectionView(single)).toContain('rgb=off');
    expect(parseSelectionView(serializeSelectionView(single))).toEqual(single);
  });

  it('rejects text that is not a complete, valid view', () => {
    expect(parseSelectionView('')).toBeNull();
    expect(parseSelectionView('garbage')).toBeNull();
    expect(parseSelectionView(serializeSelectionView(view).replace('fov=0.35', 'fov=abc'))).toBeNull();
    expect(parseSelectionView(serializeSelectionView(view).replace(/region=[^\n]*/, 'region=1,95,6'))).toBeNull();
  });

  it('restores the saved view from the cache', () => {
    saveSelectionView(view, storage);
    const restored = resolveSelectionView(
      { ra_deg: 270.69303, dec_deg: 61.87652, size_arcmin: 6 },
      storage,
    );
    expect(restored).toEqual({ view, source: 'cache' });
  });

  it('rebuilds the selection from its coordinates when nothing is cached', () => {
    const region = { ra_deg: 10, dec_deg: -20, size_arcmin: 12 };
    expect(resolveSelectionView(region, storage)).toEqual({
      view: { region, center: [10, -20], fov_deg: 0.4, projection: null, channel: null, rgb: null },
      source: 'coordinates',
    });
  });

  it('falls back to the coordinates when the cached text is corrupt', () => {
    saveSelectionView(view, storage);
    storage.data.set([...storage.data.keys()][0], 'broken');
    expect(resolveSelectionView(view.region, storage).source).toBe('coordinates');
  });

  it('falls back to the coordinates when storage is unavailable', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => saveSelectionView(view, throwing)).not.toThrow();
    expect(loadSelectionView(view.region, throwing)).toBeNull();
    expect(resolveSelectionView(view.region, throwing).source).toBe('coordinates');
  });
});
