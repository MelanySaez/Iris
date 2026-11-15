import type {
  CatalogObject,
  CatalogResponse,
  ChannelsResponse,
  CubeSpectrumResponse,
  FrameRenderMode,
  HealthResponse,
  JobCreateRequest,
  JobManifest,
  JobSnapshot,
  PixelReadout,
  ProductType,
  RegionRequest,
  RegionResolveResponse,
  SelectionListResponse,
  SelectionSummary,
  StretchMode,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = await response.json();
      if (body && typeof body === 'object') {
        if (typeof body.detail === 'string') {
          detail = body.detail;
        } else if (Array.isArray(body.detail)) {
          detail = body.detail
            .map((item: unknown) =>
              item && typeof item === 'object' && 'msg' in item
                ? `${(item as { loc?: string[] }).loc?.slice(-1)[0] ?? ''}: ${(item as { msg: string }).msg}`
                : String(item),
            )
            .join('; ');
        } else if (typeof body.message === 'string') {
          detail = body.message;
        }
      }
    } catch {
      // Response was not JSON
    }

    const message = detail ?? `HTTP ${response.status} ${response.statusText}`.trim();
    throw new ApiError(message, response.status, detail);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  async getHealth(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },

  async getChannels(): Promise<ChannelsResponse> {
    return request<ChannelsResponse>('/api/channels');
  },

  async getCatalog(): Promise<CatalogResponse> {
    return request<CatalogResponse>('/api/catalog');
  },

  async getSpectrum(raDeg: number, decDeg: number): Promise<CubeSpectrumResponse> {
    const query = new URLSearchParams({ ra: String(raDeg), dec: String(decDeg) });
    return request<CubeSpectrumResponse>(`/api/spectrum?${query.toString()}`);
  },

  async resolveRegion(region: RegionRequest): Promise<RegionResolveResponse> {
    return request<RegionResolveResponse>('/api/regions/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(region),
    });
  },

  async createJob(payload: JobCreateRequest): Promise<JobSnapshot> {
    return request<JobSnapshot>('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async getJob(id: string): Promise<JobSnapshot> {
    return request<JobSnapshot>(`/api/jobs/${encodeURIComponent(id)}`);
  },

  getFrameUrl(
    jobId: string,
    channel: number,
    product: ProductType,
    options?: {
      mode?: FrameRenderMode;
      epoch?: number;
      stretch?: StretchMode;
      bit?: number;
    },
  ): string {
    const params = new URLSearchParams();
    if (options?.mode) params.set('mode', options.mode);
    if (options?.epoch !== undefined) params.set('epoch', String(options.epoch));
    if (options?.stretch) params.set('stretch', options.stretch);
    if (options?.bit !== undefined && product === 'flags') params.set('bit', String(options.bit));

    const qs = params.toString();
    const base = `/api/jobs/${encodeURIComponent(jobId)}/frames/${channel}/${product}.png`;
    return qs ? `${base}?${qs}` : base;
  },

  async getPixel(
    jobId: string,
    params: { x: number; y: number; channel: number; epoch?: number },
  ): Promise<PixelReadout> {
    const query = new URLSearchParams({
      x: String(params.x),
      y: String(params.y),
      channel: String(params.channel),
    });
    if (params.epoch !== undefined) {
      query.set('epoch', String(params.epoch));
    }
    return request<PixelReadout>(
      `/api/jobs/${encodeURIComponent(jobId)}/pixel?${query.toString()}`,
    );
  },

  async getManifest(jobId: string): Promise<JobManifest> {
    return request<JobManifest>(`/api/jobs/${encodeURIComponent(jobId)}/manifest`);
  },

  async listSelections(params?: { limit?: number; before?: string }): Promise<SelectionListResponse> {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.before) query.set('before', params.before);
    const qs = query.toString();
    return request<SelectionListResponse>(qs ? `/api/selections?${qs}` : '/api/selections');
  },

  /** Set or clear (null) a selection's name; returns the updated record. */
  async renameSelection(id: string, name: string | null): Promise<SelectionSummary> {
    return request<SelectionSummary>(`/api/selections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },

  async deleteSelection(id: string): Promise<void> {
    return request<void>(`/api/selections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

/** Curated reference objects defined in PLANET_X_V3.md Section 4 */
export const CURATED_CATALOG_FALLBACK: CatalogObject[] = [
  {
    id: 'local-dr1-sample',
    name: 'Local DR1 sample',
    ra_deg: 270.693033,
    dec_deg: 61.876516,
    type: 'SPHEREx field',
    default_size_arcmin: 6,
    description: 'Covered by the local D2 FITS',
    precomputed: true,
  },
  {
    id: 'm101-field',
    name: 'M101 field',
    ra_deg: 210.80227,
    dec_deg: 54.34895,
    type: 'Galaxy field',
    default_size_arcmin: 6,
    description: 'Notebook TAP demo field (Pinwheel Galaxy)',
    precomputed: false,
  },
  {
    id: 'm81',
    name: "M81 (Bode's Galaxy)",
    ra_deg: 148.888221,
    dec_deg: 69.065294,
    type: 'Galaxy',
    default_size_arcmin: 6,
    description: 'Core of M81 at its J2000 position',
    precomputed: false,
  },
  {
    id: 'spherex-demo-field',
    name: 'SPHEREx demo field',
    ra_deg: 304.693509,
    dec_deg: 42.443687,
    type: 'SPHEREx field',
    default_size_arcmin: 6,
    description: 'Notebook SIA demo field',
    precomputed: false,
  },
  {
    id: 'wise-0855',
    name: 'WISE 0855−0714',
    ra_deg: 133.7951,
    dec_deg: -7.2451,
    type: 'Brown dwarf',
    default_size_arcmin: 6,
    description: 'Coldest known brown dwarf',
    precomputed: false,
  },
  {
    id: 'barnard',
    name: "Barnard's Star",
    ra_deg: 269.4521,
    dec_deg: 4.6934,
    type: 'Red dwarf',
    default_size_arcmin: 6,
    description: 'Highest known proper motion',
    precomputed: false,
  },
  {
    id: 'epsilon-indi',
    name: 'Epsilon Indi Ba/Bb',
    ra_deg: 330.8471,
    dec_deg: -56.7892,
    type: 'Brown dwarf pair',
    default_size_arcmin: 6,
    description: 'Nearby binary',
    precomputed: false,
  },
  {
    id: 'rw-aur',
    name: 'RW Aurigae',
    ra_deg: 77.8981,
    dec_deg: 30.3974,
    type: 'Variable star',
    default_size_arcmin: 6,
    description: 'Young T Tauri star',
    precomputed: false,
  },
  {
    id: 'r-dra',
    name: 'R Draconis',
    ra_deg: 248.1676,
    dec_deg: 66.755,
    type: 'Variable star',
    default_size_arcmin: 6,
    description: 'Mira variable',
    precomputed: false,
  },
];
