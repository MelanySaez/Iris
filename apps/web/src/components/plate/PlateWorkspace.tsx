import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { PreparingPlateCard } from '../PreparingPlateCard';
import { EpochTimeline, ProviderTrace } from './EpochTimeline';
import {
  BLANK_CHANNELS,
  channelToBand,
  channelToDetector,
  getNextAvailableChannel,
  isChannelAvailable,
  TOTAL_CHANNELS,
} from '../../channels';
import {
  formatAngle,
  formatDateIso,
  formatDec,
  formatFlux,
  formatRa,
  formatWavelength,
} from '../../format';
import type {
  ChannelsResponse,
  FrameRenderMode,
  JobCreateRequest,
  JobManifest,
  JobSnapshot,
  PixelReadout,
  ProductType,
  StretchMode,
} from '../../types';

interface PlateWorkspaceProps {
  job: JobSnapshot;
  pollError?: string | null;
  pollRetry?: { attempt: number; delaySeconds: number } | null;
  onRetryPoll?: () => void;
  onBackToSky: () => void;
  onRequestNewJob: (req: JobCreateRequest) => Promise<void>;
}

export function PlateWorkspace({
  job,
  pollError,
  pollRetry,
  onRetryPoll,
  onBackToSky,
  onRequestNewJob,
}: PlateWorkspaceProps) {
  // Navigation & selection state
  const [selectedChannel, setSelectedChannel] = useState<number>(() => {
    return job.channels?.[0]?.index ?? 44;
  });

  const [activeProduct, setActiveProduct] = useState<ProductType>('image');
  const [renderMode, setRenderMode] = useState<FrameRenderMode>('full');
  const [stretch, setStretch] = useState<StretchMode>('asinh');

  // Zoom and Pan
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const lastPanStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Pixel probing & pinning
  const [pinnedPixel, setPinnedPixel] = useState<{ x: number; y: number } | null>(null);
  const [hoverPixel, setHoverPixel] = useState<{ x: number; y: number } | null>(null);
  const [pixelData, setPixelData] = useState<PixelReadout | null>(null);
  const [pixelLoading, setPixelLoading] = useState(false);

  // Multi-epoch state
  const [epochA, setEpochA] = useState<number>(0);
  const [isSplit, setIsSplit] = useState(false);
  const [splitPos, setSplitPos] = useState<number>(50); // percentage 0..100

  // Provenance accordion & Manifest
  const [manifest, setManifest] = useState<JobManifest | null>(null);
  const [isManifestOpen, setIsManifestOpen] = useState(false);
  const [manifestLoading, setManifestLoading] = useState(false);

  // Product loading state (when adding variance or flags)
  const [loadingProduct, setLoadingProduct] = useState<ProductType | null>(null);
  const [switchingChannel, setSwitchingChannel] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);

  // Authoritative DR1 channel catalog (from /api/channels)
  const [channelsResponse, setChannelsResponse] = useState<ChannelsResponse | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);

  const stageImgRef = useRef<HTMLImageElement>(null);
  const railContainerRef = useRef<HTMLDivElement>(null);

  // Identify current detector from selectedChannel
  const currentDetectorNum = channelToBand(selectedChannel);
  const currentDetectorStr = channelToDetector(selectedChannel);

  // Cutouts for the current detector only. Never fall back to another
  // detector's cutout, which would mislabel the plate.
  const detectorCutouts = job.cutouts?.filter((c) => c.detector === currentDetectorNum && (c.channel === undefined || c.channel === selectedChannel)) ?? [];
  const hasCutout = detectorCutouts.length > 0;
  const activeCutout =
    detectorCutouts.find((c) => c.epoch === epochA) ?? detectorCutouts[0] ?? null;

  // Available epochs for current detector
  const channelFrames = job.frames?.filter(f => f.channel === selectedChannel && f.product === activeProduct) ?? [];
  const imageFrames = job.frames?.filter(f => f.channel === selectedChannel && f.product === 'image') ?? [];
  const timelineFrames = imageFrames.length ? imageFrames : channelFrames;
  const availableEpochs = [...new Set(channelFrames.map(f => f.epoch))];
  const currentEpoch = availableEpochs.includes(epochA) ? epochA : availableEpochs[0] ?? 0;
  const epochB = availableEpochs.find(epoch => epoch !== currentEpoch) ?? currentEpoch;

  // Frame descriptor behind the rendered image, used for exact dimensions and
  // the LVF channel window.
  const activeFrame =
    job.frames?.find(
      (f) => f.channel === selectedChannel && f.epoch === currentEpoch,
    ) ?? job.frames?.find((f) => f.channel === selectedChannel);

  // Cutout shape is [height, width]; the frame descriptor is width/height.
  const frameWidth = activeCutout?.shape?.[1] ?? activeFrame?.width ?? 0;
  const frameHeight = activeCutout?.shape?.[0] ?? activeFrame?.height ?? 0;

  // LVF overlap diagnostics: an empty channel window means the slice render is
  // legitimately all-dim, not a rendering failure.
  const selectedWindow = activeFrame?.window_um ?? null;
  const lvfKnown =
    !!activeCutout && activeCutout.wavelength_max_um > activeCutout.wavelength_min_um;
  const noChannelOverlap =
    !!activeCutout &&
    !!selectedWindow &&
    lvfKnown &&
    Math.min(selectedWindow[1], activeCutout.wavelength_max_um) <=
      Math.max(selectedWindow[0], activeCutout.wavelength_min_um);

  // Fetch the authoritative channel table for the rail.
  useEffect(() => {
    let active = true;
    void api
      .getChannels()
      .then((res) => {
        if (active) {
          setChannelsResponse(res);
          setChannelsError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setChannelsError(err instanceof ApiError ? (err.detail ?? err.message) : String(err));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  // Reset per-job transients when the plate switches to a different job.
  useEffect(() => {
    setManifest(null);
    setManifestLoading(false);
    setPixelData(null);
    setPinnedPixel(null);
    setHoverPixel(null);
    setChannelError(null);
    setEpochA(0);
    setIsSplit(false);
    const first = job.channels?.[0]?.index;
    if (first !== undefined) setSelectedChannel(first);
  }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Epoch ids belong to the selected channel; never request a nonexistent epoch 1.
  useEffect(() => {
    setEpochA(availableEpochs[0] ?? 0);
    setIsSplit(false);
  }, [selectedChannel, job.id]);

  // Load manifest when accordion opens
  useEffect(() => {
    if (!isManifestOpen || manifest || manifestLoading) return;
    setManifestLoading(true);
    void api
      .getManifest(job.id)
      .then((res) => {
        setManifest(res);
      })
      .catch((err) => {
        console.error('Failed to load manifest:', err);
      })
      .finally(() => {
        setManifestLoading(false);
      });
  }, [isManifestOpen, job.id, manifest, manifestLoading]);

  // Pixel probe query
  const pointerSample = useRef(hoverPixel);
  pointerSample.current = hoverPixel;
  const [sampledPixel, setSampledPixel] = useState(hoverPixel);
  useEffect(() => {
    const timer = window.setInterval(() => setSampledPixel(pointerSample.current), 120);
    return () => window.clearInterval(timer);
  }, []);
  const probeTarget = pinnedPixel ?? sampledPixel;
  useEffect(() => {
    if (!probeTarget) { setPixelData(null); setPixelLoading(false); return; }

    let active = true;
    if (!pixelData) setPixelLoading(true);

    const timer = window.setTimeout(() => {
      void api
        .getPixel(job.id, {
          x: probeTarget.x,
          y: probeTarget.y,
          channel: selectedChannel,
          epoch: currentEpoch,
        })
        .then((res) => {
          if (active) setPixelData(res);
        })
        .catch((err) => {
          console.error('Pixel fetch error:', err);
          if (active) setPixelData(null);
        })
        .finally(() => {
          if (active) setPixelLoading(false);
        });
    }, 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [probeTarget?.x, probeTarget?.y, selectedChannel, currentEpoch, job.id]);

  // Channel switching
  const handleSelectChannel = useCallback(
    async (targetChannel: number) => {
      if (!isChannelAvailable(targetChannel)) return;
      const previousChannel = selectedChannel;
      setSelectedChannel(targetChannel);
      setChannelError(null);

      const targetDetector = channelToBand(targetChannel);
      const hasDetectorCutout = job.cutouts?.some((c) => c.detector === targetDetector);

      // If already covered, frame switch is instant
      if (hasDetectorCutout) {
        return;
      }

      // Detector not yet loaded: create job with new channel
      try {
        setSwitchingChannel(true);
        await onRequestNewJob({
          ra_deg: job.region.ra_deg,
          dec_deg: job.region.dec_deg,
          size_arcmin: job.region.size_arcmin,
          channels: [targetChannel],
          products: job.products,
          mode: 'latest',
        });
      } catch (err) {
        const msg = err instanceof ApiError ? (err.detail ?? err.message) : String(err);
        setSelectedChannel(previousChannel);
        setChannelError(msg || `No DR1 product for D${targetDetector} covers this region`);
      } finally {
        setSwitchingChannel(false);
      }
    },
    [job, onRequestNewJob, selectedChannel],
  );

  // Keyboard navigation for channels
  const handleRailKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = getNextAvailableChannel(selectedChannel, -1);
      void handleSelectChannel(prev);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = getNextAvailableChannel(selectedChannel, 1);
      void handleSelectChannel(next);
    }
  };

  // Optional product loader
  const handleLoadProduct = async (product: ProductType) => {
    try {
      setLoadingProduct(product);
      await onRequestNewJob({
        ra_deg: job.region.ra_deg,
        dec_deg: job.region.dec_deg,
        size_arcmin: job.region.size_arcmin,
        channels: [selectedChannel],
        products: Array.from(new Set([...job.products, product])),
        mode: 'latest',
      });
      setActiveProduct(product);
    } catch (err) {
      console.error(`Failed to load product ${product}:`, err);
    } finally {
      setLoadingProduct(null);
    }
  };

  // Pixel pointer tracking
  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      setPan({
        x: e.clientX - lastPanStartRef.current.x,
        y: e.clientY - lastPanStartRef.current.y,
      });
      return;
    }

    const img = stageImgRef.current;
    if (!img) return;

    const rect = img.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      if (!pinnedPixel) setHoverPixel(null);
      return;
    }

    const shape = activeCutout?.shape ?? [frameHeight, frameWidth];
    // Backend shape is [height, width]: X maps to width (shape[1]), Y to height (shape[0]).
    const width = shape[1];
    const height = shape[0];
    if (width <= 0 || height <= 0) return;
    const px = Math.min(
      width - 1,
      Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * width)),
    );
    const py = Math.min(
      height - 1,
      Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * height)),
    );

    setHoverPixel({ x: px, y: py });
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // If middle click or space drag: pan
    if (e.button === 1 || e.shiftKey) {
      isDraggingRef.current = true;
      lastPanStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const handleStagePointerUp = () => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      return;
    }

    // Click pins or unpins pixel
    if (hoverPixel) {
      if (pinnedPixel && pinnedPixel.x === hoverPixel.x && pinnedPixel.y === hoverPixel.y) {
        setPinnedPixel(null);
      } else {
        setPinnedPixel(hoverPixel);
      }
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom((z) => Math.min(10, Math.max(0.5, z * factor)));
  };

  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPinnedPixel(null);
  };

  // Frame URL
  const frameUrl = api.getFrameUrl(job.id, selectedChannel, activeProduct, {
    mode: renderMode,
    epoch: currentEpoch,
    stretch,
  });

  const frameUrlEpochB =
    isSplit && availableEpochs.length >= 2
      ? api.getFrameUrl(job.id, selectedChannel, activeProduct, {
          mode: renderMode,
          epoch: epochB,
          stretch,
        })
      : null;

  // Inverted grayscale filter applies only to image & variance, NEVER to flags
  const shouldInvert = activeProduct === 'image' || activeProduct === 'variance';

  return (
    <div className="plate-workspace">
      {/* Dark Ribbon at top */}
      <nav className="plate-ribbon" aria-label="Plate navigation ribbon">
        <div className="ribbon-left">
          <button
            type="button"
            className="ribbon-back-btn"
            onClick={onBackToSky}
            title="Return to Sky mosaic without resetting"
          >
            ← Sky
          </button>
          <span className="ribbon-plate-id num">PLATE // {job.id}</span>
        </div>
        <div className="ribbon-center">
          <span className="ribbon-collection">SPHEREx DR1 Level-2 Spectral Image</span>
        </div>
        <div className="ribbon-right">
          <span className="ribbon-status-badge">
            {job.status === 'ready' ? 'Ready' : job.stage || job.status}
          </span>
        </div>
      </nav>

      {/* Main 3-column Grid */}
      <div className="plate-columns-layout">
        {/* Column 1: Plate Sheet (260 px) */}
        <aside className="plate-sheet" aria-label="Plate Metadata Sheet">
          <div className="sheet-header">
            <h2 className="sheet-title">Plate Record</h2>
            <span className="sheet-badge num">{currentDetectorStr}</span>
          </div>

          <div className="sheet-section">
            <h3 className="section-label">Target Region</h3>
            <div className="meta-pair">
              <span className="meta-key">Center</span>
              <span className="meta-val num">
                {formatRa(job.region.ra_deg)}, {formatDec(job.region.dec_deg)}
              </span>
            </div>
            <div className="meta-pair">
              <span className="meta-key">FOV</span>
              <span className="meta-val num">
                {formatAngle(job.region.size_arcmin / 60)} ({job.region.size_arcmin.toFixed(1)}′)
              </span>
            </div>
          </div>

          <div className="sheet-section">
            <h3 className="section-label">Detector Cutout</h3>
            <div className="meta-pair">
              <span className="meta-key">Detector</span>
              <span className="meta-val num">{currentDetectorStr}</span>
            </div>
            <div className="meta-pair">
              <span className="meta-key">Obs ID</span>
              <span className="meta-val num text-truncate" title={activeCutout?.obs_id ?? '—'}>
                {activeCutout?.obs_id ?? '—'}
              </span>
            </div>
            <div className="meta-pair">
              <span className="meta-key">Date</span>
              <span className="meta-val num">{formatDateIso(activeCutout?.date_iso)}</span>
            </div>
            <div className="meta-pair">
              <span className="meta-key">Source</span>
              <span className="meta-val chip-source">{activeCutout?.source ?? '—'}</span>
            </div>
            <div className="meta-pair">
              <span className="meta-key">Pixel Scale</span>
              <span className="meta-val num">
                {activeCutout?.pixel_scale_arcsec != null
                  ? `${activeCutout.pixel_scale_arcsec.toFixed(2)}″/px`
                  : '—'}
              </span>
            </div>
            <div className="meta-pair">
              <span className="meta-key">Units</span>
              <span className="meta-val num">
                {activeCutout
                  ? `${activeCutout.image_unit} / ${activeCutout.variance_unit}`
                  : '—'}
              </span>
            </div>
          </div>

          {/* Explicit WCS-WAVE statement */}
          <div className="sheet-notice-box">
            <p className="notice-text">
              <strong>WCS-WAVE approximate:</strong> Level-2 spectral images exhibit position-dependent LVF wavelength. Calibrated CWAVE/CBAND maps are not loaded in this visualization.
            </p>
          </div>

          {/* Flag bit legend */}
          <div className="sheet-section">
            <h3 className="section-label">Flag Bit Legend</h3>
            <div className="flag-legend-list">
              {activeCutout?.flag_bits && activeCutout.flag_bits.length > 0 ? (
                activeCutout.flag_bits.map((bit) => (
                  <div key={bit.bit} className="flag-legend-item">
                    <div className="flag-item-header">
                      <span className="flag-bit-index num">Bit {bit.bit}</span>
                      <strong className="flag-bit-name">{bit.name}</strong>
                    </div>
                    <p className="flag-bit-desc">
                      {bit.name === 'MP_SOURCE'
                        ? 'Pixel mapped to a known astronomical source (standard detection, not a defect).'
                        : bit.description}
                    </p>
                  </div>
                ))
              ) : (
                <p className="muted-text">
                  Flag definitions are not available for this cutout. Re-run the job to
                  parse the FITS flag headers.
                </p>
              )}
            </div>
          </div>

          {/* Collapsible Provenance block */}
          <details
            className="sheet-provenance-details"
            open={isManifestOpen}
            onToggle={(e) => setIsManifestOpen(e.currentTarget.open)}
          >
            <summary className="provenance-summary">Provenance & Manifest</summary>
            <div className="provenance-content">
              {manifestLoading ? (
                <p className="loading-text">Loading DR1 manifest...</p>
              ) : manifest ? (
                <div className="manifest-fields">
                  <div className="meta-pair">
                    <span className="meta-key">Release</span>
                    <span className="meta-val">{manifest.release}</span>
                  </div>
                  <div className="meta-pair">
                    <span className="meta-key">Status</span>
                    <span className="meta-val num">{manifest.lvf_status}</span>
                  </div>
                  <div className="meta-pair">
                    <span className="meta-key">Cache Hit</span>
                    <span className="meta-val num">{manifest.cache?.hit ? 'Yes' : 'No'}</span>
                  </div>
                  {manifest.notes?.length > 0 && (
                    <div className="manifest-notes">
                      <strong>Notes:</strong>
                      <ul>
                        {manifest.notes.map((note, i) => (
                          <li key={i}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="muted-text">Open to view provenance data from DR1 manifest.</p>
              )}
            </div>
          </details>
        </aside>

        {/* Column 2: Plate Stage (Center) */}
        <main className="plate-stage" aria-label="Plate Viewport">
          {/* Controls Bar */}
          <div className="stage-controls-bar">
            {/* Left: Product tabs (underlined text tabs) */}
            <div className="stage-product-tabs" role="tablist" aria-label="Cutout Products">
              <button
                type="button"
                role="tab"
                className={`product-tab ${activeProduct === 'image' ? 'active' : ''}`}
                aria-selected={activeProduct === 'image'}
                onClick={() => setActiveProduct('image')}
              >
                IMAGE
              </button>
              {job.products.includes('variance') ? (
                <button
                  type="button"
                  role="tab"
                  className={`product-tab ${activeProduct === 'variance' ? 'active' : ''}`}
                  aria-selected={activeProduct === 'variance'}
                  onClick={() => setActiveProduct('variance')}
                >
                  VARIANCE
                </button>
              ) : (
                <button
                  type="button"
                  className="product-tab tab-action"
                  disabled={loadingProduct === 'variance'}
                  onClick={() => void handleLoadProduct('variance')}
                >
                  {loadingProduct === 'variance' ? 'Loading…' : '+ Load Variance'}
                </button>
              )}
              {job.products.includes('flags') ? (
                <button
                  type="button"
                  role="tab"
                  className={`product-tab ${activeProduct === 'flags' ? 'active' : ''}`}
                  aria-selected={activeProduct === 'flags'}
                  onClick={() => setActiveProduct('flags')}
                >
                  FLAGS
                </button>
              ) : (
                <button
                  type="button"
                  className="product-tab tab-action"
                  disabled={loadingProduct === 'flags'}
                  onClick={() => void handleLoadProduct('flags')}
                >
                  {loadingProduct === 'flags' ? 'Loading…' : '+ Load Flags'}
                </button>
              )}
            </div>

            {/* Center: Mode Switch & Stretch */}
            <div className="stage-mode-switches">
              <div className="switch-group" role="group" aria-label="Render Mode">
                <button
                  type="button"
                  className={`mode-btn ${renderMode === 'full' ? 'active' : ''}`}
                  aria-pressed={renderMode === 'full'}
                  onClick={() => setRenderMode('full')}
                >
                  Full Detector
                </button>
                <button
                  type="button"
                  className={`mode-btn ${renderMode === 'slice' ? 'active' : ''}`}
                  aria-pressed={renderMode === 'slice'}
                  title="LVF channel window slice: channel pixels opaque, context dim"
                  onClick={() => setRenderMode('slice')}
                >
                  Channel Slice
                </button>
              </div>

              <div className="stretch-select-wrap">
                <label htmlFor="stretch-select">Stretch</label>
                <select
                  id="stretch-select"
                  className="stretch-select"
                  value={stretch}
                  onChange={(e) => setStretch(e.target.value as StretchMode)}
                >
                  <option value="asinh">asinh</option>
                  <option value="linear">linear</option>
                </select>
              </div>
            </div>

            {/* Right: View Reset & Zoom */}
            <div className="stage-zoom-controls">
              <button
                type="button"
                className="zoom-btn"
                title="Zoom in"
                onClick={() => setZoom((z) => Math.min(10, z * 1.25))}
              >
                +
              </button>
              <button
                type="button"
                className="zoom-btn"
                title="Zoom out"
                onClick={() => setZoom((z) => Math.max(0.5, z * 0.8))}
              >
                −
              </button>
              <button
                type="button"
                className="zoom-btn reset-btn"
                title="Reset zoom & pan"
                onClick={handleResetView}
              >
                Reset
              </button>
            </div>
          </div>

          {/* Charcoal Matte Viewport */}
          <div
            className="plate-viewport-matte"
            onPointerMove={handleStagePointerMove}
            onPointerDown={handleStagePointerDown}
            onPointerUp={handleStagePointerUp}
            onWheel={handleWheel}
          >
            {/* Top-left FOV Label */}
            <div className="viewport-fov-label num">
              {job.region.size_arcmin.toFixed(1)}′ × {job.region.size_arcmin.toFixed(1)}′
            </div>

            {/* Switching / Loading Skeleton */}
            {switchingChannel && (
              <div className="plate-loading-skeleton" role="status" aria-live="polite">
                <div className="skeleton-box" />
                <span className="skeleton-label">Switching detector cutout...</span>
              </div>
            )}

            {/* Channel error overlay */}
            {channelError && (
              <div className="plate-channel-error" role="alert">
                <p>{channelError}</p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setChannelError(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* LVF overlap diagnostics */}
            {hasCutout && selectedWindow && !lvfKnown && (
              <div className="plate-lvf-warning" role="note">
                LVF wavelength coverage is unavailable for this cutout, so the channel
                slice cannot be validated. The full detector image remains valid.
              </div>
            )}
            {hasCutout && selectedWindow && noChannelOverlap && activeCutout && (
              <div className="plate-lvf-warning" role="note">
                <strong>No channel overlap.</strong> Channel {selectedChannel} covers{' '}
                {selectedWindow[0].toFixed(4)}–{selectedWindow[1].toFixed(4)} µm, but this
                cutout&apos;s LVF spans {activeCutout.wavelength_min_um.toFixed(4)}–
                {activeCutout.wavelength_max_um.toFixed(4)} µm. Channel Slice is empty by
                definition; the full detector image is still valid.
              </div>
            )}

            {/* Canvas / Cutout Image container with transform */}
            {hasCutout ? (
              <div
                className="cutout-transform-container"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                }}
              >
                {/* Normal cutout or Epoch A image */}
                <img
                  ref={stageImgRef}
                  src={frameUrl}
                  alt={`SPHEREx ${activeProduct} cutout`}
                  className={`cutout-img ${shouldInvert ? 'invert-plate' : ''}`}
                  draggable={false}
                />

                {/* Split screen overlay for Epoch B if active */}
                {isSplit && frameUrlEpochB && (
                  <div
                    className="split-overlay-container"
                    style={{
                      clipPath: `polygon(${splitPos}% 0, 100% 0, 100% 100%, ${splitPos}% 100%)`,
                    }}
                  >
                    <img
                      src={frameUrlEpochB}
                      alt={`Epoch B ${activeProduct} cutout`}
                      className={`cutout-img ${shouldInvert ? 'invert-plate' : ''}`}
                      draggable={false}
                    />
                  </div>
                )}

                {/* Draggable split divider line */}
                {isSplit && (
                  <div className="split-divider-line" style={{ left: `${splitPos}%` }}>
                    <span className="split-handle">↔</span>
                  </div>
                )}

                {/* Pixel Probe Crosshair (X = width, Y = height) */}
                {probeTarget && frameWidth > 0 && frameHeight > 0 && (
                  <div
                    className={`probe-crosshair ${pinnedPixel ? 'pinned' : ''}`}
                    style={{
                      left: `${((probeTarget.x + 0.5) / frameWidth) * 100}%`,
                      top: `${((probeTarget.y + 0.5) / frameHeight) * 100}%`,
                    }}
                    aria-hidden="true"
                  >
                    <div className="crosshair-ch-h" />
                    <div className="crosshair-ch-v" />
                    <div className="crosshair-ring" />
                  </div>
                )}
              </div>
            ) : job.status !== 'ready' && job.status !== 'failed' ? (
              <div className="plate-loading-skeleton" role="status" aria-label="Preparing spectral cutout">
                <div className="skeleton-box" aria-hidden="true" />
                <span className="skeleton-label">{job.stage || 'Preparing spectral cutout…'}</span>
              </div>
            ) : job.status === 'failed' ? (
              <div className="plate-cutout-missing">
                <h3>Cutout preparation failed</h3>
                <p>See the failure and retry controls in the spectral rail.</p>
              </div>
            ) : (
              <div className="plate-cutout-missing" role="status">
                <h3>No {currentDetectorStr} cutout loaded</h3>
                <p>
                  This detector has not been prepared for the selected region. The plate is
                  not showing another detector&apos;s data.
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={switchingChannel}
                  onClick={() => void handleSelectChannel(selectedChannel)}
                >
                  {switchingChannel ? 'Preparing…' : `Prepare ${currentDetectorStr} cutout`}
                </button>
              </div>
            )}

            {/* Split slider control when split active */}
            {isSplit && (
              <div className="split-slider-dock">
                <span>Epoch {epochA}</span>
                <input
                  type="range"
                  min={5}
                  max={95}
                  value={splitPos}
                  onChange={(e) => setSplitPos(Number(e.target.value))}
                  aria-label="Epoch split slider"
                />
                <span>Epoch {epochB}</span>
              </div>
            )}
          </div>

          {/* Chronological, channel-specific comparison controls. */}
          <div className="stage-epoch-strip">
            <EpochTimeline jobId={job.id} channel={selectedChannel} frames={timelineFrames}
              ready={job.status === 'ready'} epoch={currentEpoch} onSelect={setEpochA}
              onPlaybackStart={() => setIsSplit(false)} reason={job.animation_reason} paused={isSplit} />
            {availableEpochs.length >= 2 && <button type="button"
              className={`btn-epoch-toggle ${isSplit ? 'active' : ''}`} aria-pressed={isSplit}
              onClick={() => setIsSplit(s => !s)}>Split View</button>}
          </div>
        </main>

        {/* Column 3: Spectral Rail (300 px) */}
        <aside
          ref={railContainerRef}
          className="spectral-rail"
          tabIndex={0}
          onKeyDown={handleRailKeyDown}
          aria-label="102-channel spectral rail"
        >
          {pollError && (
            <div className="plate-poll-alert" role="alert">
              <strong>Job updates interrupted</strong>
              <p>{pollError}</p>
              <p>{pollRetry ? `Next poll scheduled after ${pollRetry.delaySeconds}s · retry ${pollRetry.attempt} of 4` : 'Automatic polling stopped.'}</p>
              {!pollRetry && <button type="button" onClick={onRetryPoll}>Try again</button>}
            </div>
          )}
          {job.status !== 'ready' && (
            <PreparingPlateCard
              embedded
              job={job}
              onOpenPlate={() => {}}
              onRetry={() => void onRequestNewJob(job.request)}
            />
          )}
          <ProviderTrace events={job.events ?? []} />
          <div className="rail-header">
            <h2 className="rail-title">Spectral Channels</h2>
            <span className="rail-instructions">Use ↑ / ↓ arrow keys</span>
            <span className={`rail-source ${channelsError ? 'error' : ''}`}>
              {channelsResponse
                ? `${channelsResponse.source.collection} · ${channelsResponse.cached ? 'cached' : 'live'}`
                : channelsError
                  ? 'Channel table unavailable'
                  : 'Loading channel table…'}
            </span>
          </div>

          {/* Vertical Channel List (authoritative /api/channels data) */}
          <div className="channel-vertical-list" role="listbox" aria-label="Channels">
            {Array.from({ length: TOTAL_CHANNELS }, (_, i) => {
              const info = channelsResponse?.channels[i];
              const isBlank = channelsResponse
                ? channelsResponse.source.blank_channels.includes(i)
                : BLANK_CHANNELS.has(i);
              const isSelected = i === selectedChannel;
              const detector = info?.detector ?? channelToDetector(i);

              return (
                <button
                  key={i}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={isBlank}
                  className={`channel-rail-item ${isSelected ? 'selected' : ''} ${
                    isBlank ? 'blank' : ''
                  }`}
                  title={`HiPS channel index ${i}`}
                  onClick={() => void handleSelectChannel(i)}
                >
                  <span className="ch-index num">{i}</span>
                  <span className="ch-wave num">
                    {info ? `${info.wavelength_um.toFixed(3)} µm` : '—'}
                  </span>
                  <span className="ch-det num">{detector}</span>
                  {isBlank ? (
                    <span className="ch-blank-badge">Blank</span>
                  ) : (
                    <span className="ch-band num">{info ? `B${info.band}` : '—'}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Live Pixel Readout Card */}
          <div className="pixel-readout-card" aria-live="polite">
            <div className="readout-header">
              <h3 className="readout-title">Pixel Readout</h3>
              {probeTarget ? (
                <span className="readout-coords num">
                  ({probeTarget.x}, {probeTarget.y})
                  {pinnedPixel && <span className="pinned-badge">Pinned</span>}
                </span>
              ) : (
                <span className="readout-empty-hint">Hover or click pixel</span>
              )}
            </div>

            {pixelLoading ? (
              <div className="pixel-readout-skeleton">Sampling detector values…</div>
            ) : pixelData ? (
              <div className="readout-grid">
                <div className="readout-item">
                  <span className="item-label">λ (WCS-WAVE)</span>
                  <span className="item-val num highlight">
                    {formatWavelength(pixelData.wavelength_um)}
                  </span>
                </div>
                <div className="readout-item">
                  <span className="item-label">Δλ Bandwidth</span>
                  <span className="item-val num">
                    {pixelData.bandwidth_um ? `±${(pixelData.bandwidth_um / 2).toFixed(4)} µm` : '—'}
                  </span>
                </div>
                {pixelData.window_um && (
                  <div className="readout-item span-2">
                    <span className="item-label">Channel Window</span>
                    <span className="item-val num">
                      [{pixelData.window_um[0].toFixed(3)} .. {pixelData.window_um[1].toFixed(3)} µm]
                      {pixelData.in_channel ? (
                        <span className="in-window-badge">In Channel</span>
                      ) : (
                        <span className="out-window-badge">Context</span>
                      )}
                    </span>
                  </div>
                )}
                <div className="readout-item">
                  <span className="item-label">IMAGE</span>
                  <span className="item-val num">{formatFlux(pixelData.image, 'MJy/sr')}</span>
                </div>
                <div className="readout-item">
                  <span className="item-label">VARIANCE</span>
                  <span className="item-val num">{formatFlux(pixelData.variance, 'MJy²/sr²')}</span>
                </div>
                <div className="readout-item span-2">
                  <span className="item-label">FLAGS</span>
                  <span className="item-val num">
                    {pixelData.flags != null ? `0x${pixelData.flags.toString(16).toUpperCase()}` : '0'}
                  </span>
                  {pixelData.flag_bits && pixelData.flag_bits.length > 0 && (
                    <div className="active-flag-chips">
                      {pixelData.flag_bits.map((fb) => (
                        <span key={fb.bit} className="flag-chip" title={fb.description}>
                          {fb.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="readout-placeholder">
                Move pointer over the cutout to inspect WCS-WAVE wavelength and flux. Click to pin.
              </p>
            )}

            <div className="readout-footer-note">
              {activeFrame?.calibrated ? 'Verified CWAVE/CBAND calibration · channel-specific mosaic.' : 'WCS-WAVE is approximate; calibrated CWAVE/CBAND is not loaded.'}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
