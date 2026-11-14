import { describe, expect, it, vi } from 'vitest';
import { createAndSetViewerSurvey } from './aladinView';

describe('Aladin viewer survey methods', () => {
  it('creates the survey on the viewer instance and prefers setBaseImageLayer', () => {
    const survey = { id: 'channel-62' };
    const viewer = {
      newImageSurvey: vi.fn(() => survey),
      setBaseImageLayer: vi.fn(),
      setImageLayer: vi.fn(),
    };

    expect(createAndSetViewerSurvey(viewer, '/spherex-virtual-hips/channel/62')).toBe(survey);
    expect(viewer.newImageSurvey).toHaveBeenCalledWith('/spherex-virtual-hips/channel/62');
    expect(viewer.setBaseImageLayer).toHaveBeenCalledWith(survey);
    expect(viewer.setImageLayer).not.toHaveBeenCalled();
  });

  it('falls back to setImageLayer and rejects viewers with no supported layer setter', () => {
    const survey = { id: 'channel-0' };
    const fallbackViewer = {
      newImageSurvey: vi.fn(() => survey),
      setImageLayer: vi.fn(),
    };
    createAndSetViewerSurvey(fallbackViewer, '/spherex-virtual-hips/channel/0');
    expect(fallbackViewer.setImageLayer).toHaveBeenCalledWith(survey);

    expect(() => createAndSetViewerSurvey({ newImageSurvey: () => survey }, '/channel/0')).toThrow(/does not expose/);
  });

  it('switches the SPHEREx adapter survey without invoking native cube slicing', () => {
    const survey = { id: 'virtual-channel-62' };
    const viewer = {
      newImageSurvey: vi.fn(() => survey),
      setBaseImageLayer: vi.fn(),
      setSliceNumber: vi.fn(),
    };

    createAndSetViewerSurvey(viewer, '/spherex-virtual-hips/channel/62');

    expect(viewer.newImageSurvey).toHaveBeenCalledWith('/spherex-virtual-hips/channel/62');
    expect(viewer.setBaseImageLayer).toHaveBeenCalledWith(survey);
    expect(viewer.setSliceNumber).not.toHaveBeenCalled();
  });
});

describe('documented URL image layer switching', () => {
  it('passes each distinct channel URL to Aladin instead of reusing one survey object', async () => {
    const { setChannelImageLayer } = await import('./aladinView');
    const viewer = { newImageSurvey: vi.fn(), setImageLayer: vi.fn() };
    setChannelImageLayer(viewer, '/spherex-virtual-hips/channel/0');
    setChannelImageLayer(viewer, '/spherex-virtual-hips/channel/62');
    expect(viewer.setImageLayer.mock.calls).toEqual([
      ['/spherex-virtual-hips/channel/0'],
      ['/spherex-virtual-hips/channel/62'],
    ]);
    expect(viewer.newImageSurvey).not.toHaveBeenCalled();
  });
});
