export type ProductType = 'image' | 'variance' | 'flags';
export type JobStatus =
  | 'queued'
  | 'discovering'
  | 'downloading'
  | 'extracting'
  | 'rendering'
  | 'ready'
  | 'failed';

export type JobMode = 'latest' | 'history';
export type StretchMode = 'asinh' | 'linear';
export type FrameRenderMode = 'full' | 'slice';

export interface HealthResponse {
  status: string;
  version: string;
  products: string[];
  local_assets: boolean;
  network: string;
}

export interface ChannelInfo {
  index: number;
  band: number;
  detector: string;
  wavelength_um: number;
  bandwidth_um: number;
  available: boolean;
}

export interface ChannelsResponse {
  source: {
    collection: string;
    properties_url: string;
    depth: number;
    order: number;
    blank_channels: number[];
  };
  channels: ChannelInfo[];
  cached: boolean;
}

export interface CatalogObject {
  id: string;
  name: string;
  ra_deg: number;
  dec_deg: number;
  type: string;
  default_size_arcmin: number;
  description?: string;
  precomputed?: boolean;
}

export interface CatalogResponse {
  objects: CatalogObject[];
}

export interface RegionRequest {
  ra_deg: number;
  dec_deg: number;
  size_arcmin: number;
}

export interface RegionResolveResponse {
  region: {
    ra_deg: number;
    dec_deg: number;
    size_arcmin: number;
    fov_deg: number;
  };
  coverage: 'available' | 'none' | 'unknown';
  cached: boolean;
  query_ms: number;
  warning: string | null;
  products: Array<{
    id: string;
    source: 'local' | 'remote';
    detector: number;
    band: string;
    obs_id: string;
    uri: string;
    date_mjd: number;
    date_iso: string;
  }>;
  detectors: Array<{
    detector: number;
    band: string;
    count: number;
    epochs: Array<{
      date_mjd: number;
      date_iso: string;
      product_id: string;
    }>;
  }>;
  notes: string[];
}

/** How the Sky map showed the region when it was selected (display only, not part of the job id). */
export type JobView = { mode: 'single'; rgb?: null } | { mode: 'rgb'; rgb: [number, number, number] };

export interface JobCreateRequest {
  ra_deg: number;
  dec_deg: number;
  size_arcmin: number;
  channels: number[];
  products: ProductType[];
  mode?: JobMode;
  stretch?: StretchMode;
  view?: JobView;
}

export interface FlagBit {
  bit: number;
  name: string;
  description: string;
}

export interface JobCutout {
  detector: number;
  epoch: number;
  obs_id: string;
  date_iso: string;
  source: 'local' | 'remote';
  uri?: string;
  version?: string;
  shape: [number, number];
  pixel_scale_arcsec: number;
  wavelength_min_um: number;
  wavelength_max_um: number;
  bandwidth_median_um: number;
  image_unit: string;
  variance_unit: string;
  flags_defined: boolean;
  flag_bits: FlagBit[];
}

export interface JobFrame {
  channel: number;
  product: ProductType;
  detector: number;
  epoch: number;
  obs_id: string;
  date_iso: string;
  source: 'local' | 'remote';
  width: number;
  height: number;
  url: string;
  slice_url: string;
  wavelengths_url?: string;
  window_um: [number, number];
}

export interface JobSnapshot {
  id: string;
  status: JobStatus;
  progress: number;
  stage: string;
  events?: JobEvent[];
  error: string | null;
  failed_stage?: string | null;
  error_kind?: string | null;
  error_trace?: string | null;
  request_id?: string | null;
  request: JobCreateRequest;
  region: {
    ra_deg: number;
    dec_deg: number;
    size_arcmin: number;
    fov_deg: number;
  };
  channels: Array<{
    index: number;
    wavelength_um: number;
    bandwidth_um: number;
    detector: number | string;
    available: boolean;
  }>;
  products: ProductType[];
  frames: JobFrame[];
  cutouts: JobCutout[];
  cache: { hit: boolean };
  wavelength_status: string;
  calibrated: boolean;
  multi_product_mosaic: string;
}

