import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Aladin, { type AladinCatalog, type AladinViewer } from 'aladin-lite';
import { api, CURATED_CATALOG_FALLBACK } from '../../api';
import {
  FEATURED_OBJECTS,
  featuredObjectPopup,
  LOCAL_CATALOG_STYLE,
} from '../../catalogs';
import { TocatsCatalogClient, TocatsViewportCache, TOCATS_CATALOGS, type TocatsCatalogId } from '../../tocats';
import {
  type TocatsCatalogLayerRefs,
  type TocatsLayerState,
  useTocatsCatalogViewport,
} from '../../hooks/useTocatsCatalogViewport';
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
import { pointerToIcrs, resolveInitialProjection, setChannelImageLayer } from '../../aladinView';
import { useSimbadViewportLayer, type SimbadLayerStatus } from '../../hooks/useSimbadViewportLayer';
import { createCatalogMarker } from '../../catalogMarker';
import { installCatalogPopupControls } from '../../catalogPopup';
import { useRgbComposite } from '../../hooks/useRgbComposite';
import { RgbControls } from './RgbControls';
import { SelectionActions, type SpectrumTarget } from './SelectionActions';
import { RegionConfirmBar } from './RegionConfirmBar';
import { NameSuggestion, type ResolvedTarget, type SubmitLookup } from './NameSuggestion';
import { runEnterLookup } from '../../searchEnter';
import { lookupView } from '../../lookupView';
import { AllSkyIcon, PanIcon, RegionIcon, ZoomInIcon, ZoomOutIcon } from '../SkyIcons';
import { contextFovDeg, resolveSelectionView, saveSelectionView } from '../../selectionView';
import type { AssistantAction, AssistantUiContext } from '../../assistant';
import { ensureServiceWorkerControl } from '../../serviceWorkerControl';
import {
  computeRegionFromPoints,
  moveRegion,
  REGION_EXCEEDS_LIMIT_MESSAGE,
  resizeRegion,
  validateCoordinates,
} from '../../region';
import type { CatalogObject, JobCreateRequest, JobSnapshot, JobView, RegionRequest } from '../../types';
import type { NearbyCatalogId, NearbyCatalogSource } from '../../nearbyCatalogs';
import { SkyContextMenu, type SkyContextTarget } from './SkyContextMenu';

interface SkyWorkspaceProps {
  activeJob: JobSnapshot | null;
  onStartJob: (req: JobCreateRequest) => Promise<void>;
  onOpenPlate: (jobId: string) => void;
  onViewSpectrum: (target: SpectrumTarget) => void;
  onRetryJob: () => void;
  /** Rebuild a recorded selection on the map; each request id is applied once. */
  restoreRequest?: SelectionRestoreRequest | null;
  /** Assistant actions for the map, applied once each and in order of id. */
  assistantCommands?: AssistantSkyCommand[];
  /** Reports the map state the assistant reads as context. */
  onStateChange?: (state: SkyUiState) => void;
}

export interface AssistantSkyCommand {
  id: number;
  action: Extract<AssistantAction, { type: 'show_region' | 'set_channel' | 'set_color_mode' }>;
}

export type SkyUiState = Omit<AssistantUiContext, 'workspace' | 'active_job_id'>;

export interface SelectionRestoreRequest {
  id: number;
  region: RegionRequest;
}

interface RecentSelection {
  id: string;
  name: string;
  ra_deg: number;
  dec_deg: number;
  size_arcmin: number;
  timestamp: number;
}

const INITIAL_TOCATS_LAYER_STATES: Record<TocatsCatalogId, TocatsLayerState> = {
  gaia: {
    visible: false,
    phase: 'idle',
    message: 'Enable to query Gaia DR3 sources for the visible sky region.',
  },
  catwise: {
    visible: false,
    phase: 'idle',
    message: 'Enable to query CatWISE2020 sources for the visible sky region.',
  },
};

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

