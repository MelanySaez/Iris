import featuredObjectsJson from '../data/featured-objects.json';

export interface FeaturedObject {
  id: string;
  name: string;
  ra_deg: number;
  dec_deg: number;
  type: string;
  description: string;
  coordinateFrame: string;
  referenceEpoch: string;
  positionSource: string;
  positionSourceUrl: string;
}

export interface RemoteCatalogSource {
  ra?: unknown;
  dec?: unknown;
  data?: Record<string, unknown>;
}

export const FEATURED_OBJECTS = featuredObjectsJson as FeaturedObject[];

export const HIPS_CATALOG_PROVIDERS = {
  simbad: {
    id: 'simbad',
    name: 'SIMBAD',
    color: '#73d9f5',
    // Same marker size as the Gaia and CatWISE layers, so SIMBAD objects are as easy to spot.
    sourceSize: 12,
  },
} as const;

export const LOCAL_CATALOG_STYLE = {
  name: 'Iris featured objects',
  color: '#ffd36e',
  sourceSize: 16,
  shape: 'rhomb',
} as const;

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isDuplicateRemoteSource(source: RemoteCatalogSource): boolean {
  if (!source.data) return false;
  const mainId = Object.entries(source.data).find(([key]) => key.toLowerCase() === 'main_id')?.[1];
  if (typeof mainId !== 'string' || mainId.trim() === '') return false;

  const identifier = normalizeIdentifier(mainId);
  return FEATURED_OBJECTS.some((object) => normalizeIdentifier(object.name) === identifier);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function featuredObjectPopup(object: FeaturedObject): string {
  const rows = [
    ['Type', object.type],
    ['Coordinates (ICRS)', `${object.ra_deg.toFixed(6)}°, ${object.dec_deg.toFixed(6)}°`],
    ['Reference epoch', object.referenceEpoch],
    ['Description', object.description],
  ];
  const details = rows
    .map(([label, value]) => `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`)
    .join('');
  const source = `<a href="${escapeHtml(object.positionSourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(object.positionSource)}</a>`;

  return `${details}<div><strong>Position source:</strong> ${source}</div>`;
}
