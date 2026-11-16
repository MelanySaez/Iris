declare module 'aladin-lite' {
  export type AladinLayer = {
    show: () => void;
    hide: () => void;
  };

  export type AladinCatalog = AladinLayer & {
    addSources: (sources: unknown[]) => void;
    remove: (source: unknown) => void;
  };

  export type AladinSource = {
    ra?: number;
    dec?: number;
    data?: Record<string, unknown>;
  };

  export type AladinViewer = {
    getRaDec?: () => number[];
    getSize?: () => number[];
    getFoV?: () => number[];
    world2pix?: (ra: number, dec: number) => number[] | null;
    pix2world?: (x: number, y: number) => number[] | null;
    gotoRaDec?: (ra: number, dec: number) => void;
    setFoV?: (fov: number) => void;
    newImageSurvey: (url: string, options?: Record<string, unknown>) => Record<string, unknown>;
    setBaseImageLayer?: (layer: unknown) => void;
    setImageLayer?: (layer: unknown) => void;
    setOverlayImageLayer?: (layer: unknown, name: string) => unknown;
    removeImageLayer?: (name: string) => void;
    setProjection?: (projection: string) => void;
    hidePopup?: () => void;
    showPopup?: (ra: number, dec: number, title: string, description: string) => void;
    on?: (
      event: 'positionChanged' | 'resizeChanged' | 'rotationChanged' | 'projectionChanged' | 'zoomChanged',
      callback?: () => void,
    ) => void;
    addOverlay?: (overlay: unknown) => void;
    addCatalog: (catalog: AladinLayer) => void;
  };

  const A: {
    init: Promise<unknown>;
    aladin: (selector: string, options: Record<string, unknown>) => AladinViewer;
    catalog: (options: Record<string, unknown>) => AladinCatalog;
    catalogHiPS: (url: string, options: Record<string, unknown>) => AladinLayer;
    marker: (ra: number, dec: number, options: Record<string, unknown>) => unknown;
    graphicOverlay?: (options: Record<string, unknown>) => { addFootprints?: (items: unknown[]) => void };
    polygon?: (vertices: number[][]) => unknown;
  };

  export default A;
}
