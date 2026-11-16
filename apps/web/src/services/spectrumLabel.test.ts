import { describe, expect, it } from 'vitest';
import { spectrumLabel } from './spectrumLabel';

const m31 = { name: 'M 31', ra_deg: 10.684708, dec_deg: 41.26875 };

describe('spectrumLabel', () => {
  it('names the spectrum after the searched object while the centre is on it', () => {
    expect(spectrumLabel({ ra_deg: 10.684708, dec_deg: 41.26875 }, m31)).toBe('M 31');
  });

  it('keeps the name within one SPHEREx pixel (about 6 arcsec), e.g. after resizing', () => {
    // 5 arcsec north of the object.
    expect(spectrumLabel({ ra_deg: 10.684708, dec_deg: 41.26875 + 5 / 3600 }, m31)).toBe('M 31');
  });

  it('falls back to the position in degrees once the centre has moved off the object', () => {
    // 30 arcsec away.
    expect(spectrumLabel({ ra_deg: 10.684708, dec_deg: 41.26875 + 30 / 3600 }, m31)).toBe(
      '10.685°, 41.277°',
    );
  });

  it('uses the position in degrees when the region did not come from an object', () => {
    expect(spectrumLabel({ ra_deg: 270.69303, dec_deg: 61.87652 }, null)).toBe('270.693°, 61.877°');
  });

  it('measures the offset on the sky, so RA wraps around 0°/360°', () => {
    const nearZero = { name: 'Near zero', ra_deg: 359.9995, dec_deg: 0 };
    // 0.0010° apart across the wrap = 3.6 arcsec.
    expect(spectrumLabel({ ra_deg: 0.0005, dec_deg: 0 }, nearZero)).toBe('Near zero');
  });
});
