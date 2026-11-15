const POPUP_MARGIN = 8;
const MARKER_SIZE = 12;
const ARROW_SIZE = 12;
const POSITION_SETTLE_DELAY = 100;

export interface PopupAnchor {
  x: number;
  y: number;
}

export interface CatalogPopupAdapter {
  projectSource: (ra: number, dec: number) => PopupAnchor | null;
  reopenPopup: (ra: number, dec: number, title: string, description: string) => void;
  subscribeToViewportChanges: (callback: () => void) => () => void;
}

interface CatalogPopupSnapshot {
  ra: number;
  dec: number;
  title: string;
  description: string;
}

function markerIntersectsMap(map: HTMLElement, point: PopupAnchor): boolean {
  const radius = MARKER_SIZE / 2;
  return point.x + radius >= 0
    && point.y + radius >= 0
    && point.x - radius <= map.clientWidth
    && point.y - radius <= map.clientHeight;
}

function markerFitsMap(map: HTMLElement, point: PopupAnchor): boolean {
  const radius = MARKER_SIZE / 2;
  return point.x - radius >= 0
    && point.y - radius >= 0
    && point.x + radius <= map.clientWidth
    && point.y + radius <= map.clientHeight;
}

export function positionCatalogPopup(
  map: HTMLElement,
  popup: HTMLElement,
  anchor: PopupAnchor,
): 'above' | 'below' | 'left' | 'right' {
  if (popup.style.display === 'none') return 'above';
  const card = popup.querySelector<HTMLElement>('.aladin-popup');
  // Aladin measures the container (card plus arrow) before positioning it.
  const width = popup.offsetWidth || card?.offsetWidth || 0;
  const height = popup.offsetHeight || card?.offsetHeight || 0;
  const radius = MARKER_SIZE / 2;
  const centeredLeft = anchor.x - width / 2;
  const centeredTop = anchor.y - height / 2;
  const candidates = [
    {
      side: 'above' as const,
      left: centeredLeft,
      // Match Aladin's native anchored placement when it fits: the arrow sits
      // immediately above the source instead of moving the popup over it.
      top: anchor.y - height + radius,
    },
    {
      side: 'right' as const,
      left: anchor.x + radius + ARROW_SIZE,
      top: centeredTop,
    },
    {
      side: 'left' as const,
      left: anchor.x - radius - ARROW_SIZE - width,
      top: centeredTop,
    },
    {
      side: 'below' as const,
      left: centeredLeft,
      top: anchor.y + radius + ARROW_SIZE,
    },
  ];
  const fit = candidates.find(({ left, top }) =>
    left >= POPUP_MARGIN && top >= POPUP_MARGIN
      && left + width <= map.clientWidth - POPUP_MARGIN
      && top + height <= map.clientHeight - POPUP_MARGIN,
  );
  const position = fit ?? candidates.reduce((best, candidate) => {
    const score = Math.min(candidate.left - POPUP_MARGIN, candidate.top - POPUP_MARGIN,
      map.clientWidth - POPUP_MARGIN - candidate.left - width,
      map.clientHeight - POPUP_MARGIN - candidate.top - height);
    const bestScore = Math.min(best.left - POPUP_MARGIN, best.top - POPUP_MARGIN,
      map.clientWidth - POPUP_MARGIN - best.left - width,
      map.clientHeight - POPUP_MARGIN - best.top - height);
    return score > bestScore ? candidate : best;
  });
  const left = Math.min(Math.max(POPUP_MARGIN, position.left), Math.max(POPUP_MARGIN, map.clientWidth - width - POPUP_MARGIN));
  const top = Math.min(Math.max(POPUP_MARGIN, position.top), Math.max(POPUP_MARGIN, map.clientHeight - height - POPUP_MARGIN));
  const positionClass = `popup-${position.side}`;
  for (const side of ['above', 'below', 'left', 'right'] as const) {
    const className = `popup-${side}`;
    if (className !== positionClass) popup.classList.remove(className);
  }
  popup.classList.add(positionClass);
  if (popup.style.left !== `${left}px`) popup.style.left = `${left}px`;
  if (popup.style.top !== `${top}px`) popup.style.top = `${top}px`;
  return position.side;
}

