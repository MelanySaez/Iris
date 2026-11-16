export const SPHEREX_HIPS_ROOT =
  'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const VIRTUAL_HIPS_ROOT = '/spherex-virtual-hips';
export const EXCLUDED_INDICES = new Set([50, 51]);

export type SpectralChannel = { index: number; wavelengthMicrometres: number };

export function channelVirtualHipsUrl(index: number, origin?: string): string {
  if (!Number.isInteger(index) || index < 0 || index > 101 || EXCLUDED_INDICES.has(index)) {
    throw new Error(`Spectral index ${index} is unavailable.`);
  }
  const root = `${VIRTUAL_HIPS_ROOT}/channel/${index}`;
  if (!origin) return root;
  const url = new URL(root, origin);
  if (url.origin !== new URL(origin).origin) throw new Error('Virtual HiPS URLs must remain same-origin.');
  return url.href;
}

export function channelByIndex(channels: SpectralChannel[], index: number): SpectralChannel | undefined {
  return channels.find((channel) => channel.index === index);
}

export function parseProperties(source: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    properties.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }
  return properties;
}

export function parseChannels(source: string): SpectralChannel[] {
  const properties = parseProperties(source);
  const depth = Number(properties.get('hips_cube_depth'));
  const wavelengthsText = properties.get('data_cube_crval3_arr');
  if (properties.get('dataproduct_type') !== 'cube' || !Number.isInteger(depth) || !wavelengthsText) {
    throw new Error('Official HiPS metadata is missing cube depth or wavelength values.');
  }
  const wavelengths = wavelengthsText.split(/[;,\s]+/).filter(Boolean).map(Number);
  if (wavelengths.length !== depth || wavelengths.some((value) => !Number.isFinite(value))) {
    throw new Error(`Expected ${depth} finite wavelengths in data_cube_crval3_arr; received ${wavelengths.length}.`);
  }
  return wavelengths.flatMap((wavelengthMicrometres, index) =>
    index >= depth || EXCLUDED_INDICES.has(index) ? [] : [{ index, wavelengthMicrometres }],
  );
}

export function remoteTilePath(order: number, directory: number, pixel: number, channel: number): string {
  if (EXCLUDED_INDICES.has(channel)) throw new Error(`Spectral index ${channel} is blank and unavailable.`);
  const suffix = channel === 0 ? '' : `_${channel}`;
  return `Norder${order}/Dir${directory}/Npix${pixel}${suffix}.png`;
}

export function imagePropertiesFromCube(source: string, virtualServiceUrl = VIRTUAL_HIPS_ROOT): string {
  const existing = parseProperties(source);
  const allowed = [
    'hips_version',
    'hips_frame',
    'hips_order',
    'hips_order_min',
    'hips_tile_width',
    'hips_tile_format',
    'hips_pixel_scale',
    'hips_initial_fov',
    'hips_initial_ra',
    'hips_initial_dec',
  ];
  const lines = allowed.flatMap((key) => {
    const value = existing.get(key);
    return value === undefined ? [] : [`${key}=${value}`];
  });
  lines.push(
    'dataproduct_type=image',
    `hips_service_url=${virtualServiceUrl}`,
  );
  return `${lines.join('\n')}\n`;
}
