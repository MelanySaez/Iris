import type { ChannelInfo } from './types';

export const TOTAL_CHANNELS = 102;
export const BLANK_CHANNELS = new Set<number>([50, 51]);
export const DEFAULT_CHANNEL_INDEX = 44; // Default DR1 channel

export function isChannelAvailable(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < TOTAL_CHANNELS && !BLANK_CHANNELS.has(index);
}

export function channelToBand(index: number): number {
  if (index < 0 || index >= TOTAL_CHANNELS) {
    throw new RangeError(`Channel index ${index} out of bounds [0, ${TOTAL_CHANNELS - 1}]`);
  }
  return Math.floor(index / 17) + 1;
}

export function channelToDetector(index: number): string {
  return `D${channelToBand(index)}`;
}

export function computeBandwidth(
  index: number,
  wavelengths: number[],
): number {
  if (wavelengths.length < 2) return 0.02;
  if (index === 0) {
    return Math.abs(wavelengths[1] - wavelengths[0]);
  }
  if (index === wavelengths.length - 1) {
    return Math.abs(wavelengths[wavelengths.length - 1] - wavelengths[wavelengths.length - 2]);
  }
  return Math.abs(wavelengths[index + 1] - wavelengths[index - 1]) / 2;
}

export function getChannelWindow(
  wavelengthUm: number,
  bandwidthUm: number,
): [number, number] {
  const half = bandwidthUm / 2;
  return [wavelengthUm - half, wavelengthUm + half];
}

export function isInChannelWindow(
  pixelWavelengthUm: number,
  channelWavelengthUm: number,
  bandwidthUm: number,
): boolean {
  const half = bandwidthUm / 2;
  return Math.abs(pixelWavelengthUm - channelWavelengthUm) <= half + 1e-6;
}

export function getNextAvailableChannel(
  current: number,
  direction: 1 | -1,
): number {
  let next = current + direction;
  while (next >= 0 && next < TOTAL_CHANNELS) {
    if (isChannelAvailable(next)) return next;
    next += direction;
  }
  return current;
}

export function findNearestChannel(
  channels: Array<{ index: number; wavelength_um: number; available?: boolean }>,
  targetWavelengthUm: number,
): number | null {
  const available = channels.filter((c) => c.available !== false && !BLANK_CHANNELS.has(c.index));
  if (available.length === 0) return null;

  let best = available[0];
  let minDiff = Math.abs(best.wavelength_um - targetWavelengthUm);

  for (let i = 1; i < available.length; i++) {
    const diff = Math.abs(available[i].wavelength_um - targetWavelengthUm);
    if (diff < minDiff) {
      minDiff = diff;
      best = available[i];
    }
  }

  return best.index;
}

/**
 * Builds the standard 102 channel table from an array of 102 wavelengths.
 */
export function buildChannelList(wavelengths: number[]): ChannelInfo[] {
  return Array.from({ length: TOTAL_CHANNELS }, (_, index) => {
    const wave = wavelengths[index] ?? (0.75 + index * 0.0416);
    const bandwidth = computeBandwidth(index, wavelengths);
    const available = isChannelAvailable(index);
    return {
      index,
      band: channelToBand(index),
      detector: channelToDetector(index),
      wavelength_um: wave,
      bandwidth_um: bandwidth,
      available,
    };
  });
}

/**
 * Approximate fallback channel table used only before the authoritative
 * `/api/channels` (or HiPS properties) response arrives. Wavelengths are a
 * simple linear placeholder between 0.75 µm and 5.0 µm and must never be
 * presented as calibrated DR1 values.
 */
export const DEFAULT_CHANNELS: ChannelInfo[] = (() => {
  const waves = Array.from(
    { length: TOTAL_CHANNELS },
    (_, i) => 0.75 + (i / (TOTAL_CHANNELS - 1)) * (5.0 - 0.75),
  );
  return buildChannelList(waves);
})();
