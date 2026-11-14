/**
 * Formatting utilities for coordinates, wavelengths, angles, and dates.
 */

export function formatRa(degrees: number): string {
  if (!Number.isFinite(degrees)) return '—';
  // Normalize RA to [0, 360)
  let normalized = degrees % 360;
  if (normalized < 0) normalized += 360;
  return `${normalized.toFixed(5)}°`;
}

export function formatDec(degrees: number): string {
  if (!Number.isFinite(degrees)) return '—';
  const sign = degrees >= 0 ? '+' : '';
  return `${sign}${degrees.toFixed(5)}°`;
}

export function formatRaDec(ra: number, dec: number): string {
  return `${formatRa(ra)}, ${formatDec(dec)}`;
}

export function formatWavelength(micrometres: number | null | undefined): string {
  if (micrometres == null || !Number.isFinite(micrometres)) return '—';
  return `${micrometres.toFixed(4)} µm`;
}

export function formatBandwidth(micrometres: number | null | undefined): string {
  if (micrometres == null || !Number.isFinite(micrometres)) return '—';
  return `±${(micrometres / 2).toFixed(4)} µm`;
}

export function formatAngle(degrees: number): string {
  if (!Number.isFinite(degrees)) return '—';
  if (degrees >= 1) {
    return `${degrees.toFixed(degrees >= 10 ? 1 : 2)}°`;
  }
  const arcmin = degrees * 60;
  if (arcmin >= 1) {
    return `${arcmin.toFixed(arcmin >= 10 ? 1 : 2)}′`;
  }
  const arcsec = arcmin * 60;
  return `${arcsec.toFixed(1)}″`;
}

export function formatArcmin(arcmin: number): string {
  if (!Number.isFinite(arcmin)) return '—';
  return `${arcmin.toFixed(1)}′`;
}

export function formatFov(sizeArcmin: number): string {
  if (!Number.isFinite(sizeArcmin)) return '—';
  return `${sizeArcmin.toFixed(1)}′ × ${sizeArcmin.toFixed(1)}′`;
}

export function formatDateIso(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return isoString;
  }
}

export function formatMjd(mjd: number | null | undefined): string {
  if (mjd == null || !Number.isFinite(mjd)) return '—';
  return `MJD ${mjd.toFixed(4)}`;
}

export function formatFlux(value: number | null | undefined, unit = 'MJy/sr'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) < 0.001 || Math.abs(value) >= 10000) {
    return `${value.toExponential(4)} ${unit}`;
  }
  return `${value.toFixed(4)} ${unit}`;
}
