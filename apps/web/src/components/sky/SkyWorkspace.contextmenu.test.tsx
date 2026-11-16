// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { aladin, catalog, marker, viewer, viewportCallbacks } = vi.hoisted(() => ({
  aladin: vi.fn(),
  catalog: vi.fn(),
  marker: vi.fn(),
  viewportCallbacks: new Map<string, () => void>(),
  viewer: {
    addCatalog: vi.fn(),
    getFoV: vi.fn(() => [180, 180]),
    getRaDec: vi.fn(() => [0, 0]),
    getSize: vi.fn(() => [800, 400]),
    on: vi.fn((event: string, callback?: () => void) => {
      if (callback) viewportCallbacks.set(event, callback);
      else viewportCallbacks.delete(event);
    }),
    pix2world: vi.fn(() => [12, -3]),
    world2pix: vi.fn(() => [400, 200]),
    setImageLayer: vi.fn(),
    hidePopup: vi.fn(),
  },
}));

vi.mock('aladin-lite', () => ({ default: { init: Promise.resolve(), aladin, catalog, marker } }));
vi.mock('../../api/catalogPopup', () => ({
  installCatalogPopupControls: vi.fn((_root, _hide, adapter) => adapter.subscribeToViewportChanges(() => {})),
}));
vi.mock('../../core/serviceWorkerControl', () => ({ ensureServiceWorkerControl: vi.fn(async () => 'controlled') }));

import { SkyWorkspace } from './SkyWorkspace';
import { App } from '../../app/App';
import { api } from '../../api/api';
vi.mock('../spectral/SpectralLab', () => ({ SpectralLab: () => <div>Spectral Lab</div> }));
import { searchNearbyCatalogs } from '../../api/nearbyCatalogs';
vi.mock('../../api/nearbyCatalogs', () => ({ DEFAULT_NEARBY_RADIUS_DEG: 0.5, searchNearbyCatalogs: vi.fn() }));

class TestMessageChannel {
  port1: { onmessage: ((event: { data: { ok: boolean } }) => void) | null } = { onmessage: null };
  port2 = { postMessage: (data: { ok: boolean }) => this.port1.onmessage?.({ data }) };
}

