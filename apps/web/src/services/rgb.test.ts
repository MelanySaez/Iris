import { describe, expect, it, vi } from 'vitest';
import { clearRgbComposite, RGB_OVERLAY_NAMES, showRgbComposite } from '../api/aladinView';
import type { SpectralChannel } from '../api/hips';
import { RGB_PRESETS, nearestAvailableChannel, presetChannels, validateRgb } from './rgb';

// Wavelength grid like the DR1 cube: 0.75 µm + 0.05 µm steps, channels 50/51 blank.
const channels: SpectralChannel[] = Array.from({ length: 102 }, (_, index) => ({
  index,
  wavelengthMicrometres: Number((0.75 + index * 0.0425).toFixed(4)),
})).filter((c) => c.index !== 50 && c.index !== 51);

describe('nearestAvailableChannel', () => {
  it('picks the channel whose wavelength is closest', () => {
    expect(nearestAvailableChannel(channels, 0.75)).toBe(0);
    expect(nearestAvailableChannel(channels, 0.75 + 10 * 0.0425 + 0.01)).toBe(10);
  });

  it('never returns a blank channel', () => {
    const blank50 = 0.75 + 50 * 0.0425;
    expect([50, 51]).not.toContain(nearestAvailableChannel(channels, blank50));
  });
});

describe('RGB presets', () => {
  it('order each preset from short (blue) to long (red) wavelengths', () => {
    for (const preset of RGB_PRESETS) {
      expect(preset.microns.b).toBeLessThan(preset.microns.g);
      expect(preset.microns.g).toBeLessThan(preset.microns.r);
    }
  });

  it('resolve to three distinct available channels', () => {
    for (const preset of RGB_PRESETS) {
      const rgb = presetChannels(channels, preset);
      expect(validateRgb(rgb)).toBeNull();
    }
  });
});

describe('validateRgb', () => {
  it('accepts three distinct available channels', () => {
    expect(validateRgb({ r: 60, g: 30, b: 5 })).toBeNull();
  });

  it('rejects repeated channels', () => {
    expect(validateRgb({ r: 30, g: 30, b: 5 })).toBe('Pick three different channels for R, G and B.');
  });

  it('rejects blank or out-of-range channels', () => {
    expect(validateRgb({ r: 50, g: 30, b: 5 })).toBe('Channel 50 has no data; pick another one.');
    expect(validateRgb({ r: 102, g: 30, b: 5 })).toBe('Channel 102 has no data; pick another one.');
  });
});

function fakeViewer() {
  const surveys: { url: string; options?: Record<string, unknown> }[] = [];
  return {
    surveys,
    newImageSurvey: vi.fn((url: string, options?: Record<string, unknown>) => {
      const survey = { url, options };
      surveys.push(survey);
      return survey;
    }),
    setBaseImageLayer: vi.fn(),
    setImageLayer: vi.fn(),
    setOverlayImageLayer: vi.fn(),
    removeImageLayer: vi.fn(),
  };
}

describe('showRgbComposite', () => {
  it('paints R as the base layer and adds G and B as additive overlays', () => {
    const viewer = fakeViewer();
    showRgbComposite(viewer, { r: '/c/60', g: '/c/30', b: '/c/5' });

    expect(viewer.surveys).toEqual([
      { url: '/c/60', options: { colormap: 'red' } },
      { url: '/c/30', options: { colormap: 'green', additive: true } },
      { url: '/c/5', options: { colormap: 'blue', additive: true } },
    ]);
    expect(viewer.setBaseImageLayer).toHaveBeenCalledWith(viewer.surveys[0]);
    expect(viewer.setOverlayImageLayer).toHaveBeenCalledWith(viewer.surveys[1], RGB_OVERLAY_NAMES.g);
    expect(viewer.setOverlayImageLayer).toHaveBeenCalledWith(viewer.surveys[2], RGB_OVERLAY_NAMES.b);
  });

  it('refuses viewers without overlay support instead of half-drawing', () => {
    const viewer = { newImageSurvey: vi.fn(), setBaseImageLayer: vi.fn() };
    expect(() => showRgbComposite(viewer, { r: '/c/60', g: '/c/30', b: '/c/5' })).toThrow(/overlay/);
    expect(viewer.newImageSurvey).not.toHaveBeenCalled();
  });
});

describe('clearRgbComposite', () => {
  it('removes both colour overlays', () => {
    const viewer = fakeViewer();
    clearRgbComposite(viewer);
    expect(viewer.removeImageLayer.mock.calls).toEqual([[RGB_OVERLAY_NAMES.g], [RGB_OVERLAY_NAMES.b]]);
  });

  it('is a no-op on viewers that cannot remove layers', () => {
    expect(() => clearRgbComposite({ newImageSurvey: vi.fn() })).not.toThrow();
  });
});
