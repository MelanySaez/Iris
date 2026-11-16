import { useEffect, useRef } from 'react';
import Aladin, { type AladinCatalog, type AladinViewer } from 'aladin-lite';
import { HIPS_CATALOG_PROVIDERS, isDuplicateRemoteSource } from '../services/catalogs';
import { createCatalogMarker } from '../utils/catalogMarker';
import { MAX_NEARBY_RESULTS, querySimbadCone } from '../api/nearbyCatalogs';
import { simbadViewportCone } from '../api/simbadViewport';

/** Wait for the map to stop moving before asking SIMBAD. */
const SETTLE_MS = 500;

export interface SimbadLayerStatus {
  loading: boolean;
  message: string;
}

interface UseSimbadViewportLayerOptions {
  visible: boolean;
  aladinReady: boolean;
  viewerRef: { current: AladinViewer | null };
  centerCoords: [number, number];
  fovWidth: number;
  fovHeight: number;
  onStatus: (status: SimbadLayerStatus) => void;
}

/**
 * Sky SIMBAD layer, queried through the Harvard SIMBAD mirror (TAP) for the
 * visible field. Replaces the CDS SIMBAD HiPS catalog, which has been down and
 * has no mirror. Queries are debounced while the map moves and the previous one
 * is cancelled. Any field is loaded: the 300 most-cited objects in view, so wide
 * views show the best-known objects and zooming in reveals more.
 */
export function useSimbadViewportLayer({
  visible,
  aladinReady,
  viewerRef,
  centerCoords,
  fovWidth,
  fovHeight,
  onStatus,
}: UseSimbadViewportLayerOptions) {
  const layerRef = useRef<AladinCatalog | null>(null);
  const markersRef = useRef<unknown[]>([]);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const [ra, dec] = centerCoords;

  useEffect(() => {
    const layer = layerRef.current;
    if (!visible || !aladinReady) {
      layer?.hide();
      return undefined;
    }
    const viewer = viewerRef.current;
    if (!viewer) return undefined;

    let catalog = layer;
    if (!catalog) {
      const provider = HIPS_CATALOG_PROVIDERS.simbad;
      catalog = Aladin.catalog({
        name: provider.name,
        color: provider.color,
        sourceSize: provider.sourceSize,
        shape: createCatalogMarker(provider.color, provider.sourceSize, 'circle'),
      });
      viewer.addCatalog(catalog);
      layerRef.current = catalog;
    }
    catalog.show();

    const replaceMarkers = (markers: unknown[]) => {
      markersRef.current.forEach((marker) => catalog.remove(marker));
      markersRef.current = markers;
      if (markers.length) catalog.addSources(markers);
    };

    const cone = simbadViewportCone([ra, dec], fovWidth, fovHeight);
    if (!cone) {
      replaceMarkers([]);
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      statusRef.current({ loading: true, message: 'Loading SIMBAD objects in view…' });
      querySimbadCone(cone, fetch, controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return;
          // Featured objects already have their own marker on the map.
          const sources = found.filter((source) => !isDuplicateRemoteSource({ data: { main_id: source.id } }));
          replaceMarkers(
            sources.map((source) =>
              Aladin.marker(source.raDeg, source.decDeg, {
                popupTitle: source.id,
                popupDesc: typeof source.data.otype === 'string' ? source.data.otype : '',
                useMarkerDefaultIcon: false,
              }),
            ),
          );
          const count = sources.length;
          const noun = count === 1 ? 'object' : 'objects';
          const message = found.length >= MAX_NEARBY_RESULTS
            ? `The ${MAX_NEARBY_RESULTS} most-cited SIMBAD objects in view; zoom in for more (Harvard mirror).`
            : `${count} SIMBAD ${noun} in view (Harvard mirror).`;
          statusRef.current({ loading: false, message });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const reason = error instanceof Error ? error.message : String(error);
          statusRef.current({ loading: false, message: `SIMBAD could not be reached (${reason}). Move the map to retry.` });
        });
    }, SETTLE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [visible, aladinReady, viewerRef, ra, dec, fovWidth, fovHeight]);
}
