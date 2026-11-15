import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  DEFAULT_NEARBY_RADIUS_DEG,
  searchNearbyCatalogs,
  type NearbyCatalogId,
  type NearbyCatalogSource,
} from '../../nearbyCatalogs';
import './SkyContextMenu.css';

export interface SkyContextTarget {
  raDeg: number;
  decDeg: number;
}

type ScreenRect = { x: number; y: number; width: number; height: number };

interface SkyContextMenuProps {
  target: SkyContextTarget;
  /** Current pixel position of the pinned ICRS target inside the map. */
  position: { x: number; y: number };
  visibleCatalogIds: NearbyCatalogId[];
  onDismiss: () => void;
  onSourcesChange: (sources: NearbyCatalogSource[]) => void;
  mapBoundaryRef?: RefObject<HTMLElement | null>;
  projectToScreen?: (raDeg: number, decDeg: number) => { x: number; y: number } | null;
}

export function chooseNearbyMenuPosition(
  anchor: { x: number; y: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  avoidPoints: Array<{ x: number; y: number }>,
  reservedAreas: ScreenRect[] = [],
): { x: number; y: number } {
  const margin = 8;
  const gap = 20;
  const candidates = [
    { x: anchor.x + gap, y: anchor.y - menu.height - gap },
    { x: anchor.x + gap, y: anchor.y + gap },
    { x: anchor.x - menu.width - gap, y: anchor.y - menu.height - gap },
    { x: anchor.x - menu.width - gap, y: anchor.y + gap },
    // Crowded discoveries may occupy all four positions beside the anchor.
    // Prefer a clear edge over covering a result just to stay close to the pin.
    { x: margin, y: margin },
    { x: viewport.width - menu.width - margin, y: margin },
    { x: margin, y: viewport.height - menu.height - margin },
    { x: viewport.width - menu.width - margin, y: viewport.height - menu.height - margin },
    ...reservedAreas.flatMap((area) => [
      { x: area.x - menu.width - margin, y: anchor.y - menu.height / 2 },
      { x: area.x + area.width + margin, y: anchor.y - menu.height / 2 },
      { x: anchor.x - menu.width / 2, y: area.y - menu.height - margin },
      { x: anchor.x - menu.width / 2, y: area.y + area.height + margin },
    ]),
  ].map((candidate) => ({
    x: Math.max(margin, Math.min(candidate.x, viewport.width - menu.width - margin)),
    y: Math.max(margin, Math.min(candidate.y, viewport.height - menu.height - margin)),
  }));

  const score = (candidate: { x: number; y: number }) => ({
    // Controls win over source avoidance: neither the panel nor map controls may
    // become unusable just because one side of the map contains many sources.
    controlOverlap: reservedAreas.reduce((area, reserved) => area + Math.max(0,
      Math.min(candidate.x + menu.width + margin, reserved.x + reserved.width)
        - Math.max(candidate.x - margin, reserved.x)) * Math.max(0,
      Math.min(candidate.y + menu.height + margin, reserved.y + reserved.height)
        - Math.max(candidate.y - margin, reserved.y)), 0),
    markers: avoidPoints.filter((point) => point.x >= candidate.x - 14
      && point.x <= candidate.x + menu.width + 14 && point.y >= candidate.y - 14
      && point.y <= candidate.y + menu.height + 14).length,
  });
  return candidates.reduce((best, candidate) => {
    const nextScore = score(candidate);
    const bestScore = score(best);
    return nextScore.controlOverlap < bestScore.controlOverlap
      || (nextScore.controlOverlap === bestScore.controlOverlap && nextScore.markers < bestScore.markers)
      ? candidate : best;
  });
}

export function SkyContextMenu({ target, position, visibleCatalogIds, onDismiss, onSourcesChange,
  mapBoundaryRef, projectToScreen }: SkyContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const targetKey = `${target.raDeg}:${target.decDeg}`;
  const visibilityKey = visibleCatalogIds.join('|');
  const targetKeyRef = useRef(targetKey);
  const visibilityKeyRef = useRef(visibilityKey);
  targetKeyRef.current = targetKey;
  visibilityKeyRef.current = visibilityKey;
  const lastVisibilityKeyRef = useRef(visibilityKey);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof searchNearbyCatalogs>>>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState(position);

  const dismiss = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    requestIdRef.current += 1;
    onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    const dismissOnEscape = (event: KeyboardEvent) => {
      // The sky remains mounted across workspaces; another view owns its Escape.
      if (event.key === 'Escape' && !mapBoundaryRef?.current?.closest('[aria-hidden="true"]')) dismiss();
    };
    // This is a persistent temporary search, not a click-away menu. Navigation
    // and sidebar interaction must not destroy a completed query.
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('keydown', dismissOnEscape);
      requestRef.current?.abort();
      requestRef.current = null;
      requestIdRef.current += 1;
      onSourcesChange([]);
    };
  }, [dismiss, mapBoundaryRef, onSourcesChange]);

  const updateMenuPosition = useCallback(() => {
    const menu = menuRef.current;
    const boundary = mapBoundaryRef?.current ?? menu?.parentElement;
    if (!menu || !boundary) return;
    const rect = menu.getBoundingClientRect();
    const boundaryRect = boundary.getBoundingClientRect();
    const reservedAreas = Array.from(boundary.querySelectorAll<HTMLElement>('.float')).flatMap((element) => {
      const area = element.getBoundingClientRect();
      return area.width > 0 && area.height > 0 ? [{
        x: area.left - boundaryRect.left, y: area.top - boundaryRect.top,
        width: area.width, height: area.height,
      }] : [];
    });
    const sources = results.flatMap((result) => result.sources);
    const sourcePoints = projectToScreen
      ? sources.flatMap((source) => {
        const point = projectToScreen(source.raDeg, source.decDeg);
        return point ? [point] : [];
      })
      : [];
    setMenuPosition(chooseNearbyMenuPosition(
      position,
      { width: rect.width || menu.offsetWidth, height: rect.height || menu.offsetHeight },
      { width: boundary.clientWidth, height: boundary.clientHeight },
      [position, ...sourcePoints],
      reservedAreas,
    ));
  }, [mapBoundaryRef, position, projectToScreen, results]);

  useLayoutEffect(() => {
    updateMenuPosition();
  }, [updateMenuPosition, loading, hasSearched, requestError]);

  useEffect(() => {
    window.addEventListener('resize', updateMenuPosition);
    const boundary = mapBoundaryRef?.current;
    const observer = typeof ResizeObserver === 'undefined' || !boundary
      ? null
      : new ResizeObserver(updateMenuPosition);
    const observeLayout = () => {
      if (!boundary) return;
      observer?.observe(boundary);
      if (menuRef.current) observer?.observe(menuRef.current);
      boundary.querySelectorAll<HTMLElement>('.float').forEach((element) => observer?.observe(element));
    };
    observeLayout();
    const mutations = !boundary || typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
      observeLayout();
      updateMenuPosition();
    });
    if (boundary) mutations?.observe(boundary, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      observer?.disconnect();
      mutations?.disconnect();
    };
  }, [mapBoundaryRef, updateMenuPosition]);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    requestIdRef.current += 1;
    setLoading(false);
    setResults([]);
    setHasSearched(false);
    setRequestError(null);
    onSourcesChange([]);
  }, [target.raDeg, target.decDeg, onSourcesChange]);

  useEffect(() => {
    if (lastVisibilityKeyRef.current === visibilityKey) return;
    lastVisibilityKeyRef.current = visibilityKey;
    requestRef.current?.abort();
    requestRef.current = null;
    requestIdRef.current += 1;
    setLoading(false);
    setResults([]);
    setHasSearched(false);
    setRequestError(null);
    onSourcesChange([]);
  }, [visibilityKey, onSourcesChange]);

  const search = async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const requestId = ++requestIdRef.current;
    const requestTargetKey = targetKey;
    const requestVisibilityKey = visibilityKey;
    setLoading(true);
    setHasSearched(true);
    setResults([]);
    setRequestError(null);
    onSourcesChange([]);
    try {
      const nextResults = await searchNearbyCatalogs({
        raDeg: target.raDeg,
        decDeg: target.decDeg,
        radiusDeg: DEFAULT_NEARBY_RADIUS_DEG,
        visibleCatalogIds,
        signal: controller.signal,
      });
      if (controller.signal.aborted || requestId !== requestIdRef.current || requestTargetKey !== targetKeyRef.current || requestVisibilityKey !== visibilityKeyRef.current) return;
      setResults(nextResults);
      onSourcesChange(nextResults.flatMap((result) => result.sources));
    } catch (error) {
      if (controller.signal.aborted || requestId !== requestIdRef.current || requestTargetKey !== targetKeyRef.current || requestVisibilityKey !== visibilityKeyRef.current) return;
      setRequestError(error instanceof Error ? error.message : 'Nearby catalog search failed.');
    } finally {
      if (!controller.signal.aborted && requestId === requestIdRef.current && requestTargetKey === targetKeyRef.current && requestVisibilityKey === visibilityKeyRef.current) {
        setLoading(false);
      }
    }
  };

  const sources = results.flatMap((result) => result.sources);
  const errors = results.filter((result) => result.error);
  const hasAnyResults = results.some((result) => result.sources.length > 0);

  return (
    <div
      ref={menuRef}
      className="sky-context-menu"
      role="dialog"
      aria-label="Nearby catalog search"
      style={{ left: menuPosition.x, top: menuPosition.y }}
    >
      <div className="sky-context-menu__header">
        <strong>Pinned sky position</strong>
        <button type="button" className="sky-context-menu__close" aria-label="Close nearby search" onClick={dismiss}>×</button>
      </div>
      <p className="sky-context-menu__coordinates">
        RA {target.raDeg.toFixed(4)}°, Dec {target.decDeg.toFixed(4)}°
      </p>
      <p className="sky-context-menu__legend">
        <span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1v5m0 8v5M1 10h5m8 0h5M10 6l4 4-4 4-4-4Z" /></svg>Search origin</span>
        <span><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5" /></svg>Catalog sources</span>
      </p>
      <p className="sky-context-menu__radius">Search radius: {DEFAULT_NEARBY_RADIUS_DEG}°</p>
      <button type="button" className="sky-context-menu__search" onClick={() => void search()} disabled={loading}>
        {loading ? 'Searching…' : 'Search nearby catalogs'}
      </button>
      {loading && <p className="sky-context-menu__status" role="status">Searching hidden catalogs…</p>}
      {hasSearched && !loading && !hasAnyResults && errors.length === 0 && (
        <p className="sky-context-menu__status" role="status">
          {visibleCatalogIds.length === 4 ? 'No hidden catalogs to search.' : 'No nearby sources found.'}
        </p>
      )}
      {requestError && <p className="sky-context-menu__error" role="alert">{requestError}</p>}
      {errors.length > 0 && (
        <p className="sky-context-menu__error" role="alert">
          {hasAnyResults ? 'Some catalogs could not be searched.' : 'Nearby search could not reach some catalogs.'}
          {' '}{errors.map((result) => `${result.catalogLabel}: ${result.error}`).join(' ')}
        </p>
      )}
      {sources.length > 0 && (
        <ul className="sky-context-menu__results" aria-label="Nearby sources">
          {results.filter((result) => result.sources.length > 0).map((result) => (
            <li key={result.catalogId}>
              <strong>{result.catalogLabel}</strong>
              <ul>
                {result.sources.map((source) => (
                  <li key={`${source.catalogId}:${source.id}`}>
                    <span>{String(source.data.name ?? source.id)}</span>
                    <span className="sky-context-menu__source-coordinates">
                      {source.raDeg.toFixed(4)}°, {source.decDeg.toFixed(4)}°
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <span className="sky-context-menu__hint">Temporary marker · not saved</span>
    </div>
  );
}
