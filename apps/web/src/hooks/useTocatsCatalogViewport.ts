import { useEffect } from 'react';
import Aladin, { type AladinCatalog } from 'aladin-lite';
import {
  chooseTocatsDensityOrder,
  formatTocatsDensityPopup,
  getTocatsMarkerOptions,
  isTocatsRegionSupported,
  MAX_TOCATS_SOURCE_ESTIMATE,
  TOCATS_CATALOGS,
  TocatsCatalogClient,
  TocatsViewportCache,
  type TocatsCatalogId,
  type TocatsDensityCell,
  type TocatsRegion,
  type TocatsSourceRecord,
} from '../api/tocats';

export type TocatsLayerPhase = 'idle' | 'waiting' | 'loading' | 'available' | 'empty' | 'error';

export interface TocatsLayerState {
  visible: boolean;
  phase: TocatsLayerPhase;
  message: string;
}

type MarkerKind = 'sources' | 'density';

export interface TocatsCatalogLayerRefs {
  catalogs: Record<TocatsCatalogId, AladinCatalog | null>;
  densityCatalogs: Record<TocatsCatalogId, AladinCatalog | null>;
  markers: Record<TocatsCatalogId, Record<MarkerKind, Map<string, unknown>>>;
  caches: Record<TocatsCatalogId, TocatsViewportCache>;
  mode: Record<TocatsCatalogId, MarkerKind | null>;
  requests: Record<TocatsCatalogId, AbortController | null>;
  client: TocatsCatalogClient;
}

export type TocatsLayerStateUpdater = (catalogId: TocatsCatalogId, patch: Partial<TocatsLayerState>) => void;

export interface UseTocatsCatalogViewportOptions {
  catalogId: TocatsCatalogId;
  visible: boolean;
  aladinReady: boolean;
  centerCoords: [number, number];
  fovWidth: number;
  fovHeight: number;
  refs: { current: TocatsCatalogLayerRefs | null };
  updateState: TocatsLayerStateUpdater;
}

function reconcileMarkers<T>(
  catalog: AladinCatalog,
  existing: Map<string, unknown>,
  entries: Array<[string, T]>,
  create: (item: T) => unknown,
  signal: AbortSignal,
  schedule: (callback: FrameRequestCallback) => number,
): void {
  const desired = new Set(entries.map(([key]) => key));
  for (const [key, marker] of existing) {
    if (!desired.has(key)) {
      catalog.remove(marker);
      existing.delete(key);
    }
  }

  // Draw the nearest entries first, without a single large synchronous Aladin update.
  const pending = entries.filter(([key]) => !existing.has(key));
  let index = 0;
  const addBatch = () => {
    if (signal.aborted) return;
    const batch: unknown[] = [];
    for (let end = Math.min(index + 50, pending.length); index < end; index += 1) {
      const [key, item] = pending[index];
      const marker = create(item);
      existing.set(key, marker);
      batch.push(marker);
    }
    if (batch.length) catalog.addSources(batch);
    if (index < pending.length) schedule(addBatch);
  };
  addBatch();
}

function setMode(refs: TocatsCatalogLayerRefs, catalogId: TocatsCatalogId, mode: MarkerKind): void {
  if (mode === 'sources') {
    refs.catalogs[catalogId]?.show();
    refs.densityCatalogs[catalogId]?.hide();
  } else {
    refs.densityCatalogs[catalogId]?.show();
    refs.catalogs[catalogId]?.hide();
  }
  refs.mode[catalogId] = mode;
}

