import { describe, expect, it } from 'vitest';
import { FEATURED_OBJECTS, isDuplicateRemoteSource } from '../../src/services/catalogs';

describe('featured object catalog', () => {
  it('contains the five requested objects with verified coordinates and provenance', () => {
    expect(FEATURED_OBJECTS.map((object) => object.id)).toEqual([
      'barnards-star',
      'wise-0855-0714',
      'epsilon-indi-b',
      'rw-aurigae',
      'r-draconis',
    ]);

    for (const object of FEATURED_OBJECTS) {
      expect(object.name).toBeTruthy();
      expect(object.type).toBeTruthy();
      expect(object.description).toBeTruthy();
      expect(object.coordinateFrame).toBe('ICRS');
      expect(object.referenceEpoch).toBe('J2000');
      expect(object.positionSource).toContain('SIMBAD');
      expect(object.positionSourceUrl).toMatch(/^https:\/\/simbad\./);
      expect(object.ra_deg).toBeGreaterThanOrEqual(0);
      expect(object.ra_deg).toBeLessThan(360);
      expect(object.dec_deg).toBeGreaterThanOrEqual(-90);
      expect(object.dec_deg).toBeLessThanOrEqual(90);
    }

    expect(FEATURED_OBJECTS[0].ra_deg).toBeCloseTo(269.45207696, 6);
    expect(FEATURED_OBJECTS[0].dec_deg).toBeCloseTo(4.69336497, 6);
    expect(FEATURED_OBJECTS[1].ra_deg).toBeCloseTo(133.81890825, 6);
    expect(FEATURED_OBJECTS[1].dec_deg).toBeCloseTo(-7.247048, 6);
  });
});

describe('remote catalog duplicate filtering', () => {
  it('does not suppress a distinct source based only on nearby coordinates', () => {
    const barnardsStar = FEATURED_OBJECTS[0];

    expect(isDuplicateRemoteSource({
      ra: barnardsStar.ra_deg,
      dec: barnardsStar.dec_deg + 1 / 3600,
      data: { main_id: 'distinct nearby source' },
    })).toBe(false);
  });

  it('filters a SIMBAD source only when its main identifier exactly matches a featured name', () => {
    const barnardsStar = FEATURED_OBJECTS[0];

    expect(isDuplicateRemoteSource({ data: { main_id: barnardsStar.name.toLowerCase() } })).toBe(true);
  });

  it('keeps coordinate-only sources and unknown SIMBAD identifiers', () => {
    const barnardsStar = FEATURED_OBJECTS[0];

    expect(isDuplicateRemoteSource({ data: { RA: barnardsStar.ra_deg, DEC: barnardsStar.dec_deg } })).toBe(false);
    expect(isDuplicateRemoteSource({ data: { main_id: 'uncatalogued row' } })).toBe(false);
  });
});
