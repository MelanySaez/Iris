// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RGB_OVERLAY_NAMES } from '../api/aladinView';
import { channelVirtualHipsUrl, type SpectralChannel } from '../api/hips';
import { RGB_PRESETS, presetChannels } from '../services/rgb';
import { NO_SINGLE_CHANNEL, useRgbComposite } from './useRgbComposite';

const channels: SpectralChannel[] = Array.from({ length: 102 }, (_, index) => ({
  index,
  wavelengthMicrometres: Number((0.75 + index * 0.0425).toFixed(4)),
})).filter((c) => c.index !== 50 && c.index !== 51);

function fakeViewer(withOverlays = true) {
  const viewer = {
    newImageSurvey: vi.fn((url: string, options?: Record<string, unknown>) => ({ url, options })),
    setBaseImageLayer: vi.fn(),
    setImageLayer: vi.fn(),
    setOverlayImageLayer: withOverlays ? vi.fn() : undefined,
    removeImageLayer: vi.fn(),
  };
  return viewer;
}

function setup(viewer: ReturnType<typeof fakeViewer> | null, currentChannel = 44) {
  const onStatus = vi.fn();
  const channelRef = { current: 7 };
  const hook = renderHook(() =>
    useRgbComposite({
      viewerRef: { current: viewer },
      ready: true,
      channels,
      currentChannel,
      channelRef,
      onStatus,
    }),
  );
  return { ...hook, onStatus, channelRef };
}

const stars = presetChannels(channels, RGB_PRESETS[0]);

describe('useRgbComposite', () => {
  it('turns RGB on with the first preset drawn as R base + G/B overlays', () => {
    const viewer = fakeViewer();
    const { result, onStatus, channelRef } = setup(viewer);
    act(() => result.current.setRgbMode(true));
    // Late single-channel tile telemetry must not overwrite the RGB status line.
    expect(channelRef.current).toBe(NO_SINGLE_CHANNEL);

    expect(result.current.rgbMode).toBe(true);
    expect(result.current.rgb).toEqual(stars);
    expect(result.current.rgbError).toBeNull();
    expect(viewer.setOverlayImageLayer).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith(
      `RGB composite: R ch ${stars.r} · G ch ${stars.g} · B ch ${stars.b}`,
    );
  });

  it('turns RGB on with the given channels instead of a preset', () => {
    const viewer = fakeViewer();
    const { result } = setup(viewer);
    const saved = { r: 16, g: 32, b: 46 };
    act(() => result.current.setRgbMode(true, saved));

    expect(result.current.rgbMode).toBe(true);
    expect(result.current.rgb).toEqual(saved);
    expect(viewer.newImageSurvey).toHaveBeenCalledWith(
      channelVirtualHipsUrl(16, location.origin),
      expect.objectContaining({ colormap: 'red' }),
    );
  });

  it('keeps showing the drawn channels when a selection is invalid', () => {
    const viewer = fakeViewer();
    const { result } = setup(viewer);
    act(() => result.current.setRgbMode(true));
    const drawnCalls = viewer.newImageSurvey.mock.calls.length;

    act(() => result.current.applyRgb({ ...stars, r: stars.g }));

    expect(result.current.rgb).toEqual(stars); // selects and info card match the map
    expect(result.current.rgbError).toBe('Pick three different channels for R, G and B.');
    expect(viewer.newImageSurvey.mock.calls.length).toBe(drawnCalls); // nothing redrawn
  });

  it('clears a previous error once a valid selection is drawn', () => {
    const { result } = setup(fakeViewer());
    act(() => result.current.setRgbMode(true));
    act(() => result.current.applyRgb({ ...stars, r: stars.g }));
    const next = { ...stars, r: 62 };
    act(() => result.current.applyRgb(next));
    expect(result.current.rgb).toEqual(next);
    expect(result.current.rgbError).toBeNull();
  });

  it('back to single channel removes the overlays and restores the grey channel layer', () => {
    const viewer = fakeViewer();
    const { result, channelRef, onStatus } = setup(viewer, 44);
    act(() => result.current.setRgbMode(true));
    act(() => result.current.setRgbMode(false));

    expect(result.current.rgbMode).toBe(false);
    expect(viewer.removeImageLayer.mock.calls).toEqual([[RGB_OVERLAY_NAMES.g], [RGB_OVERLAY_NAMES.b]]);
    expect(viewer.setImageLayer).toHaveBeenLastCalledWith(channelVirtualHipsUrl(44, location.origin));
    expect(channelRef.current).toBe(44);
    expect(onStatus).toHaveBeenLastCalledWith('Loading channel 44 tiles');
  });

  it('stays in single-channel mode when the viewer cannot overlay layers', () => {
    const viewer = fakeViewer(false);
    const { result } = setup(viewer);
    act(() => result.current.setRgbMode(true));

    expect(result.current.rgbMode).toBe(false);
    expect(result.current.rgb).toBeNull();
    expect(result.current.rgbError).toMatch(/overlay/);
    expect(viewer.setBaseImageLayer).not.toHaveBeenCalled();
  });
});
