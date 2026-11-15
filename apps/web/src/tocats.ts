export const TOCATS_CATALOGS = {
  gaia: {
    id: 'gaia',
    label: 'Gaia DR3',
    catalogue: 'gaiadr3',
    color: '#b8e66e',
    sourceSize: 12,
    shape: 'circle',
  },
  catwise: {
    id: 'catwise',
    label: 'CatWISE2020',
    catalogue: 'catwise_mini',
    color: '#f2a3d2',
    sourceSize: 12,
    shape: 'rhomb',
  },
} as const;

export type TocatsCatalogId = keyof typeof TOCATS_CATALOGS;

export interface TocatsRegion {
  raDeg: number;
  decDeg: number;
  radiusDeg: number;
}

export interface TocatsColumnMetadata {
  label?: string;
  unit?: string;
  ucd?: string;
}

export interface TocatsSource {
  id: string;
  ra: number;
  dec: number;
  data: Record<string, unknown>;
}

export interface TocatsQueryResult {
  sources: TocatsSource[];
  columns: Record<string, TocatsColumnMetadata>;
  found: number;
  truncated: boolean;
}

export interface TocatsDensityCell {
  id: string;
  healpixId: number;
  order: number;
  count: number;
  ra: number;
  dec: number;
  magnitude: number | null;
}

export interface TocatsDensityResult {
  cells: TocatsDensityCell[];
  foundCells: number;
  totalSources: number;
  truncated: boolean;
  order: number;
}

export interface TocatsSourceRecord {
  source: TocatsSource;
  columns: Record<string, TocatsColumnMetadata>;
}

export const MAX_TOCATS_MARKERS = 300;
export const MAX_TOCATS_DENSITY_CELLS = 500;
export const MAX_TOCATS_SOURCE_ESTIMATE = 2_000;
export const MAX_TOCATS_CACHED_ITEMS = 3_000;
export const MAX_TOCATS_QUERY_RADIUS_DEG = 5;
export const TOCATS_CACHE_TTL_MS = 5 * 60 * 1000;
export const TOCATS_CACHE_MAX_ENTRIES = 24;

const TOCATS_ROOT = 'https://cats.oas.inaf.it';
const QUERY_RADIUS_PADDING_DEG = 0.01;
const QUERY_CENTER_PRECISION = 3;
const QUERY_RADIUS_PRECISION = 2;

