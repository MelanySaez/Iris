import { useCallback, useState, type MutableRefObject } from 'react';
import {
  clearRgbComposite,
  setChannelImageLayer,
  showRgbComposite,
  type RgbViewer,
} from '../aladinView';
import { channelVirtualHipsUrl, type SpectralChannel } from '../hips';
import { RGB_PRESETS, presetChannels, validateRgb, type RgbChannels } from '../rgb';

interface UseRgbCompositeOptions {
  viewerRef: { current: RgbViewer | null };
  ready: boolean;
  channels: SpectralChannel[];
  /** Channel the single-channel view returns to. */
  currentChannel: number;
  /** Tracks the single channel whose tile telemetry the Sky view reports. */
  channelRef: MutableRefObject<number> | { current: number };
  onStatus: (message: string) => void;
}

/**
 * `channelRef` value while RGB is on: no single channel is shown, so tile
 * telemetry for any one channel must not overwrite the RGB status line.
 */
export const NO_SINGLE_CHANNEL = -1;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * RGB composite state for the Sky map. `rgb` is always the composite that is
 * actually drawn: an invalid selection or a viewer failure only sets `rgbError`,
 * so the selects and info card never describe channels that are not on screen.
 */
export function useRgbComposite({
  viewerRef,
  ready,
  channels,
  currentChannel,
  channelRef,
  onStatus,
}: UseRgbCompositeOptions) {
  const [rgbMode, setRgbModeState] = useState(false);
  const [rgb, setRgb] = useState<RgbChannels | null>(null);
  const [rgbError, setRgbError] = useState<string | null>(null);

  /** Draw `next`; returns whether it is now on screen. */
  const applyRgb = useCallback(
    (next: RgbChannels): boolean => {
      const problem = validateRgb(next);
      if (problem) {
        setRgbError(problem);
        return false;
      }
      const viewer = viewerRef.current;
      if (!viewer || !ready) return false;
      try {
        showRgbComposite(viewer, {
          r: channelVirtualHipsUrl(next.r, location.origin),
          g: channelVirtualHipsUrl(next.g, location.origin),
          b: channelVirtualHipsUrl(next.b, location.origin),
        });
      } catch (err) {
        setRgbError(message(err));
        return false;
      }
      setRgb(next);
      setRgbError(null);
      channelRef.current = NO_SINGLE_CHANNEL;
      onStatus(`RGB composite: R ch ${next.r} · G ch ${next.g} · B ch ${next.b}`);
      return true;
    },
    [viewerRef, ready, channelRef, onStatus],
  );

  const setRgbMode = useCallback(
    (enabled: boolean) => {
      const viewer = viewerRef.current;
      if (!viewer || !ready) return;
      if (enabled) {
        setRgbModeState(applyRgb(rgb ?? presetChannels(channels, RGB_PRESETS[0])));
        return;
      }
      // Back to the single channel: drop the overlays, restore the grey base layer.
      setRgbModeState(false);
      setRgbError(null);
      try {
        clearRgbComposite(viewer);
        channelRef.current = currentChannel;
        setChannelImageLayer(viewer, channelVirtualHipsUrl(currentChannel, location.origin));
        onStatus(`Loading channel ${currentChannel} tiles`);
      } catch (err) {
        onStatus(`Channel ${currentChannel} could not load: ${message(err)}`);
      }
    },
    [viewerRef, ready, applyRgb, rgb, channels, channelRef, currentChannel, onStatus],
  );

  return { rgbMode, rgb, rgbError, applyRgb, setRgbMode };
}
