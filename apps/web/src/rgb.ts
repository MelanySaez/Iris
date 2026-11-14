import { isChannelAvailable } from './channels';
import type { SpectralChannel } from './hips';

/** Channel index painted in each colour of the composite. */
export type RgbChannels = { r: number; g: number; b: number };

export interface RgbPreset {
  id: string;
  label: string;
  description: string;
  /** Target wavelengths; blue is the shortest, red the longest. */
  microns: { r: number; g: number; b: number };
}

/**
 * Starting points for the band selector. Each one maps three infrared
 * wavelengths to visible colours (false colour), shortest → blue.
 */
export const RGB_PRESETS: RgbPreset[] = [
  {
    id: 'stars',
    label: 'Stars',
    description: 'J, H and K-like bands (1.1 / 1.6 / 2.2 µm): starlight dominates.',
    microns: { b: 1.1, g: 1.6, r: 2.2 },
  },
  {
    id: 'pah',
    label: 'Organic dust',
    description: '3.3 µm PAH feature in red against 1.6 / 2.2 µm starlight.',
    microns: { b: 1.6, g: 2.2, r: 3.3 },
  },
  {
    id: 'full',
    label: 'Full range',
    description: 'Spread across the whole SPHEREx range (0.9 / 2.6 / 4.6 µm).',
    microns: { b: 0.9, g: 2.6, r: 4.6 },
  },
];

/** Index of the available channel whose wavelength is closest to `microns`. */
export function nearestAvailableChannel(channels: SpectralChannel[], microns: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (const channel of channels) {
    if (!isChannelAvailable(channel.index)) continue;
    const distance = Math.abs(channel.wavelengthMicrometres - microns);
    if (distance < bestDistance) {
      best = channel.index;
      bestDistance = distance;
    }
  }
  return best;
}

export function presetChannels(channels: SpectralChannel[], preset: RgbPreset): RgbChannels {
  return {
    r: nearestAvailableChannel(channels, preset.microns.r),
    g: nearestAvailableChannel(channels, preset.microns.g),
    b: nearestAvailableChannel(channels, preset.microns.b),
  };
}

/** Null when the three channels can be composed, otherwise a message for the user. */
export function validateRgb(rgb: RgbChannels): string | null {
  for (const index of [rgb.r, rgb.g, rgb.b]) {
    if (!isChannelAvailable(index)) return `Channel ${index} has no data; pick another one.`;
  }
  if (new Set([rgb.r, rgb.g, rgb.b]).size < 3) {
    return 'Pick three different channels for R, G and B.';
  }
  return null;
}
