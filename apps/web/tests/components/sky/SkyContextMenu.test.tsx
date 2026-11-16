// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchNearbyCatalogs } from '../../../src/api/nearbyCatalogs';
import { chooseNearbyMenuPosition, SkyContextMenu } from '../../../src/components/sky/SkyContextMenu';

vi.mock('../../../src/api/nearbyCatalogs', () => ({
  DEFAULT_NEARBY_RADIUS_DEG: 0.1,
  searchNearbyCatalogs: vi.fn(),
}));

describe('SkyContextMenu', () => {
  afterEach(() => cleanup());

  it('searches only hidden catalogs and shows returned source coordinates', async () => {
    vi.mocked(searchNearbyCatalogs).mockResolvedValue([{
      catalogId: 'gaia', catalogLabel: 'Gaia DR3', error: undefined,
      sources: [{ id: 'g-1', catalogId: 'gaia', catalogLabel: 'Gaia DR3', raDeg: 12.2, decDeg: -3.4, data: {} }],
    }]);
    render(<SkyContextMenu target={{ raDeg: 12, decDeg: -3 }} position={{ x: 40, y: 50 }}
      visibleCatalogIds={['featured', 'simbad']} onDismiss={vi.fn()} onSourcesChange={vi.fn()} />);

    expect(screen.getByText('Search radius: 0.1°')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Search nearby catalogs' }));
    await waitFor(() => expect(searchNearbyCatalogs).toHaveBeenCalledWith(expect.objectContaining({
      raDeg: 12, decDeg: -3, visibleCatalogIds: ['featured', 'simbad'], signal: expect.any(AbortSignal),
    })));
    expect(await screen.findByText('Gaia DR3')).toBeTruthy();
    expect(screen.getByText('12.2000°, -3.4000°')).toBeTruthy();
  });

  it('removes results from a catalog as soon as that catalog becomes visible', async () => {
    vi.mocked(searchNearbyCatalogs).mockResolvedValue([{
      catalogId: 'gaia', catalogLabel: 'Gaia DR3', error: undefined,
      sources: [{ id: 'g-1', catalogId: 'gaia', catalogLabel: 'Gaia DR3', raDeg: 12.2, decDeg: -3.4, data: {} }],
    }]);
    const onSourcesChange = vi.fn();
    const props = {
      target: { raDeg: 12, decDeg: -3 }, position: { x: 40, y: 50 },
      onDismiss: vi.fn(), onSourcesChange,
    };
    const { rerender } = render(<SkyContextMenu {...props} visibleCatalogIds={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Search nearby catalogs' }));
    expect(await screen.findByText('12.2000°, -3.4000°')).toBeTruthy();
    expect(onSourcesChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ catalogId: 'gaia' })]));

    rerender(<SkyContextMenu {...props} visibleCatalogIds={['gaia']} />);

    await waitFor(() => expect(screen.queryByText('12.2000°, -3.4000°')).toBeNull());
    expect(onSourcesChange).toHaveBeenLastCalledWith([]);
  });

  it('aborts in-flight results when the catalog visibility changes', async () => {
    let resolveQuery: ((results: Awaited<ReturnType<typeof searchNearbyCatalogs>>) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    vi.mocked(searchNearbyCatalogs).mockImplementation(({ signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => { resolveQuery = resolve; });
    });
    const props = {
      target: { raDeg: 12, decDeg: -3 }, position: { x: 40, y: 50 },
      onDismiss: vi.fn(), onSourcesChange: vi.fn(),
    };
    const { rerender } = render(<SkyContextMenu {...props} visibleCatalogIds={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Search nearby catalogs' }));
    expect(requestSignal?.aborted).toBe(false);
    rerender(<SkyContextMenu {...props} visibleCatalogIds={['gaia']} />);
    expect(requestSignal?.aborted).toBe(true);

    resolveQuery?.([{
      catalogId: 'gaia', catalogLabel: 'Gaia DR3', error: undefined,
      sources: [{ id: 'g-late', catalogId: 'gaia', catalogLabel: 'Gaia DR3', raDeg: 12.2, decDeg: -3.4, data: {} }],
    }]);
    await waitFor(() => expect(screen.queryByText('g-late')).toBeNull());
    expect(props.onSourcesChange).toHaveBeenLastCalledWith([]);
  });

  it('aborts the previous target and ignores its late response after a new pin', async () => {
    let resolveQuery: ((results: Awaited<ReturnType<typeof searchNearbyCatalogs>>) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    vi.mocked(searchNearbyCatalogs).mockImplementation(({ signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => { resolveQuery = resolve; });
    });
    const props = { position: { x: 40, y: 50 }, visibleCatalogIds: [],
      onDismiss: vi.fn(), onSourcesChange: vi.fn() };
    const { rerender } = render(<SkyContextMenu {...props} target={{ raDeg: 12, decDeg: -3 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search nearby catalogs' }));
    rerender(<SkyContextMenu {...props} target={{ raDeg: 13, decDeg: -4 }} />);
    expect(requestSignal?.aborted).toBe(true);
    resolveQuery?.([{
      catalogId: 'gaia', catalogLabel: 'Gaia DR3',
      sources: [{ id: 'old-target', catalogId: 'gaia', catalogLabel: 'Gaia DR3', raDeg: 12, decDeg: -3, data: {} }],
    }]);
    await waitFor(() => expect(screen.queryByText('old-target')).toBeNull());
    expect(props.onSourcesChange).toHaveBeenLastCalledWith([]);
  });

  it('dismisses on Escape and aborts an in-flight request', () => {
    let signal: AbortSignal | undefined;
    vi.mocked(searchNearbyCatalogs).mockImplementation(({ signal: requestSignal }) => {
      signal = requestSignal;
      return new Promise(() => {});
    });
    const onDismiss = vi.fn();
    render(<SkyContextMenu target={{ raDeg: 12, decDeg: -3 }} position={{ x: 40, y: 50 }}
      visibleCatalogIds={[]} onDismiss={onDismiss} onSourcesChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search nearby catalogs' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
  });

  it('keeps the pin and results open when interacting elsewhere inside the map', () => {
    const onDismiss = vi.fn();
    const mapBoundaryRef = createRef<HTMLDivElement>();
    const { container } = render(
      <div ref={mapBoundaryRef} aria-label="Map boundary">
        <button type="button">Pan map</button>
        <SkyContextMenu target={{ raDeg: 12, decDeg: -3 }} position={{ x: 40, y: 50 }}
          visibleCatalogIds={[]} onDismiss={onDismiss} onSourcesChange={vi.fn()}
          mapBoundaryRef={mapBoundaryRef} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Pan map' }));

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('chooses a viewport-fitting popup position that avoids the pin and source markers', () => {
    const position = chooseNearbyMenuPosition(
      { x: 300, y: 200 },
      { width: 150, height: 100 },
      { width: 600, height: 400 },
      [{ x: 300, y: 200 }, { x: 150, y: 200 }],
    );

    expect(position).toEqual({ x: 320, y: 80 });
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
  });
  it('uses a clear map edge when the source cluster blocks every anchor-adjacent position', () => {
    const points = [{ x: 500, y: 100 }, { x: 500, y: 300 }, { x: 200, y: 100 }, { x: 200, y: 300 }];
    const position = chooseNearbyMenuPosition(
      { x: 400, y: 200 }, { width: 300, height: 300 }, { width: 1200, height: 400 }, points,
    );
    for (const point of points) {
      expect(point.x < position.x - 14 || point.x > position.x + 314
        || point.y < position.y - 14 || point.y > position.y + 314).toBe(true);
    }
  });

  it('prioritizes control and HUD rectangles over crowded marker placement', () => {
    const position = chooseNearbyMenuPosition(
      { x: 1140, y: 200 }, { width: 300, height: 200 }, { width: 1200, height: 600 },
      Array.from({ length: 30 }, (_, i) => ({ x: 850 + i, y: 480 })),
      [{ x: 850, y: 0, width: 350, height: 300 }],
    );
    expect(position.y >= 308 || position.x + 300 <= 842).toBe(true);
  });

  it('measures actual floating map controls when positioning the panel', () => {
    const mapBoundaryRef = createRef<HTMLDivElement>();
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, width, height, right: left + width, bottom: top + height,
    } as DOMRect);
    const dimensions = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('sky-context-menu')) return rect(0, 0, 300, 200);
      if (this.classList.contains('float')) return rect(850, 0, 350, 300);
      return rect(0, 0, 1200, 600);
    });
    const { container, rerender } = render(<div ref={mapBoundaryRef}>
      <div className="float" role="toolbar" aria-label="Reserved map controls" />
    </div>);
    Object.defineProperty(mapBoundaryRef.current, 'clientWidth', { configurable: true, value: 1200 });
    Object.defineProperty(mapBoundaryRef.current, 'clientHeight', { configurable: true, value: 600 });
    rerender(<div ref={mapBoundaryRef}>
      <div className="float" role="toolbar" aria-label="Reserved map controls" />
      <SkyContextMenu target={{ raDeg: 12, decDeg: -3 }} position={{ x: 1140, y: 200 }}
        visibleCatalogIds={[]} onDismiss={vi.fn()} onSourcesChange={vi.fn()} mapBoundaryRef={mapBoundaryRef} />
    </div>);
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(parseFloat(panel.style.top) >= 308 || parseFloat(panel.style.left) + 300 <= 842).toBe(true);
    dimensions.mockRestore();
  });

  it('uses bounded reduced-motion-aware state feedback without animating coordinate positions', async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync: (path: string, encoding: string) => string }>('node:fs');
    const css = readFileSync('src/components/sky/SkyContextMenu.css', 'utf8');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toMatch(/animation:\s*nearby-panel-reveal\s+180ms/);
    expect(css).not.toMatch(/transition:[^;]*(?:\bleft\b|\btop\b|\ball\b)/);
  });

});
