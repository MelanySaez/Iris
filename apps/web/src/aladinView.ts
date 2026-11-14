export type SurveyViewer = {
  newImageSurvey: (url: string) => unknown;
  setBaseImageLayer?: (survey: unknown) => void;
  setImageLayer?: (survey: unknown) => void;
};

export function setViewerSurvey(viewer: SurveyViewer, survey: unknown): void {
  const replaceBaseLayer = viewer.setBaseImageLayer ?? viewer.setImageLayer;
  if (!replaceBaseLayer) {
    throw new Error('Aladin viewer does not expose setBaseImageLayer or setImageLayer.');
  }
  replaceBaseLayer.call(viewer, survey);
}

export function createAndSetViewerSurvey(viewer: SurveyViewer, url: string): unknown {
  const survey = viewer.newImageSurvey(url);
  setViewerSurvey(viewer, survey);
  return survey;
}

/** Use Aladin's documented URL setter so each virtual HiPS channel is a new layer. */
export function setChannelImageLayer(viewer: SurveyViewer, url: string): void {
  if (!viewer.setImageLayer) throw new Error('Aladin URL image layer setter is unavailable.');
  viewer.setImageLayer(url);
}

/** Names of the two overlay layers that carry green and blue in an RGB composite. */
export const RGB_OVERLAY_NAMES = { g: 'spherex-rgb-green', b: 'spherex-rgb-blue' } as const;

export type RgbViewer = {
  newImageSurvey: (url: string, options?: Record<string, unknown>) => unknown;
  setBaseImageLayer?: (survey: unknown) => void;
  setImageLayer?: (survey: unknown) => void;
  setOverlayImageLayer?: (survey: unknown, name: string) => unknown;
  removeImageLayer?: (name: string) => void;
};

/**
 * Additive false-colour composite: R is the base layer with a red colormap,
 * G and B are overlays with green/blue colormaps blended additively.
 */
export function showRgbComposite(
  viewer: RgbViewer,
  urls: { r: string; g: string; b: string },
): void {
  const setBase = viewer.setBaseImageLayer ?? viewer.setImageLayer;
  if (!setBase || !viewer.setOverlayImageLayer) {
    throw new Error('Aladin viewer does not support overlay image layers for RGB.');
  }
  const red = viewer.newImageSurvey(urls.r, { colormap: 'red' });
  const green = viewer.newImageSurvey(urls.g, { colormap: 'green', additive: true });
  const blue = viewer.newImageSurvey(urls.b, { colormap: 'blue', additive: true });
  setBase.call(viewer, red);
  viewer.setOverlayImageLayer(green, RGB_OVERLAY_NAMES.g);
  viewer.setOverlayImageLayer(blue, RGB_OVERLAY_NAMES.b);
}

/** Remove the RGB overlays so a single-channel base layer shows on its own. */
export function clearRgbComposite(viewer: RgbViewer): void {
  if (!viewer.removeImageLayer) return;
  viewer.removeImageLayer(RGB_OVERLAY_NAMES.g);
  viewer.removeImageLayer(RGB_OVERLAY_NAMES.b);
}