const DISPLAY_FIELDS: Record<TocatsCatalogId, Array<{ key: string; label: string; unit?: string }>> = {
  gaia: [
    { key: 'parallax', label: 'Parallax', unit: 'mas' },
    { key: 'pmra', label: 'Proper motion in RA (μRA*)', unit: 'mas/yr' },
    { key: 'pmdec', label: 'Proper motion in Dec (μDec)', unit: 'mas/yr' },
    { key: 'pmra_error', label: 'Proper motion RA uncertainty', unit: 'mas/yr' },
    { key: 'pmdec_error', label: 'Proper motion Dec uncertainty', unit: 'mas/yr' },
    { key: 'phot_g_mean_mag', label: 'G mean magnitude', unit: 'mag' },
    { key: 'phot_bp_mean_mag', label: 'BP mean magnitude', unit: 'mag' },
    { key: 'phot_rp_mean_mag', label: 'RP mean magnitude', unit: 'mag' },
    { key: 'ra_error', label: 'RA uncertainty', unit: 'mas' },
    { key: 'dec_error', label: 'Dec uncertainty', unit: 'mas' },
    { key: 'ruwe', label: 'RUWE' },
    { key: 'astrometric_n_obs_al', label: 'Astrometric AL observations' },
    { key: 'visibility_periods_used', label: 'Visibility periods used' },
  ],
  catwise: [
    { key: 'w1mpro', label: 'W1 magnitude', unit: 'mag' },
    { key: 'w1sigmpro', label: 'W1 magnitude uncertainty', unit: 'mag' },
    { key: 'w2mpro', label: 'W2 magnitude', unit: 'mag' },
    { key: 'w2sigmpro', label: 'W2 magnitude uncertainty', unit: 'mag' },
    { key: 'PMRA', label: 'Proper motion in RA', unit: 'arcsec/yr' },
    { key: 'sigPMRA', label: 'Proper motion RA uncertainty', unit: 'arcsec/yr' },
    { key: 'PMDec', label: 'Proper motion in Dec', unit: 'arcsec/yr' },
    { key: 'sigPMDec', label: 'Proper motion Dec uncertainty', unit: 'arcsec/yr' },
    { key: 'sigra', label: 'RA uncertainty', unit: 'arcsec' },
    { key: 'sigdec', label: 'Dec uncertainty', unit: 'arcsec' },
    { key: 'w1rchi2', label: 'W1 reduced chi-square' },
    { key: 'w2rchi2', label: 'W2 reduced chi-square' },
    { key: 'w1mJDmean', label: 'W1 mean observation MJD', unit: 'days' },
    { key: 'cc_flags', label: 'Contamination and confusion flags' },
    { key: 'ab_flags', label: 'Artifact flags' },
  ],
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function normalizeRa(ra: number): number {
  const normalized = ra % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function queryCoordinates(region: TocatsRegion, maximumRadius = MAX_TOCATS_QUERY_RADIUS_DEG): { ra: number; dec: number; radius: number } {
  if (!Number.isFinite(region.raDeg) || !Number.isFinite(region.decDeg)
    || region.decDeg < -90 || region.decDeg > 90
    || !Number.isFinite(region.radiusDeg) || region.radiusDeg <= 0) {
    throw new RangeError('TOCats cone coordinates and radius must be finite and valid.');
  }

  const roundedRa = round(normalizeRa(region.raDeg), QUERY_CENTER_PRECISION);
  const ra = roundedRa >= 360 ? 0 : roundedRa;
  const dec = round(region.decDeg, QUERY_CENTER_PRECISION);
  const radius = Math.ceil(
    (region.radiusDeg + QUERY_RADIUS_PADDING_DEG) * 10 ** QUERY_RADIUS_PRECISION,
  ) / 10 ** QUERY_RADIUS_PRECISION;

  if (region.radiusDeg > maximumRadius) {
    throw new RangeError(`TOCats query radius must be ${maximumRadius}° or less.`);
  }

  return { ra, dec, radius };
}

export function chooseTocatsDensityOrder(radiusDeg: number): number {
  if (!Number.isFinite(radiusDeg) || radiusDeg <= 0 || radiusDeg > 180) {
    throw new RangeError('TOCats density radius must be between 0° and 180°.');
  }
  const fraction = (1 - Math.cos(radiusDeg * Math.PI / 180)) / 2;
  for (let order = 9; order >= 3; order -= 1) {
    if (12 * 4 ** order * fraction <= MAX_TOCATS_DENSITY_CELLS) return order;
  }
  return 3;
}

export function buildTocatsDensityUrl(catalogId: TocatsCatalogId, region: TocatsRegion, order: number): string {
  if (!Number.isInteger(order) || order < 3 || order > 9) throw new RangeError('Unsupported TOCats HEALPix order.');
  const { ra, dec, radius } = queryCoordinates(region, 180);
  return `${TOCATS_ROOT}/${TOCATS_CATALOGS[catalogId].catalogue}_hips${order}`
    + `/radius=${radius.toFixed(QUERY_RADIUS_PRECISION)}`
    + `&ra=${ra.toFixed(QUERY_CENTER_PRECISION)}&dec=${dec.toFixed(QUERY_CENTER_PRECISION)}`
    + `&limit=${MAX_TOCATS_DENSITY_CELLS}&json`;
}

export function isTocatsRegionSupported(region: TocatsRegion): boolean {
  try {
    queryCoordinates(region);
    return true;
  } catch {
    return false;
  }
}

export function buildTocatsConeUrl(catalogId: TocatsCatalogId, region: TocatsRegion): string {
  const provider = TOCATS_CATALOGS[catalogId];
  const { ra, dec, radius } = queryCoordinates(region);

  return `${TOCATS_ROOT}/${provider.catalogue}/radius=${radius.toFixed(QUERY_RADIUS_PRECISION)}`
    + `&ra=${ra.toFixed(QUERY_CENTER_PRECISION)}&dec=${dec.toFixed(QUERY_CENTER_PRECISION)}`
    + `&limit=${MAX_TOCATS_MARKERS}&json`;
}

function displayIdentifier(catalogId: TocatsCatalogId, data: JsonRecord): string {
  const candidate = data[catalogId === 'gaia' ? 'source_id' : 'source_name'];
  if (typeof candidate === 'number' || (typeof candidate === 'string' && candidate.trim() !== '')) {
    return String(candidate);
  }
  return '';
}

function columnMetadata(value: unknown): Record<string, TocatsColumnMetadata> {
  const metadata = asRecord(value);
  if (!metadata) return {};

  const result: Record<string, TocatsColumnMetadata> = {};
  for (const [name, rawColumn] of Object.entries(metadata)) {
    const column = asRecord(rawColumn);
    if (!column) continue;
    result[name] = {
      label: typeof column.label === 'string' ? column.label : undefined,
      unit: typeof column.unit === 'string' && column.unit.trim() !== '' && column.unit !== '--'
        ? column.unit
        : undefined,
      ucd: typeof column.ucd === 'string' ? column.ucd : undefined,
    };
  }
  return result;
}

export function parseTocatsResponse(payload: unknown, catalogId: TocatsCatalogId): TocatsQueryResult {
  const root = asRecord(payload);
  if (!root) throw new Error('TOCats returned an invalid JSON response.');

  const queryResult = asRecord(root.data) ?? root;
  const queryMeta = asRecord(queryResult.qry_meta) ?? asRecord(root.qry_meta);
  const status = finiteNumber(queryMeta?.status);
  const errorMessage = typeof queryMeta?.errmsg === 'string' ? queryMeta.errmsg.trim() : '';
  if (status !== null && status < 0) {
    throw new Error(errorMessage || 'TOCats rejected the spatial query.');
  }

  const rawRows = queryResult.objs;
  if (!Array.isArray(rawRows)) throw new Error('TOCats returned an unexpected table format.');

  const columns = columnMetadata(root.metadata);
  const columnNames = Object.keys(columns);
  if (rawRows.length > 0 && columnNames.length === 0) {
    throw new Error('TOCats returned rows without column metadata.');
  }

  const sources: TocatsSource[] = [];
  for (const rawRow of rawRows) {
    if (!Array.isArray(rawRow)) continue;
    const data: JsonRecord = {};
    for (let index = 0; index < columnNames.length && index < rawRow.length; index += 1) {
      data[columnNames[index]] = rawRow[index];
    }

    const ra = finiteNumber(data.ra);
    const dec = finiteNumber(data.dec);
    if (ra === null || dec === null || ra < 0 || ra >= 360 || dec < -90 || dec > 90) continue;

    sources.push({ id: displayIdentifier(catalogId, data), ra, dec, data });
    if (sources.length >= MAX_TOCATS_MARKERS) break;
  }

  const found = finiteNumber(queryMeta?.n_objs_found)
    ?? finiteNumber(queryMeta?.n_objs)
    ?? rawRows.length;

  return {
    sources,
    columns,
    found,
    truncated: found > sources.length || rawRows.length > MAX_TOCATS_MARKERS,
  };
}

export function parseTocatsDensityResponse(
  payload: unknown, catalogId: TocatsCatalogId, order: number,
): TocatsDensityResult {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const meta = asRecord(data?.qry_meta);
  if (!root || !data || !Array.isArray(data.objs)) throw new Error('TOCats returned an unexpected density table.');
  const status = finiteNumber(meta?.status);
  if (status !== null && status < 0) throw new Error(String(meta?.errmsg || 'TOCats rejected the density query.'));
  // Child-table JSON metadata describes the original table, but each row uses five query aliases.
  // The documented TOCatsweb query returns hpxid, nobjspix, c_ra, c_de, mag in that order.
  if (meta?.n_fields !== undefined && finiteNumber(meta.n_fields) !== 5) {
    throw new Error('TOCats returned an unsupported density row layout.');
  }
  const cells: TocatsDensityCell[] = [];
  for (const row of data.objs) {
    if (!Array.isArray(row) || row.length !== 5) continue;
    const [rawId, rawCount, rawRa, rawDec, rawMagnitude] = row;
    const healpixId = finiteNumber(rawId);
    const count = finiteNumber(rawCount);
    const ra = finiteNumber(rawRa);
    const dec = finiteNumber(rawDec);
    if (healpixId === null || !Number.isSafeInteger(healpixId) || healpixId < 0
      || count === null || !Number.isSafeInteger(count) || count < 0
      || ra === null || ra < 0 || ra >= 360 || dec === null || dec < -90 || dec > 90) continue;
    cells.push({
      id: `${catalogId}:${order}:${healpixId}`, healpixId, order, count, ra, dec,
      magnitude: finiteNumber(rawMagnitude),
    });
    if (cells.length >= MAX_TOCATS_DENSITY_CELLS) break;
  }
  // HiPS child metadata uses n_objs for returned tiles and n_objs_found for
  // the number of catalogue sources represented by those tiles.
  const foundCells = finiteNumber(meta?.n_objs) ?? data.objs.length;
  const totalSources = finiteNumber(meta?.n_objs_found)
    ?? cells.reduce((sum, cell) => sum + cell.count, 0);
  return {
    cells, foundCells, totalSources,
    truncated: foundCells > cells.length || data.objs.length >= MAX_TOCATS_DENSITY_CELLS,
    order,
  };
}

export function formatTocatsDensityPopup(catalogId: TocatsCatalogId, cell: TocatsDensityCell): string {
  const rows = [
    ['Catalogue', `${TOCATS_CATALOGS[catalogId].label} via TOCats`],
    ['Kind', 'HEALPix density tile, not an individual source'],
    ['Sources in tile', cell.count.toLocaleString()],
    ['HEALPix order / cell', `${cell.order} / ${cell.healpixId}`],
    ['Representative coordinates (ICRS)', `${cell.ra}, ${cell.dec} deg`],
  ];
  if (cell.magnitude !== null) rows.push([
    catalogId === 'gaia' ? 'Representative Gaia G magnitude' : 'Representative WISE W1 magnitude',
    `${cell.magnitude} mag`,
  ]);
  return rows.map(([label, value]) => `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`).join('');
}

export function angularDistanceDeg(a: Pick<TocatsRegion, 'raDeg' | 'decDeg'>, b: Pick<TocatsRegion, 'raDeg' | 'decDeg'>): number {
  const radians = Math.PI / 180;
  const decA = a.decDeg * radians;
  const decB = b.decDeg * radians;
  const cosine = Math.sin(decA) * Math.sin(decB)
    + Math.cos(decA) * Math.cos(decB) * Math.cos((a.raDeg - b.raDeg) * radians);
  return Math.acos(Math.max(-1, Math.min(1, cosine))) / radians;
}

export class TocatsViewportCache {
  readonly sources = new Map<string, TocatsSourceRecord>();
  readonly cells = new Map<string, TocatsDensityCell>();
  private sourceCoverage: TocatsRegion[] = [];
  private densityCoverage: Array<{ region: TocatsRegion; order: number }> = [];

  constructor(private readonly capacity = MAX_TOCATS_CACHED_ITEMS) {}

  private add<K, V>(map: Map<K, V>, key: K, value: V): boolean {
    map.delete(key);
    map.set(key, value);
    let evicted = false;
    while (map.size > this.capacity) {
      map.delete(map.keys().next().value as K);
      evicted = true;
    }
    return evicted;
  }

  mergeSources(result: TocatsQueryResult): void {
    let evicted = false;
    for (const source of result.sources) {
      const key = source.id ? `id:${source.id}` : `coord:${source.ra}:${source.dec}`;
      evicted = this.add(this.sources, key, { source, columns: result.columns }) || evicted;
    }
    if (evicted) this.sourceCoverage = [];
  }

  mergeDensity(result: TocatsDensityResult): void {
    let evicted = false;
    for (const cell of result.cells) evicted = this.add(this.cells, cell.id, cell) || evicted;
    if (evicted) this.densityCoverage = [];
  }

  recordSourceCoverage(region: TocatsRegion): void {
    this.sourceCoverage.push({ ...region });
    if (this.sourceCoverage.length > 24) this.sourceCoverage.shift();
  }

  recordDensityCoverage(region: TocatsRegion, order: number): void {
    this.densityCoverage.push({ region: { ...region }, order });
    if (this.densityCoverage.length > 24) this.densityCoverage.shift();
  }

  private covers(coverage: TocatsRegion, region: TocatsRegion): boolean {
    const distance = angularDistanceDeg(coverage, region);
    return distance + region.radiusDeg <= coverage.radiusDeg + 0.001
      || (coverage.radiusDeg >= 89.9 && region.radiusDeg >= 89.9 && distance <= 2);
  }

  hasSourceCoverage(region: TocatsRegion): boolean {
    return this.sourceCoverage.some((coverage) => this.covers(coverage, region));
  }

  hasDensityCoverage(region: TocatsRegion, order: number): boolean {
    return this.densityCoverage.some((coverage) => coverage.order === order && this.covers(coverage.region, region));
  }

  bestDensityOrder(region: TocatsRegion, preferredOrder: number): number | null {
    // A coarser cell covers the position but cannot resolve a zoomed-in field.
    return this.hasDensityCoverage(region, preferredOrder) ? preferredOrder : null;
  }

  visibleSources(region: TocatsRegion): Array<[string, TocatsSourceRecord]> {
    return [...this.sources].filter(([, record]) => angularDistanceDeg(region, {
      raDeg: record.source.ra, decDeg: record.source.dec,
    }) <= region.radiusDeg).sort((a, b) => angularDistanceDeg(region, {
      raDeg: a[1].source.ra, decDeg: a[1].source.dec,
    }) - angularDistanceDeg(region, { raDeg: b[1].source.ra, decDeg: b[1].source.dec }))
      .slice(0, MAX_TOCATS_MARKERS);
  }

  visibleCells(region: TocatsRegion, order: number): Array<[string, TocatsDensityCell]> {
    // The representative coordinate is not the tile boundary. Include a
    // conservative cell-width margin so intersecting tiles stay visible.
    const cellWidthDeg = Math.sqrt(41_252.96 / (12 * 4 ** order));
    const displayRadius = Math.min(180, region.radiusDeg + 1.5 * cellWidthDeg);
    return [...this.cells].filter(([, cell]) => cell.order === order && angularDistanceDeg(region, {
      raDeg: cell.ra, decDeg: cell.dec,
    }) <= displayRadius).sort((a, b) => angularDistanceDeg(region, {
      raDeg: a[1].ra, decDeg: a[1].dec,
    }) - angularDistanceDeg(region, { raDeg: b[1].ra, decDeg: b[1].dec }))
      .slice(0, MAX_TOCATS_DENSITY_CELLS);
  }
}

function safeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value.trim() : String(value);
  return text === '' ? null : text;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function getTocatsSourceTitle(catalogId: TocatsCatalogId, source: TocatsSource): string {
  if (catalogId === 'gaia' && source.id) return `Gaia DR3 ${escapeHtml(source.id)}`;
  if (catalogId === 'catwise' && source.id) return escapeHtml(source.id);
  return TOCATS_CATALOGS[catalogId].label;
}

export function formatTocatsPopup(
  catalogId: TocatsCatalogId,
  source: TocatsSource,
  columns: Record<string, TocatsColumnMetadata>,
): string {
  const provider = TOCATS_CATALOGS[catalogId];
  const identifierLabel = catalogId === 'gaia' ? 'Gaia DR3 source_id' : 'CatWISE2020 source designation';
  const identifier = safeValue(source.id);
  const coordinateLabel = 'Coordinates (ICRS)';
  const rows: Array<[string, string, string?]> = [
    ['Catalogue', `${provider.label} via TOCats`],
    ...(identifier ? [[identifierLabel, identifier] as [string, string]] : []),
    [coordinateLabel, `${source.ra}, ${source.dec}`, 'deg'],
  ];

  rows.push(catalogId === 'gaia'
    ? ['Reference epoch', '2016.0 (Julian year, TCB)']
    : ['Reference epoch', 'MJD 57170 (2015-05-28)']);

  for (const field of DISPLAY_FIELDS[catalogId]) {
    const value = safeValue(source.data[field.key]);
    if (!value) continue;
    const unit = columns[field.key]?.unit ?? field.unit;
    rows.push([field.label, value, unit]);
  }

  return rows.map(([label, value, unit]) => {
    const displayValue = unit ? `${value} ${unit}` : value;
    return `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(displayValue)}</div>`;
  }).join('');
}

export function getTocatsMarkerOptions(
  catalogId: TocatsCatalogId,
  source: TocatsSource,
  columns: Record<string, TocatsColumnMetadata>,
): {
  popupTitle: string;
  popupDesc: string;
  useMarkerDefaultIcon: false;
} {
  return {
    popupTitle: getTocatsSourceTitle(catalogId, source),
    popupDesc: formatTocatsPopup(catalogId, source, columns),
    useMarkerDefaultIcon: false,
  };
}

export interface TocatsCatalogClientOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
}

interface CachedQuery {
  cachedAt: number;
  result: TocatsQueryResult | TocatsDensityResult;
}

function abortError(): Error {
  const error = new Error('The TOCats request was cancelled.');
  error.name = 'AbortError';
  return error;
}

export class TocatsCatalogClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly cache = new Map<string, CachedQuery>();

  constructor({
    fetcher = fetch,
    now = Date.now,
    cacheTtlMs = TOCATS_CACHE_TTL_MS,
    cacheMaxEntries = TOCATS_CACHE_MAX_ENTRIES,
  }: TocatsCatalogClientOptions = {}) {
    this.fetcher = fetcher.bind(globalThis);
    this.now = now;
    this.cacheTtlMs = cacheTtlMs;
    this.cacheMaxEntries = cacheMaxEntries;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async query(catalogId: TocatsCatalogId, region: TocatsRegion, signal?: AbortSignal): Promise<TocatsQueryResult> {
    return this.request(buildTocatsConeUrl(catalogId, region), (payload) => parseTocatsResponse(payload, catalogId), signal);
  }

  async queryDensity(catalogId: TocatsCatalogId, region: TocatsRegion, order: number, signal?: AbortSignal): Promise<TocatsDensityResult> {
    return this.request(buildTocatsDensityUrl(catalogId, region, order),
      (payload) => parseTocatsDensityResponse(payload, catalogId, order), signal);
  }

  private async request<T extends TocatsQueryResult | TocatsDensityResult>(
    url: string, parse: (payload: unknown) => T, signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw abortError();
    const cached = this.cache.get(url);
    if (cached && this.now() - cached.cachedAt < this.cacheTtlMs) {
      this.cache.delete(url);
      this.cache.set(url, cached);
      return cached.result as T;
    }
    if (cached) this.cache.delete(url);

    const response = await this.fetcher(url, { signal });
    if (signal?.aborted) throw abortError();
    if (!response.ok) throw new Error(`TOCats returned HTTP ${response.status}.`);

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('json')) {
      throw new Error('TOCats returned a response that was not JSON.');
    }

    const payload: unknown = await response.json();
    if (signal?.aborted) throw abortError();
    const result = parse(payload);
    this.cache.set(url, { cachedAt: this.now(), result });
    while (this.cache.size > this.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
    return result;
  }
}
