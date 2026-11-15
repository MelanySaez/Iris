import { FEATURED_OBJECTS, type FeaturedObject } from './catalogs';
import { TocatsCatalogClient, type TocatsQueryResult } from './tocats';

export const DEFAULT_NEARBY_RADIUS_DEG = 0.5;
export const MAX_NEARBY_RADIUS_DEG = 5;
export const MAX_NEARBY_RESULTS = 300;
export const SIMBAD_TAP_URL = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';

export type NearbyCatalogId = 'featured' | 'simbad' | 'gaia' | 'catwise';

export interface NearbyCatalogSource {
  id: string;
  catalogId: NearbyCatalogId;
  catalogLabel: string;
  raDeg: number;
  decDeg: number;
  data: Record<string, unknown>;
}

export interface NearbyCatalogResult {
  catalogId: NearbyCatalogId;
  catalogLabel: string;
  sources: NearbyCatalogSource[];
  error?: string;
}

export interface SearchNearbyCatalogsOptions {
  raDeg: number;
  decDeg: number;
  radiusDeg?: number;
  visibleCatalogIds: readonly NearbyCatalogId[] | ReadonlySet<NearbyCatalogId>;
  signal?: AbortSignal;
}

export interface SearchNearbyCatalogsDependencies {
  tocatsClient?: Pick<TocatsCatalogClient, 'query'>;
  fetcher?: typeof fetch;
  featuredObjects?: readonly FeaturedObject[];
}

interface CatalogDefinition {
  id: NearbyCatalogId;
  label: string;
}

const CATALOGS: Record<NearbyCatalogId, CatalogDefinition> = {
  featured: { id: 'featured', label: 'Featured objects' },
  simbad: { id: 'simbad', label: 'SIMBAD' },
  gaia: { id: 'gaia', label: 'Gaia DR3' },
  catwise: { id: 'catwise', label: 'CatWISE2020' },
};
const SIMBAD_RESULT_LIMIT = 300;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Nearby catalog search was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function validateOptions(options: SearchNearbyCatalogsOptions): number {
  const radiusDeg = options.radiusDeg ?? DEFAULT_NEARBY_RADIUS_DEG;
  if (!Number.isFinite(options.raDeg) || options.raDeg < 0 || options.raDeg >= 360
    || !Number.isFinite(options.decDeg)
    || options.decDeg < -90 || options.decDeg > 90) {
    throw new RangeError('Nearby catalog coordinates must be finite with declination between -90° and 90°.');
  }
  if (!Number.isFinite(radiusDeg) || radiusDeg <= 0 || radiusDeg > MAX_NEARBY_RADIUS_DEG) {
    throw new RangeError(`Nearby catalog radius must be greater than 0° and no more than ${MAX_NEARBY_RADIUS_DEG}°.`);
  }
  return radiusDeg;
}

/** Great-circle separation in degrees, stable near the poles and across RA=0. */
export function nearbyAngularDistanceDeg(
  a: Pick<SearchNearbyCatalogsOptions, 'raDeg' | 'decDeg'>,
  b: Pick<NearbyCatalogSource, 'raDeg' | 'decDeg'>,
): number {
  const radians = Math.PI / 180;
  const decA = a.decDeg * radians;
  const decB = b.decDeg * radians;
  const deltaDec = decB - decA;
  const deltaRa = (b.raDeg - a.raDeg) * radians;
  const haversine = Math.sin(deltaDec / 2) ** 2
    + Math.cos(decA) * Math.cos(decB) * Math.sin(deltaRa / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, haversine)))) / radians;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseSimbadResponse(payload: unknown): NearbyCatalogSource[] {
  const root = record(payload);
  if (!root) throw new Error('SIMBAD returned an invalid TAP response.');
  const rawColumns = Array.isArray(root.metadata) ? root.metadata : Array.isArray(root.fields) ? root.fields : null;
  const rows = root.data;
  if (!rawColumns || !Array.isArray(rows)) throw new Error('SIMBAD returned an unsupported TAP table.');
  const columns = rawColumns.map((column) => {
    if (typeof column === 'string') return column;
    const item = record(column);
    return typeof item?.name === 'string' ? item.name : '';
  });
  const columnIndex = new Map(columns.map((name, index) => [name.toLowerCase(), index]));
  const idIndex = columnIndex.get('main_id');
  const raIndex = columnIndex.get('ra');
  const decIndex = columnIndex.get('dec');
  if (idIndex === undefined || raIndex === undefined || decIndex === undefined) {
    throw new Error('SIMBAD TAP response is missing main_id, ra, or dec columns.');
  }

  const sources: NearbyCatalogSource[] = [];
  for (const rawRow of rows) {
    const row = Array.isArray(rawRow)
      ? rawRow
      : columns.map((name) => record(rawRow)?.[name]);
    const idValue = row[idIndex];
    const raDeg = finiteNumber(row[raIndex]);
    const decDeg = finiteNumber(row[decIndex]);
    if (typeof idValue !== 'string' || idValue.trim() === '' || raDeg === null || decDeg === null
      || raDeg < 0 || raDeg >= 360 || decDeg < -90 || decDeg > 90) continue;
    const data: Record<string, unknown> = {};
    columns.forEach((name, index) => { if (name) data[name] = row[index]; });
    sources.push({ id: idValue, catalogId: 'simbad', catalogLabel: CATALOGS.simbad.label, raDeg, decDeg, data });
    if (sources.length >= MAX_NEARBY_RESULTS) break;
  }
  return sources;
}