export function SkyWorkspace({
  activeJob,
  onStartJob,
  onOpenPlate,
  onViewSpectrum,
  restoreRequest = null,
  assistantCommands,
  onStateChange,
}: SkyWorkspaceProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<AladinViewer | null>(null);
  const localCatalogRef = useRef<AladinCatalog | null>(null);
  const nearbyCatalogRef = useRef<AladinCatalog | null>(null);
  const nearbyAnchorMarkerRef = useRef<unknown | null>(null);
  const nearbyResultMarkersRef = useRef<unknown[]>([]);
  const tocatsLayerRefs = useRef<TocatsCatalogLayerRefs | null>(null);
  if (!tocatsLayerRefs.current) {
    tocatsLayerRefs.current = {
      catalogs: { gaia: null, catwise: null },
      densityCatalogs: { gaia: null, catwise: null },
      markers: {
        gaia: { sources: new Map(), density: new Map() },
        catwise: { sources: new Map(), density: new Map() },
      },
      caches: { gaia: new TocatsViewportCache(), catwise: new TocatsViewportCache() },
      mode: { gaia: null, catwise: null },
      requests: { gaia: null, catwise: null },
      client: new TocatsCatalogClient(),
    };
  }

  const [aladinReady, setAladinReady] = useState(false);
  const [aladinStatus, setAladinStatus] = useState('Loading DR1 All-Sky Cube HiPS metadata...');
  const [channels, setChannels] = useState<SpectralChannel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<number>(DEFAULT_CHANNEL_INDEX);
  const [mode, setMode] = useState<'pan' | 'region'>('pan');

  const [centerCoords, setCenterCoords] = useState<[number, number]>([0, 0]);
  const [currentFov, setCurrentFov] = useState<number>(180);
  const [currentFovHeight, setCurrentFovHeight] = useState<number>(180);
  const [projection, setProjection] = useState(resolveInitialProjection);
  const [contextTarget, setContextTarget] = useState<SkyContextTarget | null>(null);
  const [contextPosition, setContextPosition] = useState<{ x: number; y: number } | null>(null);
  const contextTargetRef = useRef<SkyContextTarget | null>(null);
  const contextPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [cursorCoords, setCursorCoords] = useState<[number, number] | null>(null);
  const lastCursorUpdate = useRef(0);
  const channelRef = useRef(DEFAULT_CHANNEL_INDEX);
  const [tileStatus, setTileStatus] = useState('Loading tiles');
  const [localCatalogVisible, setLocalCatalogVisible] = useState(true);
  const [localCatalogStatus, setLocalCatalogStatus] = useState('Loads with the viewer and works offline.');
  const [simbadCatalogVisible, setSimbadCatalogVisible] = useState(false);
  const [simbadCatalogLoading, setSimbadCatalogLoading] = useState(false);
  const [simbadCatalogStatus, setSimbadCatalogStatus] = useState(
    'Enable to show SIMBAD objects in the current view (Harvard mirror).',
  );
  const [tocatsLayerStates, setTocatsLayerStates] = useState<Record<TocatsCatalogId, TocatsLayerState>>(
    () => ({ ...INITIAL_TOCATS_LAYER_STATES }),
  );

  // Catalog & Search
  const [catalog, setCatalog] = useState<CatalogObject[]>(CURATED_CATALOG_FALLBACK);
  const [searchQuery, setSearchQuery] = useState('');
  const nameSubmitRef = useRef<SubmitLookup | null>(null);
  // Bumped on every navigation, so a late name lookup cannot pull the map back.
  const navigationSeqRef = useRef(0);
  const searchQueryRef = useRef('');
  searchQueryRef.current = searchQuery;
  const [recentSelections, setRecentSelections] = useState<RecentSelection[]>(getRecentSelections());

  const clearNearbyResultMarkers = useCallback(() => {
    const layer = nearbyCatalogRef.current;
    if (layer) nearbyResultMarkersRef.current.forEach((source) => layer.remove(source));
    nearbyResultMarkersRef.current = [];
  }, []);

  const handleNearbySourcesChange = useCallback((sources: NearbyCatalogSource[]) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    let layer = nearbyCatalogRef.current;
    if (!layer) {
      layer = Aladin.catalog({
        name: 'Temporary nearby sources',
        color: '#f5b041',
        sourceSize: 12,
        shape: createCatalogMarker('#f5b041', 12, 'circle'),
      });
      viewer.addCatalog(layer);
      nearbyCatalogRef.current = layer;
    }
    clearNearbyResultMarkers();
    const markers = sources.map((source) => Aladin.marker(source.raDeg, source.decDeg, {
      useMarkerDefaultIcon: false,
    }));
    if (markers.length) {
      layer.addSources(markers);
      nearbyResultMarkersRef.current = markers;
    }
  }, [clearNearbyResultMarkers]);

  const removeNearbyAnchor = useCallback(() => {
    const layer = nearbyCatalogRef.current;
    if (layer && nearbyAnchorMarkerRef.current) layer.remove(nearbyAnchorMarkerRef.current);
    nearbyAnchorMarkerRef.current = null;
    clearNearbyResultMarkers();
  }, [clearNearbyResultMarkers]);

  const dismissContextMenu = useCallback(() => {
    contextTargetRef.current = null;
    contextPositionRef.current = null;
    setContextTarget(null);
    setContextPosition(null);
    removeNearbyAnchor();
  }, [removeNearbyAnchor]);

  const projectToScreen = useCallback((raDeg: number, decDeg: number) => {
    const viewer = viewerRef.current;
    const shell = mapRef.current;
    if (!viewer?.world2pix || !viewer.getSize || !shell) return null;
    const pixel = viewer.world2pix(raDeg, decDeg);
    const size = viewer.getSize();
    const bounds = shell.getBoundingClientRect();
    if (!pixel || pixel.length < 2 || size.length < 2 || !bounds.width || !bounds.height
      || !Number.isFinite(pixel[0]) || !Number.isFinite(pixel[1])
      || !Number.isFinite(size[0]) || !Number.isFinite(size[1]) || size[0] === 0 || size[1] === 0) return null;
    return { x: (pixel[0] / size[0]) * bounds.width, y: (pixel[1] / size[1]) * bounds.height };
  }, []);

  const updateContextPosition = useCallback(() => {
    const target = contextTargetRef.current;
    if (!target) return;
    const point = projectToScreen(target.raDeg, target.decDeg);
    if (!point) return;
    // Reproject results too: zoom can move sources while the pin stays at the center.
    contextPositionRef.current = point;
    setContextPosition(point);
  }, [projectToScreen]);

  const handleLocalCatalogVisibility = useCallback((visible: boolean) => {
    const catalogLayer = localCatalogRef.current;
    if (!catalogLayer) return;

    if (visible) catalogLayer.show();
    else catalogLayer.hide();
    setLocalCatalogVisible(visible);
  }, []);

  // SIMBAD layer: queried through the Harvard mirror for the visible field (useSimbadViewportLayer).
  const handleSimbadCatalogVisibility = useCallback((visible: boolean) => {
    setSimbadCatalogVisible(visible);
    if (!visible) {
      setSimbadCatalogLoading(false);
      setSimbadCatalogStatus('SIMBAD catalog hidden.');
    }
  }, []);

  const updateTocatsLayerState = useCallback((catalogId: TocatsCatalogId, patch: Partial<TocatsLayerState>) => {
    setTocatsLayerStates((current) => {
      const previous = current[catalogId];
      const next = { ...previous, ...patch };
      if (next.visible === previous.visible && next.phase === previous.phase && next.message === previous.message) {
        return current;
      }
      return { ...current, [catalogId]: next };
    });
  }, []);

  const handleSimbadStatus = useCallback((status: SimbadLayerStatus) => {
    setSimbadCatalogLoading(status.loading);
    setSimbadCatalogStatus(status.message);
  }, []);
  useSimbadViewportLayer({
    visible: simbadCatalogVisible,
    aladinReady,
    viewerRef,
    centerCoords,
    fovWidth: currentFov,
    fovHeight: currentFovHeight,
    onStatus: handleSimbadStatus,
  });

  useTocatsCatalogViewport({
    catalogId: 'gaia',
    visible: tocatsLayerStates.gaia.visible,
    aladinReady,
    centerCoords,
    fovWidth: currentFov,
    fovHeight: currentFovHeight,
    refs: tocatsLayerRefs,
    updateState: updateTocatsLayerState,
  });

  useTocatsCatalogViewport({
    catalogId: 'catwise',
    visible: tocatsLayerStates.catwise.visible,
    aladinReady,
    centerCoords,
    fovWidth: currentFov,
    fovHeight: currentFovHeight,
    refs: tocatsLayerRefs,
    updateState: updateTocatsLayerState,
  });

  const handleTocatsLayerVisibility = useCallback((catalogId: TocatsCatalogId, visible: boolean) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const tocatsRefs = tocatsLayerRefs.current;
    if (!tocatsRefs) return;

    const provider = TOCATS_CATALOGS[catalogId];
    if (!visible) {
      tocatsRefs.requests[catalogId]?.abort();
      tocatsRefs.requests[catalogId] = null;
      tocatsRefs.catalogs[catalogId]?.hide();
      tocatsRefs.densityCatalogs[catalogId]?.hide();
      updateTocatsLayerState(catalogId, {
        visible: false,
        phase: 'idle',
        message: `${provider.label} layer hidden.`,
      });
      return;
    }

    try {
      let catalogLayer = tocatsRefs.catalogs[catalogId];
      if (!catalogLayer) {
        catalogLayer = Aladin.catalog({
          name: provider.label,
          color: provider.color,
          sourceSize: provider.sourceSize,
          shape: createCatalogMarker(provider.color, provider.sourceSize, provider.shape),
          onClick: 'showPopup',
        });
        viewer.addCatalog(catalogLayer);
        tocatsRefs.catalogs[catalogId] = catalogLayer;
      }
      let densityLayer = tocatsRefs.densityCatalogs[catalogId];
      if (!densityLayer) {
        densityLayer = Aladin.catalog({
          name: `${provider.label} density tiles`,
          color: provider.color,
          sourceSize: 12,
          shape: createCatalogMarker(provider.color, 12, provider.shape),
          onClick: 'showPopup',
        });
        viewer.addCatalog(densityLayer);
        tocatsRefs.densityCatalogs[catalogId] = densityLayer;
      }
      if (tocatsRefs.mode[catalogId] === 'density') {
        densityLayer.show();
        catalogLayer.hide();
      } else {
        catalogLayer.show();
        densityLayer.hide();
      }
      updateTocatsLayerState(catalogId, {
        visible: true,
        phase: 'waiting',
        message: 'Waiting for the map to settle before querying TOCats…',
      });
    } catch (error) {
      updateTocatsLayerState(catalogId, {
        visible: false,
        phase: 'error',
        message: `${provider.label} layer could not be initialized.`,
      });
      console.error(`Failed to create the ${provider.label} layer:`, error);
    }
  }, [updateTocatsLayerState]);

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
    let disposePopupControls: (() => void) | undefined;

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
        const control = await ensureServiceWorkerControl(worker);
        if (control === 'reloading') return;
        if (control === 'uncontrolled') {
          throw new Error(
            'HiPS adapter is not controlling this page. Reload with F5; service workers also require localhost or HTTPS.',
          );
        }

        setAladinStatus('Initializing Aladin Lite canvas...');
        await Aladin.init;

        if (!active || !mapRef.current) return;

        const viewer = Aladin.aladin('#aladin-view', {
          target: '0 0',
          fov: 180,
          projection: resolveInitialProjection(),
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
          showContextMenu: false,
        });

        viewerRef.current = viewer;
        const aladinRoot = mapRef.current.querySelector<HTMLElement>('#aladin-view');
        if (aladinRoot) {
          disposePopupControls = installCatalogPopupControls(aladinRoot, () => viewer.hidePopup?.(), {
            projectSource: (ra, dec) => {
              const point = viewer.world2pix?.(ra, dec);
              if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
              return { x: point[0], y: point[1] };
            },
            reopenPopup: (ra, dec, title, description) => viewer.showPopup?.(ra, dec, title, description),
            subscribeToViewportChanges: (callback) => {
              const update = () => {
                callback();
                updateContextPosition();
              };
              viewer.on?.('positionChanged', update);
              viewer.on?.('resizeChanged', update);
              viewer.on?.('rotationChanged', update);
              viewer.on?.('projectionChanged', update);
              viewer.on?.('zoomChanged', update);
              return () => {
                viewer.on?.('positionChanged', undefined);
                viewer.on?.('resizeChanged', undefined);
                viewer.on?.('rotationChanged', undefined);
                viewer.on?.('projectionChanged', undefined);
                viewer.on?.('zoomChanged', undefined);
              };
            },
          });
        }

        // Start at fov 180 centered on RA 0/Dec 0 (all sky), then set default channel 44
        setChannelImageLayer(viewer, channelVirtualHipsUrl(DEFAULT_CHANNEL_INDEX, location.origin));
        setCurrentChannel(DEFAULT_CHANNEL_INDEX);

        try {
          const localCatalog = Aladin.catalog({
            ...LOCAL_CATALOG_STYLE,
            shape: createCatalogMarker(LOCAL_CATALOG_STYLE.color, LOCAL_CATALOG_STYLE.sourceSize, 'rhomb'),
            onClick: 'showPopup',
          });
          localCatalog.addSources(FEATURED_OBJECTS.map((object) => Aladin.marker(
            object.ra_deg,
            object.dec_deg,
            {
              popupTitle: object.name,
              popupDesc: featuredObjectPopup(object),
              useMarkerDefaultIcon: false,
            },
          )));
          viewer.addCatalog(localCatalog);
          localCatalogRef.current = localCatalog;
          setLocalCatalogStatus('Five featured objects are available offline.');
        } catch (err) {
          setLocalCatalogStatus('Featured objects could not be added to the map.');
          console.error('Failed to create the local featured-object layer:', err);
        }

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
            if (Number.isFinite(fovArr[1])) setCurrentFovHeight(fovArr[1]);
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
      disposePopupControls?.();
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

  // How the map shows colour right now; sent with each job so Records can show it.
  const jobView = useMemo<JobView>(
    () => (rgbMode && rgb ? { mode: 'rgb', rgb: [rgb.r, rgb.g, rgb.b] } : { mode: 'single' }),
    [rgbMode, rgb],
  );

  // Remember how the map looked when a selection was made, so Records can restore it.
  const rememberSelectionView = useCallback(
    (region: RegionRequest, center: [number, number], fovDeg: number) => {
      saveSelectionView({
        region,
        center,
        fov_deg: fovDeg,
        projection,
        channel: currentChannel,
        rgb: rgbMode ? rgb : null,
      });
    },
    [projection, currentChannel, rgbMode, rgb],
  );

  // Go to coordinates
  const handleGoto = useCallback(
    (target: RegionRequest, name?: string, options?: { fovDeg?: number }) => {
      navigationSeqRef.current += 1;
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
        const fovDeg = options?.fovDeg ?? contextFovDeg(target.size_arcmin);
        viewerRef.current.setFoV?.(fovDeg);
        setCurrentFov(fovDeg);
        setCenterCoords([target.ra_deg, target.dec_deg]);
        rememberSelectionView(target, [target.ra_deg, target.dec_deg], fovDeg);
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
        view: jobView,
      }).catch(() => {
        // Job creation errors surface through the app-level banner.
      });
    },
    [currentChannel, onStartJob, rememberSelectionView, jobView],
  );

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const ra = Number(raInput);
    const dec = Number(decInput);
    const size = Number(sizeInput);
    handleGoto({ ra_deg: ra, dec_deg: dec, size_arcmin: size });
  };

  // Convert pointer event to sky world coordinates
  const toWorldAt = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const el = mapRef.current;
    const viewer = viewerRef.current;
    if (!el || !viewer || !viewer.getSize || !viewer.pix2world) return null;

    const bounds = el.getBoundingClientRect();
    const size = viewer.getSize();
    if (size.length < 2 || !Number.isFinite(size[0]) || !Number.isFinite(size[1])) return null;
    return pointerToIcrs(clientX, clientY, bounds, [size[0], size[1]], (x, y) => viewer.pix2world!(x, y));
  }, []);

  const toWorld = useCallback((e: React.PointerEvent): [number, number] | null =>
    toWorldAt(e.clientX, e.clientY), [toWorldAt]);

  const handleMapContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const world = toWorldAt(event.clientX, event.clientY);
    const bounds = mapRef.current?.getBoundingClientRect();
    const viewer = viewerRef.current;
    if (!world || !bounds || !viewer) return;

    viewer.hidePopup?.();
    removeNearbyAnchor();
    let layer = nearbyCatalogRef.current;
    if (!layer) {
      layer = Aladin.catalog({
        name: 'Temporary nearby sources',
        color: '#f5b041',
        sourceSize: 12,
        shape: createCatalogMarker('#f5b041', 12, 'circle'),
      });
      viewer.addCatalog(layer);
      nearbyCatalogRef.current = layer;
    }
    const anchor = Aladin.marker(world[0], world[1], {
      useMarkerDefaultIcon: false,
    });
    layer.addSources([anchor]);
    nearbyAnchorMarkerRef.current = anchor;
    const target = { raDeg: world[0], decDeg: world[1] };
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    contextTargetRef.current = target;
    contextPositionRef.current = point;
    setContextTarget(target);
    setContextPosition(point);
  }, [removeNearbyAnchor, toWorldAt]);

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
    const liveCenter = viewerRef.current?.getRaDec?.();
    const liveFov = viewerRef.current?.getFoV?.()?.[0];
    rememberSelectionView(
      selectedRegion,
      liveCenter?.length === 2 && liveCenter.every(Number.isFinite) ? [liveCenter[0], liveCenter[1]] : centerCoords,
      liveFov !== undefined && Number.isFinite(liveFov) ? liveFov : currentFov,
    );
    void onStartJob({
      ...selectedRegion,
      channels: [currentChannel],
      products: ['image'],
      mode: 'latest',
      view: jobView,
    }).catch(() => {
      // Job creation errors surface through the app-level banner.
    });
  };

  const handleClearRegion = () => {
    setSelectedRegion(null);
    setRegionConfirmed(true);
  };

  // Rebuild a recorded selection: the cached view when there is one, else from its coordinates.
  const appliedRestoreId = useRef<number | null>(null);
  useEffect(() => {
    if (!restoreRequest || !aladinReady || appliedRestoreId.current === restoreRequest.id) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    appliedRestoreId.current = restoreRequest.id;

    const { view, source } = resolveSelectionView(restoreRequest.region);
    if (view.projection && view.projection !== projection) {
      viewer.setProjection?.(view.projection);
      setProjection(view.projection);
    }
    viewer.gotoRaDec?.(view.center[0], view.center[1]);
    viewer.setFoV?.(view.fov_deg);
    setCenterCoords(view.center);
    setCurrentFov(view.fov_deg);

    if (view.rgb) {
      setRgbMode(true, view.rgb);
    } else if (view.channel !== null) {
      if (rgbMode) setRgbMode(false);
      if (view.channel !== currentChannel) handleChannelChange(view.channel);
    }

    setMode('pan');
    setRegionError(null);
    setSelectedRegion(view.region);
    setRegionConfirmed(true);
    setTileStatus(
      source === 'cache'
        ? 'Selection restored from its saved view'
        : 'Selection rebuilt from its coordinates (no saved view)',
    );
  }, [restoreRequest, aladinReady, projection, rgbMode, currentChannel, setRgbMode, handleChannelChange]);

  // Apply assistant commands in order. Draft regions are never confirmed here:
  // the person still presses "Confirm region" to start a job.
  const appliedAssistantId = useRef(0);
  useEffect(() => {
    if (!assistantCommands?.length || !aladinReady || !viewerRef.current) return;
    const viewer = viewerRef.current;
    let rgbOn = rgbMode;
    for (const { id, action } of assistantCommands) {
      if (id <= appliedAssistantId.current) continue;
      appliedAssistantId.current = id;
      if (action.type === 'show_region') {
        const fovDeg = contextFovDeg(action.size_arcmin);
        viewer.gotoRaDec?.(action.ra_deg, action.dec_deg);
        viewer.setFoV?.(fovDeg);
        setCenterCoords([action.ra_deg, action.dec_deg]);
        setCurrentFov(fovDeg);
        setMode('pan');
        setRegionError(null);
        setSelectedRegion({ ra_deg: action.ra_deg, dec_deg: action.dec_deg, size_arcmin: action.size_arcmin });
        setRegionConfirmed(false);
      } else if (action.type === 'set_channel') {
        if (rgbOn) {
          setRgbMode(false);
          rgbOn = false;
        }
        handleChannelChange(action.channel);
      } else if (action.mode === 'rgb') {
        setRgbMode(true, { r: action.rgb[0], g: action.rgb[1], b: action.rgb[2] });
        rgbOn = true;
      } else if (rgbOn) {
        setRgbMode(false);
        rgbOn = false;
      }
    }
  }, [assistantCommands, aladinReady, rgbMode, setRgbMode, handleChannelChange]);

  // Let the assistant read the map state (a cheap ref update in the parent).
  useEffect(() => {
    onStateChange?.({
      channel: currentChannel,
      color_mode: rgbMode && rgb ? 'rgb' : 'single',
      ...(rgbMode && rgb ? { rgb: [rgb.r, rgb.g, rgb.b] as [number, number, number] } : {}),
      ...(selectedRegion ? { selected_region: selectedRegion, region_confirmed: regionConfirmed } : {}),
      center: centerCoords,
      fov_deg: currentFov,
    });
  }, [onStateChange, currentChannel, rgbMode, rgb, selectedRegion, regionConfirmed, centerCoords, currentFov]);

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

  // Expert lookup: a resolved name moves the map like a curated object does.
  const handleResolvedName = useCallback(
    (target: ResolvedTarget) => {
      // Frame the whole object: view and region follow its size in SIMBAD.
      const view = lookupView(target.size_arcmin);
      handleGoto(
        { ra_deg: target.ra_deg, dec_deg: target.dec_deg, size_arcmin: view.regionArcmin },
        target.name,
        { fovDeg: view.fovDeg },
      );
    },
    [handleGoto],
  );

  const filteredCatalog = catalog.filter((obj) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      obj.name.toLowerCase().includes(q) ||
      obj.type.toLowerCase().includes(q) ||
      obj.description?.toLowerCase().includes(q)
    );
  });

  const catalogLayers = [
    {
      id: 'featured', name: 'Featured objects', description: 'Five objects available offline',
      visible: localCatalogVisible, disabled: !aladinReady, busy: false,
      status: localCatalogStatus, onToggle: handleLocalCatalogVisibility,
    },
    {
      id: 'simbad', name: 'SIMBAD', description: 'Known objects in the visible sky (Harvard mirror)',
      visible: simbadCatalogVisible, disabled: !aladinReady,
      busy: simbadCatalogLoading, status: simbadCatalogStatus,
      onToggle: (visible: boolean) => handleSimbadCatalogVisibility(visible),
    },
    {
      id: 'gaia', name: 'Gaia DR3', description: 'Astrometric sources in this sky region',
      visible: tocatsLayerStates.gaia.visible, disabled: !aladinReady,
      busy: tocatsLayerStates.gaia.phase === 'waiting' || tocatsLayerStates.gaia.phase === 'loading',
      status: tocatsLayerStates.gaia.message,
      onToggle: (visible: boolean) => handleTocatsLayerVisibility('gaia', visible),
    },
    {
      id: 'catwise', name: 'CatWISE2020', description: 'Infrared sources in the visible sky region',
      visible: tocatsLayerStates.catwise.visible, disabled: !aladinReady,
      busy: tocatsLayerStates.catwise.phase === 'waiting' || tocatsLayerStates.catwise.phase === 'loading',
      status: tocatsLayerStates.catwise.message,
      onToggle: (visible: boolean) => handleTocatsLayerVisibility('catwise', visible),
    },
  ];
  const orderedCatalogLayers = [
    ...catalogLayers.filter((layer) => layer.visible),
    ...catalogLayers.filter((layer) => !layer.visible),
  ];
  const visibleNearbyCatalogIds = useMemo<NearbyCatalogId[]>(() => {
    const visible: NearbyCatalogId[] = [];
    if (localCatalogVisible) visible.push('featured');
    if (simbadCatalogVisible) visible.push('simbad');
    if (tocatsLayerStates.gaia.visible) visible.push('gaia');
    if (tocatsLayerStates.catwise.visible) visible.push('catwise');
    return visible;
  }, [localCatalogVisible, simbadCatalogVisible, tocatsLayerStates.gaia.visible, tocatsLayerStates.catwise.visible]);

  return (
    <div className="sky-workspace">
      {/* Mobile drawer toggle */}
      <button
        type="button"
        className="mobile-rail-toggle"
        aria-expanded={isRailOpen}
        aria-controls="sky-controls"
        aria-label="Toggle sky controls"
        onClick={() => setIsRailOpen((prev) => !prev)}
      >
        {isRailOpen ? 'Close controls' : 'Explore sky'}
      </button>

      {/* Left Rail (280px) */}
      <aside id="sky-controls" className={`sky-rail ${isRailOpen ? 'open' : ''}`} aria-label="Explore and Search">
        {/* Coordinates Form */}
        <section className="rail-section position-section" aria-label="Choose a region">
          <h3 className="rail-label">Choose a region</h3>
          <p className="rail-help">Enter ICRS coordinates or select a region on the map.</p>
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
                {/* Recent selections */}
        {recentSelections.length > 0 && (
          <div className="recent-shortcuts">
            <h4 className="rail-label">Recent selections</h4>
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
          </div>
        )}

        </section>

        {/* Search */}
        <section className="rail-section object-search-section" aria-label="Find objects" data-tour="search">
          <label className="rail-label" htmlFor="catalog-search">
            Find objects
          </label>
          <p className="rail-help">
            Browse the featured objects available offline, or type a name or catalogue code
            (M31, NGC 224, HD 48915) to look it up in SIMBAD / NED.
          </p>
          <div className="search-box">
            <span className="search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              id="catalog-search"
              type="search"
              className="rail-input search-input"
              placeholder="Name or code, e.g. M31…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const local = filteredCatalog[0] ?? null;
                void runEnterLookup({
                  typed: searchQuery,
                  submit: () => nameSubmitRef.current?.() ?? Promise.resolve({ kind: 'missed' as const }),
                  currentQuery: () => searchQueryRef.current,
                  navigationSeq: () => navigationSeqRef.current,
                  firstFeatured: local && {
                    ra_deg: local.ra_deg,
                    dec_deg: local.dec_deg,
                    size_arcmin: local.default_size_arcmin,
                    name: local.name,
                  },
                  goToResolved: handleResolvedName,
                  goToFeatured: (f) =>
                    handleGoto({ ra_deg: f.ra_deg, dec_deg: f.dec_deg, size_arcmin: f.size_arcmin }, f.name),
                });
              }}
            />
          </div>

          <div className="catalog-list" role="list" aria-label="Curated objects">
            <NameSuggestion
              query={searchQuery}
              resolve={api.resolveName}
              onSelect={handleResolvedName}
              submitRef={nameSubmitRef}
            />
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
              <p className="rail-empty">No featured objects match &ldquo;{searchQuery}&rdquo;</p>
            )}
          </div>
        </section>

        <section className="rail-section catalog-layers-section" aria-label="Map layers">
          <h3 className="rail-label">Map layers</h3>
          <p className="rail-help">Choose which catalog markers appear on the map.</p>
          <div className="catalog-layer-list">
            {orderedCatalogLayers.map((layer, index) => (
              <div className="catalog-layer-entry" key={layer.id}>
                {(index === 0 || layer.visible !== orderedCatalogLayers[index - 1].visible) && (
                  <h4 className="catalog-group-label">
                    {layer.visible ? 'Enabled layers' : 'Available layers'}
                  </h4>
                )}
                <label className="catalog-layer-toggle">
                  <input
                    type="checkbox"
                    checked={layer.visible}
                    disabled={layer.disabled}
                    onChange={(event) => layer.onToggle(event.target.checked)}
                    aria-describedby={`${layer.id}-catalog-status`}
                  />
                  <span className={`catalog-layer-swatch ${layer.id}`} aria-hidden="true" />
                  <span className="catalog-layer-copy">
                    <span>{layer.name}</span>
                    <small>{layer.description}</small>
                  </span>
                </label>
                <p
                  id={`${layer.id}-catalog-status`}
                  className="catalog-layer-status"
                  role="status"
                  aria-live="polite"
                  aria-busy={layer.busy}
                >
                  {layer.status}
                </p>
              </div>
            ))}
          </div>
        </section>
      </aside>

      {/* Main Aladin Stage */}
      <main className="sky-stage-container">
        <div
          ref={mapRef}
          className={`aladin-shell ${mode === 'region' ? 'mode-region' : ''}`}
          onMouseDownCapture={(event) => {
            if (event.button !== 2) return;
            event.preventDefault();
            event.stopPropagation();
          }}
          onContextMenuCapture={handleMapContextMenu}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <div id="aladin-view" aria-label="Aladin Lite All-Sky DR1 HiPS view" data-tour="map" />

          {contextTarget && contextPosition && (
            <div className="sky-search-origin" role="img" aria-label="Search origin: original pinned sky position"
              style={{ left: contextPosition.x, top: contextPosition.y }}>
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path className="sky-search-origin__outline" d="M16 1v8m0 14v8M1 16h8m14 0h8M16 9l7 7-7 7-7-7Z" />
                <path d="M16 1v8m0 14v8M1 16h8m14 0h8M16 9l7 7-7 7-7-7Z" />
              </svg>
              <span>Origin</span>
            </div>
          )}
          {contextTarget && contextPosition && (
            <SkyContextMenu
              target={contextTarget}
              position={contextPosition}
              visibleCatalogIds={visibleNearbyCatalogIds}
              onDismiss={dismissContextMenu}
              onSourcesChange={handleNearbySourcesChange}
              mapBoundaryRef={mapRef}
              projectToScreen={projectToScreen}
            />
          )}

          {selectedRegion && projectedRegion && (() => {
            const cx = projectedRegion.reduce((sum, p) => sum + p[0], 0) / 4;
            const cy = projectedRegion.reduce((sum, p) => sum + p[1], 0) / 4;
            const moveX = (projectedRegion[0][0] + projectedRegion[1][0]) / 2;
            const moveY = (projectedRegion[0][1] + projectedRegion[1][1]) / 2;
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
                />
                <g
                  className="region-move-handle"
                  transform={`translate(${moveX} ${moveY})`}
                  onPointerDown={handleRegionEditStart('move')}
                >
                  <title>Drag this grip to move the selected region</title>
                  <rect x="-22" y="-13" width="44" height="26" rx="13" />
                  <circle cx="-7" cy="0" r="2" />
                  <circle cx="0" cy="0" r="2" />
                  <circle cx="7" cy="0" r="2" />
                </g>
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
                <PanIcon />
                <span className="sr-only">Pan</span>
              </button>
              <button
                type="button"
                className={`tool-btn ${mode === 'region' ? 'active' : ''}`}
                aria-pressed={mode === 'region'}
                disabled={!aladinReady}
                title="Drag rectangle to select region (1..60 arcmin)"
                data-tour="region-tool"
                onClick={() => setMode('region')}
              >
                <RegionIcon />
                <span className="sr-only">Select Region</span>
              </button>
            </div>
            <div className="tool-divider" />
            <div className="tool-group" role="group" aria-label="Zoom controls">
              <button
                type="button"
                className="tool-btn"
                aria-label="Zoom out"
                title="Zoom out"
                onClick={() => handleZoom(1.5)}
              >
                <ZoomOutIcon />
              </button>
              <button
                type="button"
                className="tool-btn"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() => handleZoom(0.6)}
              >
                <ZoomInIcon />
              </button>
              <button
                type="button"
                className="tool-btn"
                aria-label="Show all sky"
                title="Show all sky"
                onClick={handleAllSky}
              >
                <AllSkyIcon />
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

          <SelectionActions
            selection={selectedRegion}
            confirmed={regionConfirmed}
            activeJobId={activeJob?.id ?? null}
            onOpenPlate={onOpenPlate}
            onViewSpectrum={onViewSpectrum}
          />

          {/* Bottom-centre stack: the region bar always sits right above the dock, whatever its height */}
          <div className="sky-bottom-stack">
            {selectedRegion && !regionConfirmed && (
              <RegionConfirmBar region={selectedRegion} onConfirm={handleConfirmRegion} onDiscard={handleClearRegion} />
            )}
          {/* Bottom-Center Channel Dock */}
          <div className="sky-channel-dock float" aria-label="Channel slider dock" data-tour="channels">
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
        </div>
      </main>
    </div>
  );
}
