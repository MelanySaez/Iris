/** Backend region limits (MIN/MAX_REGION_SIZE_ARCMIN), in arcmin. */
const MIN_REGION_ARCMIN = 6;
const MAX_REGION_ARCMIN = 60;
/** Field of view around a resolved object, in degrees. */
const MIN_FOV_DEG = 0.25;
const MAX_FOV_DEG = 60;
/** Point sources (stars) have no size in SIMBAD. */
const POINT_SOURCE_FOV_DEG = 0.5;
/** The view shows the object plus some surroundings. */
const FRAME_MARGIN = 1.5;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * How to frame an object found by name: a field of view that shows all of it
 * (1.5× its major axis) and a selection region matching its size, within the
 * limits the backend accepts. Point sources get a fixed, modest view.
 */
export function lookupView(sizeArcmin: number | null | undefined): {
  fovDeg: number;
  regionArcmin: number;
} {
  if (sizeArcmin === null || sizeArcmin === undefined || !(sizeArcmin > 0)) {
    return { fovDeg: POINT_SOURCE_FOV_DEG, regionArcmin: MIN_REGION_ARCMIN };
  }
  const fovDeg = clamp((sizeArcmin * FRAME_MARGIN) / 60, MIN_FOV_DEG, MAX_FOV_DEG);
  return {
    fovDeg: Math.round(fovDeg * 100) / 100,
    regionArcmin: Math.round(clamp(sizeArcmin, MIN_REGION_ARCMIN, MAX_REGION_ARCMIN)),
  };
}