export interface JobEvent {
  stage: string;
  at: number;
  event_type?: string;
  provider?: string;
  attempt?: number;
  max_attempts?: number;
  outcome?: 'started' | 'succeeded' | 'failed';
  will_retry?: boolean;
  retry_after_seconds?: number | null;
  detail?: string;
  result_count?: number;
}

export interface PixelReadout {
  x: number;
  y: number;
  channel: number;
  epoch: number;
  wavelength_um: number | null;
  bandwidth_um: number | null;
  window_um?: [number, number];
  in_channel?: boolean;
  image?: number | null;
  variance?: number | null;
  flags?: number | null;
  flag_bits?: FlagBit[];
  wavelength_status?: string;
  calibrated?: boolean;
}

export interface ManifestCutout {
  detector: number;
  epoch: number;
  obs_id: string;
  source: string;
  uri: string;
  version: string;
  date_obs: string;
  date_mjd: number;
  units: Record<string, string>;
  flag_bits: FlagBit[];
  pixel_scale_arcsec: number;
  shape: [number, number];
}

export interface JobManifest {
  job_id: string;
  request: JobCreateRequest;
  region: {
    ra_deg: number;
    dec_deg: number;
    size_arcmin: number;
    fov_deg?: number;
  };
  products: ProductType[];
  release: string;
  dates: string[];
  units: {
    image: string;
    variance: string;
  };
  lvf_status: string;
  wavelength_status: string;
  calibrated: boolean;
  flag_definitions: FlagBit[];
  cache: { hit: boolean };
  multi_product_mosaic: string;
  collection: string;
  cutouts: ManifestCutout[];
  notes: string[];
}

export interface CubeSpectrumPoint {
  channel: number;
  detector: number;
  subchannel: number;
  wavelength_um: number;
  bandwidth_um: number;
  wl_min_um: number;
  wl_max_um: number;
  value: number | null;
  nhits: number;
  flags: number;
  available: boolean;
}

export interface CubeSpectrumResponse {
  ra_deg: number;
  dec_deg: number;
  unit: string;
  source: string;
  tile: { order: number; npix: number; x: number; y: number; url: string };
  date_beg: string;
  date_end: string;
  quick_look: boolean;
  calibrated: boolean;
  notes: string[];
  points: CubeSpectrumPoint[];
}

export type SelectionCoverage = 'available' | 'none' | 'unknown';

export interface SelectionEvent {
  stage: string;
  /** Epoch seconds. */
  at: number;
}

export interface SelectionSummary {
  id: string;
  job_id: string;
  region: {
    ra_deg: number;
    dec_deg: number;
    size_arcmin: number;
    fov_deg: number;
    coverage: SelectionCoverage;
    checked_at: string;
  };
  channels: number[];
  products: ProductType[];
  mode: 'latest' | 'history';
  stretch: StretchMode;
  job_status: JobStatus;
  job_error: string | null;
  failed_stage: string | null;
  error_kind: string | null;
  error_trace: string | null;
  job_events: SelectionEvent[] | null;
  /** View recorded by the backend at the latest submission that sent one. */
  view_mode: 'single' | 'rgb' | null;
  rgb_channels: number[] | null;
  /** User label shown in Records; null when unnamed. */
  name: string | null;
  hits: number;
  created_at: string;
  last_seen_at: string;
}

export interface SelectionListResponse {
  items: SelectionSummary[];
  next_before: string | null;
}

/** Answer of GET /api/resolve: where a named object or catalogue code is. */
export interface ResolvedName {
  query: string;
  name: string;
  ra_deg: number;
  dec_deg: number;
  object_type: string | null;
  /** Major axis in arcmin from SIMBAD; null for point sources. */
  size_arcmin?: number | null;
  source: 'simbad' | 'ned' | 'designation';
  /** The same name as answered by other catalogues (NED when SIMBAD is the main answer). */
  alternatives?: ResolvedAlternative[];
  cached: boolean;
}

export interface ResolvedAlternative {
  name: string;
  ra_deg: number;
  dec_deg: number;
  object_type: string | null;
  size_arcmin?: number | null;
  source: 'simbad' | 'ned';
}
