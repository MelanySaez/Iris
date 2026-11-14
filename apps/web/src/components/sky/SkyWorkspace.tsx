import { useCallback, useEffect, useRef, useState } from 'react';
import Aladin, { type AladinViewer } from 'aladin-lite';
import { api, CURATED_CATALOG_FALLBACK } from '../../api';
import {
  channelToBand,
  channelToDetector,
  DEFAULT_CHANNEL_INDEX,
  DEFAULT_CHANNELS,
  getNextAvailableChannel,
  isChannelAvailable,
  TOTAL_CHANNELS,
} from '../../channels';
import { formatAngle, formatDec, formatRa, formatWavelength } from '../../format';
import {
  channelVirtualHipsUrl,
  imagePropertiesFromCube,
  parseChannels,
  SPHEREX_HIPS_ROOT,
  type SpectralChannel,
} from '../../hips';
import { setChannelImageLayer } from '../../aladinView';
import { useRgbComposite } from '../../hooks/useRgbComposite';
import { RgbControls } from './RgbControls';
import {
  computeRegionFromPoints,
  moveRegion,
  REGION_EXCEEDS_LIMIT_MESSAGE,
  resizeRegion,
  validateCoordinates,
} from '../../region';
import type { CatalogObject, JobCreateRequest, JobSnapshot, RegionRequest } from '../../types';

interface SkyWorkspaceProps {
  activeJob: JobSnapshot | null;
  onStartJob: (req: JobCreateRequest) => Promise<void>;
  onOpenPlate: (jobId: string) => void;
  onRetryJob: () => void;
}

interface RecentSelection {
  id: string;
  name: string;
  ra_deg: number;
  dec_deg: number;
  size_arcmin: number;
  timestamp: number;
}

const RECENT_KEY = 'planetx_recent_selections';

function getRecentSelections(): RecentSelection[] {
  try {
    const raw = sessionStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentSelection[]) : [];
  } catch {
    return [];
  }
}

function saveRecentSelection(item: Omit<RecentSelection, 'timestamp'>) {
  try {
    const list = getRecentSelections().filter((i) => i.id !== item.id);
    list.unshift({ ...item, timestamp: Date.now() });
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 4)));
  } catch {
    // SessionStorage unavailable or full
  }
}

function workerMessage(worker: ServiceWorker, properties: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => reject(new Error('HiPS adapter did not respond')), 5000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      if (event.data?.ok) resolve();
      else reject(new Error('HiPS adapter rejected metadata'));
    };
    worker.postMessage({ type: 'SYNC_PROPERTIES', properties }, [channel.port2]);
  });
}

function waitForControl(): Promise<void> {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      resolve();
    };
    const timer = window.setTimeout(done, 2500);
    navigator.serviceWorker.addEventListener('controllerchange', done);
  });
}

