import { describe, expect, it } from 'vitest';
import type { JobSnapshot } from '../../types/types';
import { channelCutoutLoaded, uploadChannelUnavailable } from './plateChannels';

const job = (cutouts: Array<{ detector: number; channel?: number }>, upload: JobSnapshot['upload'] = null) =>
  ({ cutouts, upload } as unknown as JobSnapshot);

describe('plate channel availability', () => {
  it('treats a detector cutout as covering all of its channels', () => {
    const level2 = job([{ detector: 3 }]);
    expect(channelCutoutLoaded(level2, 40)).toBe(true); // D3
    expect(channelCutoutLoaded(level2, 10)).toBe(false); // D1
  });

  it('requires the exact channel for per-channel cutouts (cube results)', () => {
    const cube = job([{ detector: 3, channel: 44 }]);
    expect(channelCutoutLoaded(cube, 44)).toBe(true);
    expect(channelCutoutLoaded(cube, 45)).toBe(false); // same detector, other plane
  });

  it('explains when an uploaded file does not cover a channel instead of querying Sky', () => {
    const upload = job([{ detector: 3 }], {
      filename: 'mine.fits', format: 'spherex_l2', detector: 3, extent_arcmin: 210, temporal_available: false,
    });
    expect(uploadChannelUnavailable(upload, 40)).toBeNull();
    expect(uploadChannelUnavailable(upload, 10)).toBe(
      'mine.fits is a detector D3 image: channel 10 belongs to detector D1. Load a D1 file or select the region in Sky.',
    );
    expect(uploadChannelUnavailable(job([{ detector: 3 }]), 10)).toBeNull(); // not an upload
  });
});