export function useTocatsCatalogViewport({
  catalogId, visible, aladinReady, centerCoords, fovWidth, fovHeight, refs, updateState,
}: UseTocatsCatalogViewportOptions): void {
  useEffect(() => {
    const layerRefs = refs.current;
    if (!aladinReady || !visible || !layerRefs) return;
    const provider = TOCATS_CATALOGS[catalogId];
    const radius = Math.min(90, Math.hypot(fovWidth / 2, fovHeight / 2));
    if (!Number.isFinite(radius) || radius <= 0) return;
    const viewport: TocatsRegion = { raDeg: centerCoords[0], decDeg: centerCoords[1], radiusDeg: radius };
    const queryRegion: TocatsRegion = {
      ...viewport,
      radiusDeg: Math.min(90, radius * 1.25 + 0.02),
    };
    const initialOrder = chooseTocatsDensityOrder(queryRegion.radiusDeg);
    const cache = layerRefs.caches[catalogId];
    const controller = new AbortController();
    layerRefs.requests[catalogId]?.abort();
    layerRefs.requests[catalogId] = controller;
    const frames: number[] = [];
    const schedule = (callback: FrameRequestCallback) => {
      const frame = window.requestAnimationFrame(callback);
      frames.push(frame);
      return frame;
    };
    let requestTimeout: number | undefined;
    let didTimeout = false;

    const showSources = () => {
      const layer = layerRefs.catalogs[catalogId];
      if (!layer) return;
      const records = cache.visibleSources(viewport);
      reconcileMarkers(layer, layerRefs.markers[catalogId].sources, records,
        (record: TocatsSourceRecord) => Aladin.marker(record.source.ra, record.source.dec,
          getTocatsMarkerOptions(catalogId, record.source, record.columns)), controller.signal, schedule);
      setMode(layerRefs, catalogId, 'sources');
      updateState(catalogId, {
        phase: records.length ? 'available' : 'empty',
        message: records.length
          ? `Showing ${records.length} ${provider.label} sources in this field; select a marker for catalogue data.`
          : `No ${provider.label} sources are cached for this field.`,
      });
    };

    const showDensity = (order: number, total?: number) => {
      const layer = layerRefs.densityCatalogs[catalogId];
      if (!layer) return;
      const cells = cache.visibleCells(viewport, order);
      reconcileMarkers(layer, layerRefs.markers[catalogId].density, cells,
        (cell: TocatsDensityCell) => Aladin.marker(cell.ra, cell.dec, {
          popupTitle: `${provider.label} density tile`,
          popupDesc: formatTocatsDensityPopup(catalogId, cell),
          useMarkerDefaultIcon: false,
        }), controller.signal, schedule);
      setMode(layerRefs, catalogId, 'density');
      updateState(catalogId, {
        phase: cells.length ? 'available' : 'empty',
        message: cells.length
          ? `Showing ${cells.length} ${provider.label} density tiles${total === undefined ? '' : ` (${total.toLocaleString()} catalogue sources represented)`}. Zoom in for individual sources.`
          : `No ${provider.label} density tiles were returned for this field.`,
      });
    };

    if (cache.hasSourceCoverage(viewport)) {
      showSources();
      return () => {
        controller.abort();
        frames.forEach((frame) => window.cancelAnimationFrame(frame));
        if (layerRefs.requests[catalogId] === controller) layerRefs.requests[catalogId] = null;
      };
    }

    updateState(catalogId, {
      phase: 'waiting',
      message: `Waiting for the map to settle before loading ${provider.label} density tiles…`,
    });

    const debounceTimer = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      requestTimeout = window.setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, 15_000);

      const load = async () => {
        let order = cache.bestDensityOrder(viewport, initialOrder) ?? initialOrder;
        let totalSources: number;
        try {
          if (!cache.hasDensityCoverage(viewport, order)) {
            updateState(catalogId, { phase: 'loading', message: `Loading ${provider.label} density tiles…` });
            let density = await layerRefs.client.queryDensity(catalogId, queryRegion, order, controller.signal);
            while (density.truncated && order > 3 && !controller.signal.aborted) {
              order -= 1;
              density = await layerRefs.client.queryDensity(catalogId, queryRegion, order, controller.signal);
            }
            if (controller.signal.aborted || layerRefs.requests[catalogId] !== controller) return;
            cache.mergeDensity(density);
            if (!density.truncated) cache.recordDensityCoverage(queryRegion, order);
            totalSources = density.totalSources;
          } else {
            totalSources = cache.visibleCells(queryRegion, order).reduce((sum, [, cell]) => sum + cell.count, 0);
          }
        } catch (error) {
          if (controller.signal.aborted && !didTimeout) return;
          throw error;
        }

        // Mother-table queries become practical only for sparse, narrow fields.
        const canQuerySources = totalSources > 0 && totalSources <= MAX_TOCATS_SOURCE_ESTIMATE
          && cache.hasDensityCoverage(viewport, order) && isTocatsRegionSupported(viewport);
        const keepSourcesVisible = canQuerySources && layerRefs.mode[catalogId] === 'sources'
          && cache.visibleSources(viewport).length > 0;
        if (!keepSourcesVisible) showDensity(order, totalSources);
        if (!canQuerySources) return;
        try {
          updateState(catalogId, { phase: 'loading', message: `Loading individual ${provider.label} sources…` });
          const sourceRegion = { ...viewport, radiusDeg: Math.min(5, radius * 1.15 + 0.01) };
          const result = await layerRefs.client.query(catalogId, sourceRegion, controller.signal);
          if (controller.signal.aborted || layerRefs.requests[catalogId] !== controller) return;
          cache.mergeSources(result);
          cache.recordSourceCoverage(sourceRegion);
          showSources();
        } catch (error) {
          if (controller.signal.aborted && !didTimeout) return;
          const detail = error instanceof Error ? error.message : String(error);
          // Keep previously visible source markers; density data remain cached for later views.
          if (layerRefs.mode[catalogId] === 'sources' && cache.visibleSources(viewport).length) showSources();
          updateState(catalogId, {
            phase: 'error',
            message: `${provider.label} source query failed: ${detail}. Previously loaded markers remain; toggle the layer to retry.`,
          });
        }
      };

      void load().catch((error: unknown) => {
        if (controller.signal.aborted && !didTimeout) return;
        const detail = error instanceof Error ? error.message : String(error);
        updateState(catalogId, {
          phase: 'error',
          message: didTimeout
            ? `${provider.label} density request timed out. Previously loaded markers remain; toggle the layer to retry.`
            : `${provider.label} density request failed: ${detail}. Previously loaded markers remain; toggle the layer to retry.`,
        });
      }).finally(() => {
        if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
        if (layerRefs.requests[catalogId] === controller) layerRefs.requests[catalogId] = null;
      });
    }, 850);

    return () => {
      window.clearTimeout(debounceTimer);
      if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      controller.abort();
      if (layerRefs.requests[catalogId] === controller) layerRefs.requests[catalogId] = null;
    };
  }, [aladinReady, catalogId, centerCoords[0], centerCoords[1], fovHeight, fovWidth, refs, updateState, visible]);
}
