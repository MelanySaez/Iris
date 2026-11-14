declare module 'aladin-lite' {
  export type AladinViewer = {
    getRaDec?: () => number[];
    getSize?: () => number[];
    getFoV?: () => number[];
    world2pix?: (ra: number, dec: number) => number[] | null;
    pix2world?: (x: number, y: number) => number[] | null;
    gotoRaDec?: (ra: number, dec: number) => void;
    setFoV?: (fov: number) => void;
    newImageSurvey: (url: string) => Record<string, unknown>;
    setBaseImageLayer?: (layer: unknown) => void;
    setImageLayer?: (layer: unknown) => void;
    setProjection?: (projection: string) => void;
    addOverlay?: (overlay: unknown) => void;
  };

  const A: {
    init: Promise<unknown>;
    aladin: (selector: string, options: Record<string, unknown>) => AladinViewer;
    graphicOverlay?: (options: Record<string, unknown>) => { addFootprints?: (items: unknown[]) => void };
    polygon?: (vertices: number[][]) => unknown;
  };

  export default A;
}
