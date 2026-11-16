import type { JobSnapshot } from '../../types/types';
import { channelToBand } from '../../services/channels';

/**
 * Whether the plate already holds a cutout for this channel. Level-2 cutouts
 * cover all channels of their detector; cube cutouts (fallback or uploaded
 * tiles) are per channel, so only the exact channel counts.
 */
export function cutoutsForChannel(job: JobSnapshot, channel: number) {
  const detector = channelToBand(channel);
  return (job.cutouts ?? []).filter(
    (c) => c.detector === detector && (c.channel == null || c.channel === channel),
  );
}

export function channelCutoutLoaded(job: JobSnapshot, channel: number): boolean {
  return cutoutsForChannel(job, channel).length > 0;
}

/**
 * Reason an uploaded FITS cannot show a channel, or null when it can (or the
 * plate is not an upload). Uploads never start a Sky job for another channel.
 */
export function uploadChannelUnavailable(job: JobSnapshot, channel: number): string | null {
  if (!job.upload || channelCutoutLoaded(job, channel)) return null;
  const detector = channelToBand(channel);
  if (job.upload.format === 'spherex_l2' && job.upload.detector) {
    return `${job.upload.filename} is a detector D${job.upload.detector} image: channel ${channel} belongs to detector D${detector}. Load a D${detector} file or select the region in Sky.`;
  }
  return `${job.upload.filename} has no data for channel ${channel}.`;
}