export function installCatalogPopupControls(
  map: HTMLElement,
  hidePopup: () => void,
  adapter?: CatalogPopupAdapter,
): () => void {
  let popup: HTMLElement | null = null;
  let popupObserver: MutationObserver | null = null;
  let contentObserver: MutationObserver | null = null;
  let closeButton: HTMLElement | null = null;
  let lastAppliedPosition = '';
  let anchor: PopupAnchor | null = null;
  let popupWidth = 0;
  let popupHeight = 0;
  let currentPopup: CatalogPopupSnapshot | null = null;
  let offscreenPopup: CatalogPopupSnapshot | null = null;
  let dismissedByUser = false;
  let scheduledFrame: number | null = null;
  let scheduledPositionTimer: number | null = null;

  const readPopupSnapshot = (): CatalogPopupSnapshot | null => {
    if (!popup) return null;
    const title = popup.querySelector<HTMLElement>('.aladin-popupTitle')?.textContent?.trim() ?? '';
    const description = popup.querySelector<HTMLElement>('.aladin-popupText');
    const coordinates = description?.textContent?.match(
      /(?:Representative\s+)?Coordinates\s*\(ICRS\)\s*:\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*(?:°|deg)?\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))/i,
    );
    if (!description || !coordinates || !title) return null;
    const ra = Number(coordinates[1]);
    const dec = Number(coordinates[2]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
    return { ra, dec, title, description: description.innerHTML };
  };
  const projectPopupSource = (source: CatalogPopupSnapshot): PopupAnchor | null => {
    const point = adapter?.projectSource(source.ra, source.dec);
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  };
  const updateAnchorFromCurrentSource = (): boolean => {
    const source = offscreenPopup ?? currentPopup;
    if (source && adapter) {
      anchor = projectPopupSource(source);
      return anchor !== null;
    }
    updateAnchorFromNativePosition();
    return anchor !== null;
  };
  const dismissPopup = () => {
    dismissedByUser = true;
    currentPopup = null;
    offscreenPopup = null;
  };

  const updateAnchorFromNativePosition = () => {
    if (!popup) return;
    const positionText = `${popup.style.left}|${popup.style.top}`;
    if (positionText === lastAppliedPosition) return;
    const card = popup.querySelector<HTMLElement>('.aladin-popup');
    const measuredWidth = popup.offsetWidth || card?.offsetWidth || 0;
    const measuredHeight = popup.offsetHeight || card?.offsetHeight || 0;
    if (measuredWidth > 0) popupWidth = measuredWidth;
    if (measuredHeight > 0) popupHeight = measuredHeight;
    const width = measuredWidth || popupWidth;
    const height = measuredHeight || popupHeight;
    const left = Number.parseFloat(popup.style.left);
    const top = Number.parseFloat(popup.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      anchor = { x: left + width / 2, y: top + height - MARKER_SIZE / 2 };
    }
  };
  const updatePopupVisibility = (allowReveal: boolean) => {
    if (!popup || map.clientWidth <= 0 || map.clientHeight <= 0) return;
    if (!updateAnchorFromCurrentSource() || !anchor) {
      popup.style.visibility = 'hidden';
      return;
    }
    if (!markerIntersectsMap(map, anchor)) popup.style.visibility = 'hidden';
    else if (allowReveal && markerFitsMap(map, anchor)) popup.style.removeProperty('visibility');
  };

  const clamp = () => {
    if (!popup) return;
    if (!updateAnchorFromCurrentSource() || !anchor) {
      updatePopupVisibility(true);
      return;
    }
    positionCatalogPopup(map, popup, anchor);
    lastAppliedPosition = `${popup.style.left}|${popup.style.top}`;
    updatePopupVisibility(true);
  };
  const scheduleClamp = () => {
    if (scheduledFrame !== null) return;
    const run = () => {
      scheduledFrame = null;
      clamp();
    };
    scheduledFrame = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(run)
      : window.setTimeout(run, 0);
  };
  const scheduleSettledClamp = () => {
    if (scheduledPositionTimer !== null) window.clearTimeout(scheduledPositionTimer);
    scheduledPositionTimer = window.setTimeout(() => {
      scheduledPositionTimer = null;
      scheduleClamp();
    }, POSITION_SETTLE_DELAY);
  };

  const onPopupContentChange = () => {
    if (popup?.style.display === 'block') {
      dismissedByUser = false;
      const snapshot = readPopupSnapshot();
      if (snapshot) {
        currentPopup = snapshot;
        offscreenPopup = null;
      }
    }
    scheduleSettledClamp();
  };
  const onViewportChange = () => {
    if (!popup) return;
    const source = offscreenPopup ?? currentPopup;
    if (source && adapter) {
      const point = projectPopupSource(source);
      anchor = point;
      if (offscreenPopup) {
        if (!point || !markerFitsMap(map, point) || dismissedByUser) return;
        offscreenPopup = null;
        currentPopup = source;
        updatePopupVisibility(true);
        adapter.reopenPopup(source.ra, source.dec, source.title, source.description);
        return;
      }
      if (popup.style.display === 'block') {
        updatePopupVisibility(false);
        scheduleSettledClamp();
      }
      return;
    }
    if (popup.style.display === 'block') {
      updateAnchorFromNativePosition();
      updatePopupVisibility(false);
      scheduleSettledClamp();
    }
  };

  const onCloseClick = () => dismissPopup();
  const onCloseKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dismissPopup();
      hidePopup();
    }
  };
  const bindPopup = () => {
    if (popup) return;
    popup = map.querySelector<HTMLElement>('.aladin-popup-container');
    if (!popup) return;
    closeButton = popup.querySelector<HTMLElement>('.aladin-closeBtn');
    if (closeButton) {
      closeButton.setAttribute('role', 'button');
      closeButton.setAttribute('tabindex', '0');
      closeButton.setAttribute('aria-label', 'Close catalog details');
      closeButton.addEventListener('click', onCloseClick);
      closeButton.addEventListener('keydown', onCloseKeyDown);
    }
    popupObserver = new MutationObserver(() => {
      if (!popup) return;
      if (popup.style.display === 'none') {
        const snapshot = readPopupSnapshot() ?? currentPopup;
        if (dismissedByUser || !snapshot) {
          currentPopup = null;
          offscreenPopup = null;
          popup.style.removeProperty('visibility');
        } else {
          currentPopup = snapshot;
          const point = adapter ? projectPopupSource(snapshot) : null;
          if (adapter) anchor = point;
          else updateAnchorFromNativePosition();
          const sourceIsOffscreen = adapter
            ? !point || !markerFitsMap(map, point)
            : !anchor || !markerFitsMap(map, anchor);
          offscreenPopup = sourceIsOffscreen ? snapshot : null;
          if (sourceIsOffscreen) popup.style.visibility = 'hidden';
          else popup.style.removeProperty('visibility');
        }
        return;
      }
      if (`${popup.style.left}|${popup.style.top}` === lastAppliedPosition) return;
      updateAnchorFromCurrentSource();
      updatePopupVisibility(false);
      scheduleSettledClamp();
    });
    popupObserver.observe(popup, { attributes: true, attributeFilter: ['style'] });
    const popupText = popup.querySelector<HTMLElement>('.aladin-popupText');
    if (popupText) {
      contentObserver = new MutationObserver(onPopupContentChange);
      contentObserver.observe(popupText, { childList: true });
    }
    clamp();
    mapObserver.disconnect();
  };
  const mapObserver = new MutationObserver(bindPopup);
  mapObserver.observe(map, { childList: true, subtree: true });
  bindPopup();
  const unsubscribeViewportChanges = adapter?.subscribeToViewportChanges(onViewportChange);

  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || (popup?.style.display !== 'block' && !offscreenPopup)) return;
    dismissPopup();
    hidePopup();
  };
  document.addEventListener('keydown', onEscape);
  return () => {
    document.removeEventListener('keydown', onEscape);
    unsubscribeViewportChanges?.();
    closeButton?.removeEventListener('click', onCloseClick);
    closeButton?.removeEventListener('keydown', onCloseKeyDown);
    popupObserver?.disconnect();
    contentObserver?.disconnect();
    mapObserver.disconnect();
    if (scheduledFrame !== null) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(scheduledFrame);
      else window.clearTimeout(scheduledFrame);
    }
    if (scheduledPositionTimer !== null) window.clearTimeout(scheduledPositionTimer);
  };
}
