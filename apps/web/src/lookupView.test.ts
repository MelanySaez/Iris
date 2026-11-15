import { describe, expect, it } from 'vitest';
import { lookupView } from './lookupView';

describe('lookupView', () => {
  it('frames all of a large galaxy and caps the region at the 60′ backend limit', () => {
    // M31: 199.53′ × 70.79′ in SIMBAD
    expect(lookupView(199.53)).toEqual({ fovDeg: 4.99, regionArcmin: 60 });
  });

  it('sizes the view and region to a mid-size object', () => {
    // M81: 21.38′
    expect(lookupView(21.38)).toEqual({ fovDeg: 0.53, regionArcmin: 21 });
  });

  it('keeps a usable minimum for small objects', () => {
    // a 2′ galaxy: region at least 6′, view at least 0.25°
    expect(lookupView(2)).toEqual({ fovDeg: 0.25, regionArcmin: 6 });
  });

  it('uses a fixed view for point sources without a size', () => {
    expect(lookupView(null)).toEqual({ fovDeg: 0.5, regionArcmin: 6 });
    expect(lookupView(undefined)).toEqual({ fovDeg: 0.5, regionArcmin: 6 });
  });

  it('never exceeds the widest view', () => {
    expect(lookupView(10_000).fovDeg).toBe(60);
  });
});
