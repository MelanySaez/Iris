/** SPHEREx pixel scale: a centre closer than this to an object samples that object. */
export const SPHEREX_PIXEL_ARCSEC = 6.2;

export interface SpectrumOrigin {
  /** Name of the object the region was created from (search, featured or recent). */
  name: string;
  ra_deg: number;
  dec_deg: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Angular separation in arcsec (haversine, so it holds near RA 0°/360° and the poles). */
function separationArcsec(a: { ra_deg: number; dec_deg: number }, b: { ra_deg: number; dec_deg: number }) {
  const dRa = toRad(b.ra_deg - a.ra_deg);
  const dDec = toRad(b.dec_deg - a.dec_deg);
  const h =
    Math.sin(dDec / 2) ** 2 + Math.cos(toRad(a.dec_deg)) * Math.cos(toRad(b.dec_deg)) * Math.sin(dRa / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h))) * 180 * 3600) / Math.PI;
}

/**
 * Name of the spectrum at a region's centre. The object's own name wins while
 * the centre still samples it (within one SPHEREx pixel); otherwise the label
 * is just the position in degrees.
 */
export function spectrumLabel(
  centre: { ra_deg: number; dec_deg: number },
  origin: SpectrumOrigin | null | undefined,
): string {
  if (origin && separationArcsec(centre, origin) <= SPHEREX_PIXEL_ARCSEC) return origin.name;
  return `${centre.ra_deg.toFixed(3)}°, ${centre.dec_deg.toFixed(3)}°`;
}