describe('SkyWorkspace right-click pinning', () => {
  let previousServiceWorker: PropertyDescriptor | undefined;

  beforeEach(() => {
    aladin.mockReset();
    catalog.mockReset();
    marker.mockReset();
    viewportCallbacks.clear();
    viewer.world2pix.mockReset().mockReturnValue([400, 200]);
    viewer.addCatalog.mockReset();
    viewer.hidePopup.mockReset();
    viewer.pix2world.mockReset().mockReturnValue([12, -3]);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    aladin.mockReturnValue(viewer);
    catalog.mockImplementation(() => ({ addSources: vi.fn(), remove: vi.fn(), removeSources: vi.fn(), hide: vi.fn(), show: vi.fn() }));
    marker.mockImplementation((ra: number, dec: number) => ({ ra, dec }));
    vi.stubGlobal('MessageChannel', TestMessageChannel);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => [
        'dataproduct_type=cube',
        'hips_cube_depth=1',
        'data_cube_crval3_arr=2.0',
        'hips_version=1.4',
        'hips_frame=ICRS',
        'hips_order=3',
        'hips_order_min=0',
        'hips_tile_width=512',
        'hips_tile_format=png',
      ].join('\n'),
    })));

    const worker = {
      postMessage: (_message: unknown, ports?: TestMessageChannel['port2'][]) => ports?.[0]?.postMessage({ ok: true }),
    };
    const registration = { active: worker, waiting: null, installing: null };
    previousServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn(async () => registration), ready: Promise.resolve(registration), controller: worker,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (previousServiceWorker) Object.defineProperty(navigator, 'serviceWorker', previousServiceWorker);
    else Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('keeps the map controls working while the region tool is active', async () => {
    const setFoV = vi.fn();
    Object.assign(viewer, { setFoV });
    const { container } = render(
      <SkyWorkspace
        activeJob={null}
        onStartJob={async () => {}}
        onOpenPlate={() => {}}
        onViewSpectrum={() => {}}
        onRetryJob={() => {}}
      />,
    );
    await waitFor(() => expect(viewer.addCatalog).toHaveBeenCalled());
    const shell = container.querySelector('.aladin-shell') as HTMLElement;
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.assign(shell, { setPointerCapture: vi.fn() });
    const canvas = document.createElement('canvas');
    container.querySelector('#aladin-view')?.append(canvas);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Select Region' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Select Region' }));
    expect(screen.getByRole('button', { name: 'Select Region' }).getAttribute('aria-pressed')).toBe('true');

    // Pressing a dock button must not start a selection rectangle.
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    fireEvent.pointerDown(zoomIn, { clientX: 700, clientY: 30 });
    fireEvent.pointerMove(shell, { clientX: 600, clientY: 120 });
    fireEvent.pointerUp(zoomIn, { clientX: 700, clientY: 30 });
    fireEvent.click(zoomIn);
    expect(container.querySelector('.selection-box-overlay')).toBeNull();
    expect(setFoV).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Select Region' }).getAttribute('aria-pressed')).toBe('true');

    // Dragging on the map itself still draws the rectangle.
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(shell, { clientX: 220, clientY: 180 });
    expect(container.querySelector('.selection-box-overlay')).not.toBeNull();
  });

  it('pins the clicked sky coordinate during capture before Aladin stops native propagation', async () => {
    const { container } = render(
      <SkyWorkspace
        activeJob={null}
        onStartJob={async () => {}}
        onOpenPlate={() => {}}
        onViewSpectrum={() => {}}
        onRetryJob={() => {}}
      />,
    );
    await waitFor(() => expect(viewer.addCatalog).toHaveBeenCalled());

    const shell = container.querySelector('.aladin-shell') as HTMLElement;
    Object.defineProperty(shell, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(shell, 'clientHeight', { configurable: true, value: 400 });
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, right: 810, bottom: 420, width: 800, height: 400, x: 10, y: 20,
      toJSON: () => ({}),
    } as DOMRect);
    const canvas = document.createElement('canvas');
    container.querySelector('#aladin-view')?.append(canvas);
    canvas.addEventListener('contextmenu', (event) => event.stopPropagation());

    const nativeMouseDown = vi.fn();
    canvas.addEventListener('mousedown', nativeMouseDown);
    fireEvent.mouseDown(canvas, { button: 2 });
    expect(nativeMouseDown).not.toHaveBeenCalled();
    fireEvent.contextMenu(canvas, { clientX: 410, clientY: 220 });

    const dialog = await screen.findByRole('dialog', { name: 'Nearby catalog search' });
    expect(dialog.textContent).toContain('RA 12.0000°, Dec -3.0000°');
    expect(marker).toHaveBeenCalledWith(12, -3, expect.any(Object));

    // The pin is owned by our dark panel, never Aladin's native white popup.
    expect(marker.mock.calls.at(-1)?.[2]).not.toHaveProperty('popupTitle');
    expect(viewer.hidePopup).toHaveBeenCalled();
    vi.mocked(searchNearbyCatalogs).mockResolvedValue([{
      catalogId: 'gaia', catalogLabel: 'Gaia DR3',
      sources: [{ id: 'nearby-1', catalogId: 'gaia', catalogLabel: 'Gaia DR3', raDeg: 12.2, decDeg: -3.4, data: {} }],
    }]);
    fireEvent.click(screen.getByRole('button', { name: 'Search nearby catalogs' }));
    expect(await screen.findByText('nearby-1')).toBeTruthy();
    const nearbyLayer = catalog.mock.results.at(-1)?.value;
    nearbyLayer.remove.mockClear();
    fireEvent.pointerDown(canvas, { button: 0 });
    fireEvent.mouseDown(canvas, { button: 0 });
    fireEvent.click(canvas);
    expect(screen.getByText('nearby-1')).toBeTruthy();
    expect(nearbyLayer.remove).not.toHaveBeenCalled();

    const initialLeft = dialog.style.left;
    viewer.world2pix.mockReturnValue([500, 140]);
    viewportCallbacks.get('positionChanged')?.();
    await waitFor(() => expect(dialog.style.left).not.toBe(initialLeft));
    const afterPanLeft = dialog.style.left;
    viewer.world2pix.mockReturnValue([600, 100]);
    viewportCallbacks.get('zoomChanged')?.();
    await waitFor(() => expect(dialog.style.left).not.toBe(afterPanLeft));
    expect(dialog.style.top).not.toBe('200px');
    expect(screen.getByText('nearby-1')).toBeTruthy();
    // A centered zoom must reproject result positions even if the pin has not moved.
    viewer.world2pix.mockClear();
    viewportCallbacks.get('zoomChanged')?.();
    await waitFor(() => expect(viewer.world2pix).toHaveBeenCalledWith(12.2, -3.4));
    viewer.pix2world.mockReturnValue([13, -4]);
    fireEvent.contextMenu(canvas, { clientX: 420, clientY: 230 });
    await waitFor(() => expect(screen.queryByText('nearby-1')).toBeNull());
    expect(dialog.textContent).toContain('RA 13.0000°, Dec -4.0000°');
    expect(nearbyLayer.remove).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close nearby search' }));
    expect(screen.queryByRole('dialog', { name: 'Nearby catalog search' })).toBeNull();
    expect(nearbyLayer.remove).toHaveBeenCalled();
  });
  it('keeps a labeled distinct origin and loaded results through real workspace navigation', async () => {
    window.location.hash = '#/sky';
    vi.spyOn(api, 'getHealth').mockResolvedValue({ status: 'ok' } as Awaited<ReturnType<typeof api.getHealth>>);
    vi.spyOn(api, 'listSelections').mockResolvedValue({ items: [], next_before: null });
    vi.mocked(searchNearbyCatalogs).mockReset().mockResolvedValue([{
      catalogId: 'gaia', catalogLabel: 'Gaia DR3',
      sources: [{ id: 'retained-result', catalogId: 'gaia', catalogLabel: 'Gaia DR3', raDeg: 12.2, decDeg: -3.4, data: {} }],
    }]);
    const { container } = render(<App />);
    await waitFor(() => expect(viewer.addCatalog).toHaveBeenCalled());
    const shell = container.querySelector('.aladin-shell') as HTMLElement;
    Object.defineProperty(shell, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(shell, 'clientHeight', { configurable: true, value: 600 });
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 600 } as DOMRect);
    const canvas = document.createElement('canvas');
    container.querySelector('#aladin-view')?.append(canvas);
    fireEvent.contextMenu(canvas, { clientX: 400, clientY: 200 });
    fireEvent.click(screen.getByRole('button', { name: 'Search nearby catalogs' }));
    expect(await screen.findByText('retained-result')).toBeTruthy();
    const origin = screen.queryByRole('img', { name: 'Search origin: original pinned sky position' });
    expect.soft(origin).not.toBeNull();
    expect.soft(screen.queryByText('Search origin')).not.toBeNull();
    const resultLayer = catalog.mock.results.at(-1)?.value;
    resultLayer.remove.mockClear();
    const records = screen.getByRole('button', { name: 'Records' });
    fireEvent.pointerDown(records);
    fireEvent.click(records);
    await waitFor(() => expect(container.querySelector('.sky-layer')?.getAttribute('aria-hidden')).toBe('true'));
    // Escape in another workspace must not silently clear hidden sky state either.
    fireEvent.keyDown(document, { key: 'Escape' });
    const sky = screen.getByRole('button', { name: 'Sky' });
    fireEvent.pointerDown(sky);
    fireEvent.click(sky);
    await waitFor(() => expect(container.querySelector('.sky-layer')?.getAttribute('aria-hidden')).toBe('false'));
    expect(screen.getByText('retained-result')).toBeTruthy();
    expect(searchNearbyCatalogs).toHaveBeenCalledTimes(1);
    expect(resultLayer.remove).not.toHaveBeenCalled();
  });

});
