import { describe, expect, it } from 'vitest';
import {
  BLANK_CHANNELS,
  buildChannelList,
  channelToBand,
  channelToDetector,
  computeBandwidth,
  findNearestChannel,
  getChannelWindow,
  getNextAvailableChannel,
  isChannelAvailable,
  isInChannelWindow,
  TOTAL_CHANNELS,
} from '../../src/services/channels';

describe('channels module', () => {
  describe('Band and Detector mapping', () => {
    it('maps channel indices 0..101 to bands 1..6 and detectors D1..D6', () => {
      // Band 1 (D1): indices 0..16
      expect(channelToBand(0)).toBe(1);
      expect(channelToDetector(0)).toBe('D1');
      expect(channelToBand(16)).toBe(1);
      expect(channelToDetector(16)).toBe('D1');

      // Band 2 (D2): indices 17..33
      expect(channelToBand(17)).toBe(2);
      expect(channelToDetector(17)).toBe('D2');
      expect(channelToBand(33)).toBe(2);
      expect(channelToDetector(33)).toBe('D2');

      // Band 3 (D3): indices 34..50 (channel 44 is standard DR1 default)
      expect(channelToBand(44)).toBe(3);
      expect(channelToDetector(44)).toBe('D3');

      // Band 4 (D4): indices 51..67
      expect(channelToBand(52)).toBe(4);
      expect(channelToDetector(52)).toBe('D4');
      expect(channelToBand(62)).toBe(4);
      expect(channelToDetector(62)).toBe('D4');

      // Band 5 (D5): indices 68..84
      expect(channelToBand(68)).toBe(5);
      expect(channelToDetector(68)).toBe('D5');

      // Band 6 (D6): indices 85..101
      expect(channelToBand(85)).toBe(6);
      expect(channelToDetector(85)).toBe('D6');
      expect(channelToBand(101)).toBe(6);
      expect(channelToDetector(101)).toBe('D6');
    });

    it('throws RangeError for out of bound channel index', () => {
      expect(() => channelToBand(-1)).toThrow(RangeError);
      expect(() => channelToBand(102)).toThrow(RangeError);
    });
  });

  describe('Blank channels handling', () => {
    it('identifies channels 50 and 51 as blanks and unavailable', () => {
      expect(BLANK_CHANNELS.has(50)).toBe(true);
      expect(BLANK_CHANNELS.has(51)).toBe(true);
      expect(isChannelAvailable(50)).toBe(false);
      expect(isChannelAvailable(51)).toBe(false);

      expect(isChannelAvailable(49)).toBe(true);
      expect(isChannelAvailable(52)).toBe(true);
    });

    it('skips over blank channels 50 and 51 when stepping forward', () => {
      expect(getNextAvailableChannel(49, 1)).toBe(52);
    });

    it('skips over blank channels 50 and 51 when stepping backward', () => {
      expect(getNextAvailableChannel(52, -1)).toBe(49);
    });
  });

  describe('Channel bandwidth and window math', () => {
    const fixtureWavelengths = [1.0, 1.1, 1.25, 1.45, 1.7];

    it('computes edge bandwidths using one-sided differences', () => {
      expect(computeBandwidth(0, fixtureWavelengths)).toBeCloseTo(0.1);
      expect(computeBandwidth(4, fixtureWavelengths)).toBeCloseTo(0.25);
    });

    it('computes interior bandwidths using central differences', () => {
      // index 1: (w[2] - w[0]) / 2 = (1.25 - 1.0) / 2 = 0.125
      expect(computeBandwidth(1, fixtureWavelengths)).toBeCloseTo(0.125);
      // index 2: (w[3] - w[1]) / 2 = (1.45 - 1.1) / 2 = 0.175
      expect(computeBandwidth(2, fixtureWavelengths)).toBeCloseTo(0.175);
    });

    it('computes channel window bounds around center wavelength', () => {
      const window = getChannelWindow(2.089, 0.046);
      expect(window[0]).toBeCloseTo(2.089 - 0.023);
      expect(window[1]).toBeCloseTo(2.089 + 0.023);
    });

    it('correctly determines whether a pixel wavelength falls in the channel window', () => {
      const center = 2.089;
      const bandwidth = 0.046; // half width = 0.023 -> window [2.066, 2.112]

      expect(isInChannelWindow(2.089, center, bandwidth)).toBe(true);
      expect(isInChannelWindow(2.070, center, bandwidth)).toBe(true);
      expect(isInChannelWindow(2.110, center, bandwidth)).toBe(true);
      expect(isInChannelWindow(2.050, center, bandwidth)).toBe(false);
      expect(isInChannelWindow(2.130, center, bandwidth)).toBe(false);
    });
  });

  describe('findNearestChannel', () => {
    const testChannels = [
      { index: 0, wavelength_um: 0.75, available: true },
      { index: 44, wavelength_um: 2.089, available: true },
      { index: 50, wavelength_um: 2.30, available: false }, // blank
      { index: 51, wavelength_um: 2.34, available: false }, // blank
      { index: 62, wavelength_um: 3.293, available: true },
    ];

    it('finds the closest available channel index', () => {
      expect(findNearestChannel(testChannels, 2.05)).toBe(44);
      expect(findNearestChannel(testChannels, 0.8)).toBe(0);
      expect(findNearestChannel(testChannels, 3.2)).toBe(62);
    });

    it('never selects blank channels 50 or 51 even if closer', () => {
      // 2.31 is closer to 50/51, but should find closest available (44)
      expect(findNearestChannel(testChannels, 2.31)).toBe(44);
    });

    it('returns null for empty channel list', () => {
      expect(findNearestChannel([], 2.0)).toBeNull();
    });
  });

  describe('buildChannelList', () => {
    it('creates full 102 channel list with proper flags', () => {
      const waves = Array.from({ length: TOTAL_CHANNELS }, (_, i) => 0.75 + i * 0.04);
      const list = buildChannelList(waves);

      expect(list).toHaveLength(102);
      expect(list[0].index).toBe(0);
      expect(list[0].detector).toBe('D1');
      expect(list[50].available).toBe(false);
      expect(list[51].available).toBe(false);
      expect(list[44].available).toBe(true);
      expect(list[44].detector).toBe('D3');
    });
  });
});