export function SkyWorkspace({
  activeJob,
  onStartJob,
  onOpenPlate,
}: SkyWorkspaceProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<AladinViewer | null>(null);

  const [aladinReady, setAladinReady] = useState(false);
  const [aladinStatus, setAladinStatus] = useState('Loading DR1 All-Sky Cube HiPS metadata...');
  const [channels, setChannels] = useState<SpectralChannel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<number>(DEFAULT_CHANNEL_INDEX);
  const [mode, setMode] = useState<'pan' | 'region'>('pan');

  const [centerCoords, setCenterCoords] = useState<[number, number]>([0, 0]);
  const [currentFov, setCurrentFov] = useState<number>(180);
  const [projection, setProjection] = useState('SIN');
  const [cursorCoords, setCursorCoords] = useState<[number, number] | null>(null);
  const lastCursorUpdate = useRef(0);
  const channelRef = useRef(DEFAULT_CHANNEL_INDEX);
  const [tileStatus, setTileStatus] = useState('Loading tiles');

  // Catalog & Search
  const [catalog, setCatalog] = useState<CatalogObject[]>(CURATED_CATALOG_FALLBACK);
  const [searchQuery, setSearchQuery] = useState('');
  const [recentSelections, setRecentSelections] = useState<RecentSelection[]>(getRecentSelections());

  // Coordinate form
  const [raInput, setRaInput] = useState('270.69303');
  const [decInput, setDecInput] = useState('61.87652');
  const [sizeInput, setSizeInput] = useState('6');
  const [coordError, setCoordError] = useState<string | null>(null);

  // Region selection UI state
  const dragStartPoint = useRef<[number, number] | null>(null);
  const dragStartWorld = useRef<[number, number] | null>(null);
  const [selectionBox, setSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<RegionRequest | null>(null);
  // A drawn or adjusted region stays a draft until the user confirms it.
  const [regionConfirmed, setRegionConfirmed] = useState(true);
  const regionEdit = useRef<{
    kind: 'move' | 'resize';
    startWorld: [number, number];
    startRegion: RegionRequest;
  } | null>(null);
  const [projectedRegion, setProjectedRegion] = useState<[number, number][] | null>(null);
  const [regionError, setRegionError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedRegion) { setProjectedRegion(null); return; }
    const draw = () => {
      const v = viewerRef.current;
      if (!v?.world2pix) return;
      const half = selectedRegion.size_arcmin / 120;
      const dra = half / Math.max(0.01, Math.cos(selectedRegion.dec_deg * Math.PI / 180));
      const points = [[-1,-1], [1,-1], [1,1], [-1,1]].map(([x,y]) => v.world2pix!((selectedRegion.ra_deg + x * dra + 360) % 360, selectedRegion.dec_deg + y * half));
      setProjectedRegion(points.every(p => p && p.every(Number.isFinite)) ? points.map(p => [p![0], p![1]] as [number, number]) : null);
    };
    draw(); const timer = window.setInterval(draw, 100);
    return () => window.clearInterval(timer);
  }, [selectedRegion]);

  useEffect(() => {
    if (!aladinReady) return;
    const worker = navigator.serviceWorker.controller;
    worker?.postMessage({ type: 'CANCEL_PREFETCH' });
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    let timer: number;
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => worker?.postMessage({ type: 'WARM_NEIGHBOURS', channel: currentChannel }), 1200); };
    const loaded = (event: MessageEvent) => { if (event.data?.type === 'TILE_TELEMETRY' && event.data.channel === currentChannel) schedule(); };
    navigator.serviceWorker.addEventListener('message', loaded);
    schedule();
    return () => { window.clearTimeout(timer); navigator.serviceWorker.removeEventListener('message', loaded); worker?.postMessage({ type: 'CANCEL_PREFETCH' }); };
  }, [aladinReady, currentChannel, centerCoords[0], centerCoords[1], currentFov]);

  // Drawer toggle for mobile (<900px)
  const [isRailOpen, setIsRailOpen] = useState(false);

  // 1. Fetch catalog
  useEffect(() => {
    let mounted = true;
    void api
      .getCatalog()
      .then((res) => {
        if (mounted && res.objects?.length) {
          setCatalog(res.objects);
        }
      })
      .catch(() => {
        // Fallback already pre-set to CURATED_CATALOG_FALLBACK
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const onTile = (event: MessageEvent) => {
      if (event.data?.type !== 'TILE_TELEMETRY' || event.data.channel !== channelRef.current) return;
      if (event.data.status === 200) setTileStatus(`Channel ${event.data.channel} tiles loaded${event.data.cacheHit ? ' from cache' : ''}`);
      else setTileStatus(`Channel ${event.data.channel} tile failed: ${event.data.error ?? `HTTP ${event.data.status}`}`);
    };
    navigator.serviceWorker.addEventListener('message', onTile);
    return () => navigator.serviceWorker.removeEventListener('message', onTile);
  }, []);

  // 2. Initialize Aladin with DR1 All-Sky Cube
  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    async function initAladin() {
      try {
        setAladinStatus('Fetching official DR1 All-Sky Cube properties...');
        const resp = await fetch(`${SPHEREX_HIPS_ROOT}/properties`);
        if (!resp.ok) {
          throw new Error(`Official HiPS properties returned HTTP ${resp.status}`);
        }
        const propsText = await resp.text();
        const parsed = parseChannels(propsText);

        if (!active) return;
        setChannels(parsed);

        setAladinStatus('Registering SPHEREx HiPS Service Worker adapter...');
        const reg = await navigator.serviceWorker.register('/hips-adapter.js');
        await navigator.serviceWorker.ready;
        const worker = reg.active ?? reg.waiting ?? reg.installing;
        if (!worker) throw new Error('HiPS service worker adapter unavailable');

        await workerMessage(
          worker,
          imagePropertiesFromCube(propsText, channelVirtualHipsUrl(0, location.origin)),
        );
        await waitForControl();
        if (!navigator.serviceWorker.controller) {
          throw new Error('HiPS adapter is not controlling page. Check localhost/HTTPS.');
        }

        setAladinStatus('Initializing Aladin Lite canvas...');
        await Aladin.init;

        if (!active || !mapRef.current) return;

        const viewer = Aladin.aladin('#aladin-view', {
          target: '0 0',
          fov: 180,
          survey: channelVirtualHipsUrl(DEFAULT_CHANNEL_INDEX, location.origin),
          cooFrame: 'ICRS',
          showFrame: false,
          showCooLocation: false,
          showFov: false,
          showProjectionControl: false,
          showReticle: false,
          showLayersControl: false,
          showGotoControl: false,
          showZoomControl: false,
          showFullscreenControl: false,
        });

        viewerRef.current = viewer;

        // Start at fov 180 centered on RA 0/Dec 0 (all sky), then set default channel 44
        setChannelImageLayer(viewer, channelVirtualHipsUrl(DEFAULT_CHANNEL_INDEX, location.origin));
        setCurrentChannel(DEFAULT_CHANNEL_INDEX);

        setAladinReady(true);
        setAladinStatus('SPHEREx DR1 All-Sky Cube HiPS loaded');

        // Poll position/fov periodically
        timer = window.setInterval(() => {
          if (!viewerRef.current) return;
          const radec = viewerRef.current.getRaDec?.();
          if (radec?.length === 2 && radec.every(Number.isFinite)) {
            setCenterCoords([radec[0], radec[1]]);
          }
          const fovArr = viewerRef.current.getFoV?.();
          if (fovArr?.length && Number.isFinite(fovArr[0])) {
            setCurrentFov(fovArr[0]);
          }
        }, 600);
      } catch (err) {
        if (!active) return;
        const msg = err instanceof Error ? err.message : String(err);
        setAladinStatus(`Sky initialization error: ${msg}`);
      }
    }

    void initAladin();

    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
    };
  }, []);

  // Channel switcher
  const handleChannelChange = useCallback(
    (index: number) => {
      if (!isChannelAvailable(index)) return;
      if (!viewerRef.current || !aladinReady) return;

      try {
        setTileStatus(`Loading channel ${index} tiles`);
        channelRef.current = index;
        setChannelImageLayer(viewerRef.current, channelVirtualHipsUrl(index, location.origin));
        setCurrentChannel(index);
      } catch (err) {
        setTileStatus(`Channel ${index} could not load: ${err instanceof Error ? err.message : String(err)}`);
        console.error('Failed to swap Aladin channel survey:', err);
      }
    },
    [aladinReady],
  );

  // RGB composite: three channels painted red/green/blue and blended additively.
  const { rgbMode, rgb, rgbError, applyRgb, setRgbMode } = useRgbComposite({
    viewerRef,
    ready: aladinReady,
    channels,
    currentChannel,
    channelRef,
    onStatus: setTileStatus,
  });

  // Go to coordinates
  const handleGoto = useCallback(
    (target: RegionRequest, name?: string) => {
      const val = validateCoordinates(target.ra_deg, target.dec_deg, target.size_arcmin);
      if (!val.valid) {
        setCoordError(val.error);
        return;
      }
      setCoordError(null);
      setRegionError(null);
      setSelectedRegion(target);
      setRegionConfirmed(true);

      if (viewerRef.current) {
        viewerRef.current.gotoRaDec?.(target.ra_deg, target.dec_deg);
        // Set FOV slightly larger than region to provide context
        const fovDeg = Math.min(60, Math.max(0.1, (target.size_arcmin * 2) / 60));
        viewerRef.current.setFoV?.(fovDeg);
        setCurrentFov(fovDeg);
        setCenterCoords([target.ra_deg, target.dec_deg]);
      }

      saveRecentSelection({
        id: name || `${target.ra_deg.toFixed(4)},${target.dec_deg.toFixed(4)}`,
        name: name || `Field (${target.ra_deg.toFixed(3)}°, ${target.dec_deg.toFixed(3)}°)`,
        ra_deg: target.ra_deg,
        dec_deg: target.dec_deg,
        size_arcmin: target.size_arcmin,
      });
      setRecentSelections(getRecentSelections());

      // Immediately prefetch
      void onStartJob({
        ra_deg: target.ra_deg,
        dec_deg: target.dec_deg,
        size_arcmin: target.size_arcmin,
        channels: [currentChannel],
        products: ['image'],
        mode: 'latest',
      }).catch(() => {
        // Job creation errors surface through the app-level banner.
      });
    },
    [currentChannel, onStartJob],
  );

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const ra = Number(raInput);
    const dec = Number(decInput);
    const size = Number(sizeInput);
    handleGoto({ ra_deg: ra, dec_deg: dec, size_arcmin: size });
  };

  // Convert pointer event to sky world coordinates
  const toWorld = useCallback((e: React.PointerEvent): [number, number] | null => {
    const el = mapRef.current;
    const viewer = viewerRef.current;
    if (!el || !viewer || !viewer.getSize || !viewer.pix2world) return null;

    const bounds = el.getBoundingClientRect();
    const size = viewer.getSize();
    const x = ((e.clientX - bounds.left) / bounds.width) * size[0];
    const y = ((e.clientY - bounds.top) / bounds.height) * size[1];

    const world = viewer.pix2world(x, y);
    if (!world || world.length < 2 || !world.every(Number.isFinite)) return null;
    return [world[0], world[1]];
  }, []);

  // Pointer drag for region selection
  const handlePointerDown = (e: React.PointerEvent) => {
    if (mode !== 'region') return;
    e.preventDefault();
    const world = toWorld(e);
    if (!world) return;

    const bounds = mapRef.current?.getBoundingClientRect();
    if (!bounds) return;

    dragStartWorld.current = world;
    dragStartPoint.current = [e.clientX - bounds.left, e.clientY - bounds.top];
    setSelectionBox(null);
    setRegionError(null);
    mapRef.current?.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (mode !== 'region') {
      if (performance.now() - lastCursorUpdate.current > 50) {
        lastCursorUpdate.current = performance.now();
        setCursorCoords(toWorld(e));
      }
      return;
    }
    if (!dragStartPoint.current) return;
    const bounds = mapRef.current?.getBoundingClientRect();
    if (!bounds) return;

    const [x0, y0] = dragStartPoint.current;
    const x1 = Math.max(0, Math.min(bounds.width, e.clientX - bounds.left));
    const y1 = Math.max(0, Math.min(bounds.height, e.clientY - bounds.top));

    setSelectionBox({
      left: Math.min(x0, x1),
      top: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (mode !== 'region' || !dragStartWorld.current) return;
    e.preventDefault();

    const endWorld = toWorld(e);
    const startWorld = dragStartWorld.current;
    dragStartWorld.current = null;
    dragStartPoint.current = null;
    setSelectionBox(null);

    if (!endWorld) return;

    const regionBounds = computeRegionFromPoints(startWorld, endWorld);

    if (regionBounds.exceeds_limit) {
      setRegionError(REGION_EXCEEDS_LIMIT_MESSAGE);
      return;
    }

    setRegionError(null);
    setMode('pan');

    // Valid region: keep it as an adjustable draft until the user confirms it.
    setSelectedRegion({ ra_deg: regionBounds.ra_deg, dec_deg: regionBounds.dec_deg, size_arcmin: regionBounds.clamped_size_arcmin });
    setRegionConfirmed(false);
  };

  // Move (drag the box) or resize (drag a corner) the selected region
  const handleRegionEditStart = (kind: 'move' | 'resize') => (e: React.PointerEvent<SVGElement>) => {
    if (!selectedRegion) return;
    e.stopPropagation();
    e.preventDefault();
    const world = toWorld(e);
    if (!world) return;
    regionEdit.current = { kind, startWorld: world, startRegion: selectedRegion };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleRegionEditMove = (e: React.PointerEvent<SVGElement>) => {
    const edit = regionEdit.current;
    if (!edit) return;
    e.stopPropagation();
    const world = toWorld(e);
    if (!world) return;
    setSelectedRegion(
      edit.kind === 'move'
        ? moveRegion(edit.startRegion, edit.startWorld, world)
        : resizeRegion(edit.startRegion, world),
    );
    setRegionConfirmed(false);
  };

  const handleRegionEditEnd = (e: React.PointerEvent<SVGElement>) => {
    if (!regionEdit.current) return;
    e.stopPropagation();
    regionEdit.current = null;
  };

  const handleConfirmRegion = () => {
    if (!selectedRegion) return;
    setRegionConfirmed(true);
    void onStartJob({
      ...selectedRegion,
      channels: [currentChannel],
      products: ['image'],
      mode: 'latest',
    }).catch(() => {
      // Job creation errors surface through the app-level banner.
    });
  };

  const handleClearRegion = () => {
    setSelectedRegion(null);
    setRegionConfirmed(true);
  };

  // Zoom controls
  const handleZoom = (factor: number) => {
    if (!viewerRef.current) return;
    const newFov = Math.min(180, Math.max(0.05, currentFov * factor));
    viewerRef.current.setFoV?.(newFov);
    setCurrentFov(newFov);
  };

  const handleAllSky = () => {
    if (!viewerRef.current) return;
    viewerRef.current.gotoRaDec?.(0, 0);
    viewerRef.current.setFoV?.(180);
    setCurrentFov(180);
    setCenterCoords([0, 0]);
  };

  // Current channel details
  const activeChannelObj =
    channels.find((c) => c.index === currentChannel) ??
    DEFAULT_CHANNELS.find((c) => c.index === currentChannel);
  const channelWavelength = (activeChannelObj && ('wavelength_um' in activeChannelObj ? activeChannelObj.wavelength_um : activeChannelObj.wavelengthMicrometres)) ?? 2.089;
  const channelBand = channelToBand(currentChannel);
  const channelDetector = channelToDetector(currentChannel);

  const filteredCatalog = catalog.filter((obj) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      obj.name.toLowerCase().includes(q) ||
      obj.type.toLowerCase().includes(q) ||
      obj.description?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="sky-workspace">
      {/* Mobile drawer toggle */}
      <button
        type="button"
        className="mobile-rail-toggle"
        aria-expanded={isRailOpen}
        aria-label="Toggle object catalog and coordinates"
        onClick={() => setIsRailOpen((prev) => !prev)}
      >
        {isRailOpen ? '✕ Close Catalog' : '☰ Explore Objects'}
      </button>

      {/* Left Rail (280px) */}
      <aside className={`sky-rail ${isRailOpen ? 'open' : ''}`} aria-label="Explore and Search">
        {/* Search */}
        <section className="rail-section">
          <label className="rail-label" htmlFor="catalog-search">
            Search objects
          </label>
          <div className="search-box">
            <span className="search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              id="catalog-search"
              type="search"
              className="rail-input search-input"
              placeholder="Search catalog or fields..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="catalog-list" role="list" aria-label="Curated objects">
            {filteredCatalog.map((item) => (
              <button
                key={item.id}
                type="button"
                className="catalog-row"
                onClick={() => {
                  handleGoto(
                    {
                      ra_deg: item.ra_deg,
                      dec_deg: item.dec_deg,
                      size_arcmin: item.default_size_arcmin,
                    },
                    item.name,
                  );
                  setIsRailOpen(false);
                }}
              >
                <div className="catalog-row-top">
                  <span className="object-name">{item.name}</span>
                  {item.precomputed && (
                    <span className="chip-precomputed" title="Precomputed spectral products ready">
                      Warmed
                    </span>
                  )}
                </div>
                <div className="catalog-row-bottom">
                  <span className="object-type">{item.type}</span>
                  <span className="object-coords num">
                    {item.ra_deg.toFixed(2)}°, {item.dec_deg.toFixed(2)}°
                  </span>
                </div>
              </button>
            ))}
            {filteredCatalog.length === 0 && (
              <p className="rail-empty">No objects match &ldquo;{searchQuery}&rdquo;</p>
            )}
          </div>
        </section>

        {/* Recent selections */}
        {recentSelections.length > 0 && (
          <section className="rail-section">
            <h3 className="rail-label">Recent selections</h3>
            <div className="recent-list">
              {recentSelections.map((recent) => (
                <button
                  key={recent.id}
                  type="button"
                  className="recent-chip"
                  onClick={() => {
                    handleGoto(recent, recent.name);
                    setIsRailOpen(false);
                  }}
                >
                  <span className="recent-name">{recent.name}</span>
                  <span className="recent-meta num">{recent.size_arcmin}′</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Coordinates Form */}
        <section className="rail-section">
          <h3 className="rail-label">Go to coordinates</h3>
          <form className="coord-form" onSubmit={handleFormSubmit}>
            <div className="coord-grid">
              <label>
                <span>RA (deg)</span>
                <input
                  type="text"
                  className="rail-input num"
                  inputMode="decimal"
                  value={raInput}
                  onChange={(e) => setRaInput(e.target.value)}
                />
              </label>
              <label>
                <span>Dec (deg)</span>
                <input
                  type="text"
                  className="rail-input num"
                  inputMode="decimal"
                  value={decInput}
                  onChange={(e) => setDecInput(e.target.value)}
                />
              </label>
              <label className="span-2">
                <span>Size (arcmin, 1..60)</span>
                <input
                  type="text"
                  className="rail-input num"
                  inputMode="decimal"
                  value={sizeInput}
                  onChange={(e) => setSizeInput(e.target.value)}
                />
              </label>
            </div>
            {coordError && (
              <p className="coord-error" role="alert">
                {coordError}
              </p>
            )}
            <button
              type="submit"
              className="btn btn-primary btn-goto"
              disabled={!aladinReady}
            >
              Go to region
            </button>
          </form>
        </section>
      </aside>

      {/* Main Aladin Stage */}
      <main className="sky-stage-container">
        <div
          ref={mapRef}
          className={`aladin-shell ${mode === 'region' ? 'mode-region' : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <div id="aladin-view" aria-label="Aladin Lite All-Sky DR1 HiPS view" />

          {selectedRegion && projectedRegion && (() => {
            const cx = projectedRegion.reduce((sum, p) => sum + p[0], 0) / 4;
            const cy = projectedRegion.reduce((sum, p) => sum + p[1], 0) / 4;
            // Place the clear button just outside the first corner so it never covers a resize handle.
            const [x0, y0] = projectedRegion[0];
            const dist = Math.hypot(x0 - cx, y0 - cy) || 1;
            const clearX = x0 + ((x0 - cx) / dist) * 26 - 16;
            const clearY = y0 + ((y0 - cy) / dist) * 26 - 16;
            return (
              <svg
                className="persistent-region"
                aria-label="Selected sky region"
                onPointerMove={handleRegionEditMove}
                onPointerUp={handleRegionEditEnd}
                onPointerCancel={handleRegionEditEnd}
              >
                <polygon
                  className="region-body"
                  points={projectedRegion.map(([x, y]) => `${x},${y}`).join(' ')}
                  aria-label="Drag to move the selected region"
                  onPointerDown={handleRegionEditStart('move')}
                />
                {projectedRegion.map(([x, y], i) => (
                  <circle
                    key={i}
                    className={`region-handle ${i % 2 === 0 ? 'handle-nwse' : 'handle-nesw'}`}
                    cx={x}
                    cy={y}
                    r={7}
                    aria-label="Drag to resize the selected region"
                    onPointerDown={handleRegionEditStart('resize')}
                  />
                ))}
                <foreignObject x={clearX} y={clearY} width="32" height="32">
                  <button type="button" className="region-clear" aria-label="Clear selected region" onClick={handleClearRegion}>
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M3 3 9 9M9 3 3 9" />
                    </svg>
                  </button>
                </foreignObject>
              </svg>
            );
          })()}
          {selectedRegion && !regionConfirmed && (
            <div className="region-confirm-bar float" role="group" aria-label="Confirm selected region">
              <span>
                {formatRa(selectedRegion.ra_deg)} {formatDec(selectedRegion.dec_deg)} · {selectedRegion.size_arcmin.toFixed(1)}′
              </span>
              <span className="region-confirm-hint">Drag to move, corners to resize</span>
              <button type="button" className="region-confirm-btn" onClick={handleConfirmRegion}>
                Confirm region
              </button>
            </div>
          )}
          {/* Selection Drag Box */}
          {selectionBox && (
            <div
              className="selection-box-overlay"
              style={{
                left: selectionBox.left,
                top: selectionBox.top,
                width: selectionBox.width,
                height: selectionBox.height,
              }}
              aria-hidden="true"
            />
          )}

          {/* Region error message */}
          {regionError && (
            <div className="region-banner-alert float" role="alert">
              <span className="banner-icon">⚠️</span>
              <span>{regionError}</span>
              <button
                type="button"
                className="banner-close"
                onClick={() => setRegionError(null)}
              >
                ×
              </button>
            </div>
          )}

          {/* Top-Right Floating Toolbar */}
          <div className="sky-floating-toolbar float" role="toolbar" aria-label="Map controls">
            <div className="tool-group" role="group" aria-label="Tool selection">
              <button
                type="button"
                className={`tool-btn ${mode === 'pan' ? 'active' : ''}`}
                aria-pressed={mode === 'pan'}
                title="Pan map"
                onClick={() => setMode('pan')}
              >
                <span aria-hidden="true">✋</span>
                <span className="sr-only">Pan</span>
              </button>
              <button
                type="button"
                className={`tool-btn ${mode === 'region' ? 'active' : ''}`}
                aria-pressed={mode === 'region'}
                disabled={!aladinReady}
                title="Drag rectangle to select region (1..60 arcmin)"
                onClick={() => setMode('region')}
              >
                <span aria-hidden="true">⬚</span>
                <span className="sr-only">Select Region</span>
              </button>
            </div>
            <div className="tool-divider" />
            <div className="tool-group" role="group" aria-label="Zoom controls">
              <button
                type="button"
                className="tool-btn"
                title="Zoom in"
                onClick={() => handleZoom(0.6)}
              >
                +
              </button>
              <button
                type="button"
                className="tool-btn"
                title="Zoom out"
                onClick={() => handleZoom(1.5)}
              >
                −
              </button>
              <button
                type="button"
                className="tool-btn"
                title="Show all sky"
                onClick={handleAllSky}
              >
                🌐
              </button>
            </div>
          </div>

          <label className="sky-projection float">Projection
            <select value={projection} onChange={(event) => {
              const next = event.target.value;
              viewerRef.current?.setProjection?.(next);
              setProjection(next);
            }}>
              <option value="SIN">Orthographic</option>
              <option value="AIT">Aitoff</option>
              <option value="MOL">Mollweide</option>
              <option value="TAN">Tangent</option>
            </select>
          </label>

          {/* Floating Data Card (Bottom Left) */}
          <div className="sky-data-card float" aria-live="polite">
            <div className="data-card-row">
              <span className="card-label">Center</span>
              <span className="card-val num">
                {formatRa(centerCoords[0])}, {formatDec(centerCoords[1])}
              </span>
            </div>
            <div className="data-card-row">
              <span className="card-label">Cursor ICRS</span>
              <span className="card-val num">{cursorCoords ? `${formatRa(cursorCoords[0])}, ${formatDec(cursorCoords[1])}` : '—'}</span>
            </div>
            <div className="data-card-row">
              <span className="card-label">FOV</span>
              <span className="card-val num">{formatAngle(currentFov)}</span>
            </div>
            <div className="data-card-row">
              <span className="card-label">{rgbMode && rgb ? 'RGB λ' : 'Channel λ'}</span>
              <span className="card-val num highlight-lambda">
                {rgbMode && rgb
                  ? (['r', 'g', 'b'] as const)
                      .map((band) => {
                        const um = channels.find((c) => c.index === rgb[band])?.wavelengthMicrometres;
                        return um === undefined ? `ch ${rgb[band]}` : `${um.toFixed(2)}`;
                      })
                      .join(' / ') + ' µm'
                  : formatWavelength(channelWavelength)}
              </span>
            </div>
            <div className="status-caption">{aladinStatus} · {tileStatus}</div>
          </div>

          {activeJob && <button type="button" className="plate-open-quiet float" onClick={() => onOpenPlate(activeJob.id)}>Open spectral plate →</button>}

          {/* Bottom-Center Channel Dock */}
          <div className="sky-channel-dock float" aria-label="Channel slider dock">
            <RgbControls
              ready={aladinReady}
              rgbMode={rgbMode}
              rgb={rgb}
              rgbError={rgbError}
              channels={channels}
              onModeChange={setRgbMode}
              onApply={applyRgb}
            >
            <div className="dock-header">
              <div className="dock-channel-info">
                <span className="dock-badge num">channel {currentChannel}</span>
                <span className="dock-dot">·</span>
                <span className="dock-lambda num">{channelWavelength.toFixed(3)} µm</span>
                <span className="dock-dot">·</span>
                <span className="dock-detector">{channelDetector}</span>
                <span className="dock-band-badge">Band {channelBand}</span>
              </div>
              <div className="dock-nav-btns">
                <button
                  type="button"
                  className="dock-step-btn"
                  aria-label="Previous channel"
                  onClick={() => handleChannelChange(getNextAvailableChannel(currentChannel, -1))}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="dock-step-btn"
                  aria-label="Next channel"
                  onClick={() => handleChannelChange(getNextAvailableChannel(currentChannel, 1))}
                >
                  ›
                </button>
              </div>
            </div>

            <div className="dock-slider-row">
              <span className="slider-edge num">0.75 µm</span>
              <input
                type="range"
                className="channel-slider"
                min={0}
                max={TOTAL_CHANNELS - 1}
                step={1}
                value={currentChannel}
                aria-label="SPHEREx channel selection"
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (val === 50 || val === 51) {
                    const dir = val >= currentChannel ? 1 : -1;
                    handleChannelChange(getNextAvailableChannel(val, dir));
                  } else {
                    handleChannelChange(val);
                  }
                }}
              />
              <span className="slider-edge num">5.00 µm</span>
            </div>
            </RgbControls>
          </div>
        </div>
      </main>
    </div>
  );
}