function simbadQuery(options: SearchNearbyCatalogsOptions, radiusDeg: number): string {
  const adql = `SELECT TOP ${SIMBAD_RESULT_LIMIT} main_id, ra, dec, otype FROM basic `
    + `WHERE 1=CONTAINS(POINT('ICRS', ra, dec), `
    + `CIRCLE('ICRS', ${options.raDeg}, ${options.decDeg}, ${radiusDeg}))`;
  const params = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'json', QUERY: adql });
  return `${SIMBAD_TAP_URL}?${params.toString()}`;
}

async function querySimbad(
  options: SearchNearbyCatalogsOptions,
  radiusDeg: number,
  fetcher: typeof fetch,
): Promise<NearbyCatalogSource[]> {
  throwIfAborted(options.signal);
  const response = await fetcher(simbadQuery(options, radiusDeg), { signal: options.signal });
  throwIfAborted(options.signal);
  if (!response.ok) throw new Error(`SIMBAD TAP returned HTTP ${response.status}.`);
  const parsed = parseSimbadResponse(await response.json());
  throwIfAborted(options.signal);
  return parsed;
}

function fromTocats(catalogId: 'gaia' | 'catwise', result: TocatsQueryResult): NearbyCatalogSource[] {
  return result.sources.slice(0, MAX_NEARBY_RESULTS).map((source) => ({
    id: source.id,
    catalogId,
    catalogLabel: CATALOGS[catalogId].label,
    raDeg: source.ra,
    decDeg: source.dec,
    data: source.data,
  }));
}

function featuredSources(
  objects: readonly FeaturedObject[],
  options: SearchNearbyCatalogsOptions,
  radiusDeg: number,
): NearbyCatalogSource[] {
  return objects.filter((object) => nearbyAngularDistanceDeg(options, {
    raDeg: object.ra_deg, decDeg: object.dec_deg,
  }) <= radiusDeg).slice(0, MAX_NEARBY_RESULTS).map((object) => ({
    id: object.id,
    catalogId: 'featured',
    catalogLabel: CATALOGS.featured.label,
    raDeg: object.ra_deg,
    decDeg: object.dec_deg,
    data: { ...object },
  }));
}

/** Search only catalogs that are currently hidden; this function never mutates visibility or stores results. */
export async function searchNearbyCatalogs(
  options: SearchNearbyCatalogsOptions,
  dependencies: SearchNearbyCatalogsDependencies = {},
): Promise<NearbyCatalogResult[]> {
  const radiusDeg = validateOptions(options);
  throwIfAborted(options.signal);
  const visibleIds = options.visibleCatalogIds instanceof Set
    ? options.visibleCatalogIds
    : new Set(options.visibleCatalogIds);
  const results: NearbyCatalogResult[] = [];

  if (!visibleIds.has('featured')) {
    results.push({ catalogId: 'featured', catalogLabel: CATALOGS.featured.label, sources: featuredSources(dependencies.featuredObjects ?? FEATURED_OBJECTS, options, radiusDeg) });
  }

  const tocatsClient = dependencies.tocatsClient ?? new TocatsCatalogClient();
  const fetcher = dependencies.fetcher ?? fetch;
  const hiddenRemote: Array<'simbad' | 'gaia' | 'catwise'> = ['simbad', 'gaia', 'catwise']
    .filter((id): id is 'simbad' | 'gaia' | 'catwise' => !visibleIds.has(id));
  const queried = await Promise.all(hiddenRemote.map(async (catalogId): Promise<NearbyCatalogResult> => {
    try {
      const sources = catalogId === 'simbad'
        ? await querySimbad(options, radiusDeg, fetcher)
        : fromTocats(catalogId, await tocatsClient.query(catalogId, {
          raDeg: options.raDeg, decDeg: options.decDeg, radiusDeg,
        }, options.signal));
      throwIfAborted(options.signal);
      return { catalogId, catalogLabel: CATALOGS[catalogId].label, sources };
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      return { catalogId, catalogLabel: CATALOGS[catalogId].label, sources: [], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  results.push(...queried);
  throwIfAborted(options.signal);
  return results;
}
