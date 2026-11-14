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
