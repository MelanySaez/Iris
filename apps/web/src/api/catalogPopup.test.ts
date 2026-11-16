// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { installCatalogPopupControls, positionCatalogPopup } from './catalogPopup';

describe('catalog popup controls', () => {
  it('moves the popup below a near-top source instead of covering the source', () => {
    const map = document.createElement('div');
    const popup = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    popup.append(card);
    map.append(popup);
    Object.defineProperties(map, { clientWidth: { value: 600 }, clientHeight: { value: 400 } });
    Object.defineProperties(card, { offsetWidth: { value: 200 }, offsetHeight: { value: 150 } });
    Object.defineProperties(popup, { offsetWidth: { value: 200 }, offsetHeight: { value: 162 } });
    popup.style.display = 'block';

    const side = positionCatalogPopup(map, popup, { x: 250, y: 80 });
    expect(side).toBe('below');
    expect(popup.style.left).toBe('150px');
    expect(popup.style.top).toBe('98px');
    expect(popup.classList.contains('popup-below')).toBe(true);
  });

  it('preserves Aladin’s native centered arrow placement when there is room above', () => {
    const map = document.createElement('div');
    const popup = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    popup.append(card);
    map.append(popup);
    Object.defineProperties(map, { clientWidth: { value: 600 }, clientHeight: { value: 400 } });
    Object.defineProperties(card, { offsetWidth: { value: 200 }, offsetHeight: { value: 150 } });
    Object.defineProperties(popup, { offsetWidth: { value: 200 }, offsetHeight: { value: 162 } });
    popup.style.display = 'block';

    expect(positionCatalogPopup(map, popup, { x: 250, y: 200 })).toBe('above');
    expect(popup.style.left).toBe('150px');
    expect(popup.style.top).toBe('44px');
  });

  it('uses open horizontal space when the native placement does not fit above or below', () => {
    const map = document.createElement('div');
    const popup = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    popup.append(card);
    map.append(popup);
    Object.defineProperties(map, { clientWidth: { value: 600 }, clientHeight: { value: 400 } });
    Object.defineProperties(card, { offsetWidth: { value: 200 }, offsetHeight: { value: 300 } });
    Object.defineProperties(popup, { offsetWidth: { value: 200 }, offsetHeight: { value: 312 } });
    popup.style.display = 'block';

    expect(positionCatalogPopup(map, popup, { x: 250, y: 200 })).toBe('right');
    expect(popup.style.left).toBe('268px');
  });

  it('closes an open popup with Escape, but ignores Escape when it is hidden', () => {
    const map = document.createElement('div');
    const popup = document.createElement('div');
    popup.className = 'aladin-popup-container';
    popup.style.display = 'block';
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    Object.defineProperty(card, 'offsetWidth', { value: 200 });
    Object.defineProperty(card, 'offsetHeight', { value: 100 });
    popup.append(card);
    Object.defineProperty(popup, 'offsetWidth', { value: 200 });
    Object.defineProperty(popup, 'offsetHeight', { value: 112 });
    map.append(popup);
    const hidePopup = vi.fn();
    const dispose = installCatalogPopupControls(map, hidePopup);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(hidePopup).toHaveBeenCalledOnce();
    popup.style.display = 'none';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(hidePopup).toHaveBeenCalledOnce();
    dispose();
  });

  it('hides an Aladin-hidden popup when Escape dismisses its offscreen selection', async () => {
    vi.useFakeTimers();
    const map = document.createElement('div');
    const popup = document.createElement('div');
    popup.className = 'aladin-popup-container';
    popup.style.display = 'block';
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    const title = document.createElement('div');
    title.className = 'aladin-popupTitle';
    title.textContent = 'RW Aurigae';
    const text = document.createElement('div');
    text.className = 'aladin-popupText';
    text.textContent = 'Coordinates (ICRS): 76.956526°, 30.401438°';
    card.append(title, text);
    popup.append(card);
    Object.defineProperties(map, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    Object.defineProperties(card, { offsetWidth: { value: 200 }, offsetHeight: { value: 100 } });
    Object.defineProperties(popup, { offsetWidth: { value: 200 }, offsetHeight: { value: 112 } });
    map.append(popup);

    let sourcePoint: { x: number; y: number } | null = { x: 200, y: 150 };
    let onViewportChange: (() => void) | undefined;
    const hidePopup = vi.fn();
    const reopenPopup = vi.fn();
    const dispose = installCatalogPopupControls(map, hidePopup, {
      projectSource: () => sourcePoint,
      reopenPopup,
      subscribeToViewportChanges: (callback) => {
        onViewportChange = callback;
        return () => {};
      },
    });

    popup.style.display = 'none';
    sourcePoint = { x: -20, y: 150 };
    await Promise.resolve();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(hidePopup).toHaveBeenCalledOnce();

    sourcePoint = { x: 12, y: 150 };
    onViewportChange?.();
    expect(reopenPopup).not.toHaveBeenCalled();

    dispose();
    vi.useRealTimers();
  });

  it('binds a popup inserted after setup and makes its close control keyboard accessible', async () => {
    const map = document.createElement('div');
    Object.defineProperties(map, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    const hidePopup = vi.fn();
    const dispose = installCatalogPopupControls(map, hidePopup);
    const popup = document.createElement('div');
    popup.className = 'aladin-popup-container';
    popup.style.display = 'block';
    popup.style.top = '44px';
    popup.style.left = '150px';
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    Object.defineProperty(card, 'offsetWidth', { value: 200 });
    Object.defineProperty(card, 'offsetHeight', { value: 100 });
    popup.append(card);
    Object.defineProperty(popup, 'offsetWidth', { value: 200 });
    Object.defineProperty(popup, 'offsetHeight', { value: 112 });
    const close = document.createElement('a');
    close.className = 'aladin-closeBtn';
    popup.append(close);
    map.append(popup);
    await Promise.resolve();

    expect(popup.classList.contains('popup-above')).toBe(true);
    expect(close.getAttribute('tabindex')).toBe('0');
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(hidePopup).toHaveBeenCalledOnce();
    dispose();
  });

  it('coalesces popup text and position changes into one settled frame', async () => {
    vi.useFakeTimers();
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const map = document.createElement('div');
    const popup = document.createElement('div');
    popup.className = 'aladin-popup-container';
    popup.style.display = 'block';
    popup.style.left = '150px';
    popup.style.top = '44px';
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    const text = document.createElement('div');
    text.className = 'aladin-popupText';
    card.append(text);
    popup.append(card, document.createElement('div'));
    Object.defineProperties(map, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    Object.defineProperties(card, { offsetWidth: { value: 200 }, offsetHeight: { value: 100 } });
    Object.defineProperties(popup, { offsetWidth: { value: 200 }, offsetHeight: { value: 112 } });
    map.append(popup);

    const dispose = installCatalogPopupControls(map, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    callbacks.length = 0;

    popup.style.left = '300px';
    popup.style.top = '0px';
    popup.style.left = '290px';
    text.innerHTML = '<a>Updated catalog details</a>';
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.classList.contains('popup-left')).toBe(true);
    expect(callbacks).toHaveLength(0);

    dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for Aladin to stop moving the popup before clamping it at an edge', async () => {
    vi.useFakeTimers();
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const map = document.createElement('div');
    const popup = document.createElement('div');
    popup.className = 'aladin-popup-container';
    popup.style.display = 'block';
    popup.style.left = '150px';
    popup.style.top = '44px';
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    const text = document.createElement('div');
    text.className = 'aladin-popupText';
    card.append(text);
    popup.append(card, document.createElement('div'));
    Object.defineProperties(map, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    Object.defineProperties(card, { offsetWidth: { value: 200 }, offsetHeight: { value: 100 } });
    Object.defineProperties(popup, { offsetWidth: { value: 200 }, offsetHeight: { value: 112 } });
    map.append(popup);

    const dispose = installCatalogPopupControls(map, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    callbacks.length = 0;

    popup.style.left = '-13px';
    popup.style.top = '-118px';
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(40);
    popup.style.left = '-12px';
    popup.style.top = '-116px';
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(99);
    expect(callbacks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.style.top).toBe('8px');
    expect(callbacks).toHaveLength(0);

    dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('hides the popup when its marker leaves the viewport and restores it when fully visible', async () => {
    vi.useFakeTimers();
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const map = document.createElement('div');
    const popup = document.createElement('div');
    popup.className = 'aladin-popup-container';
    popup.style.display = 'block';
    popup.style.left = '150px';
    popup.style.top = '44px';
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    const text = document.createElement('div');
    text.className = 'aladin-popupText';
    card.append(text);
    popup.append(card, document.createElement('div'));
    Object.defineProperties(map, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    Object.defineProperties(card, { offsetWidth: { value: 200 }, offsetHeight: { value: 100 } });
    Object.defineProperties(popup, { offsetWidth: { value: 200 }, offsetHeight: { value: 112 } });
    map.append(popup);
    const hidePopup = vi.fn();
    const dispose = installCatalogPopupControls(map, hidePopup);
    await vi.advanceTimersByTimeAsync(0);
    callbacks.length = 0;

    popup.style.top = '-118px';
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.style.visibility).toBe('hidden');
    expect(popup.style.top).toBe('-118px');
    expect(popup.style.display).toBe('block');
    expect(hidePopup).not.toHaveBeenCalled();

    const settlePopup = async () => {
      await vi.advanceTimersByTimeAsync(100);
      callbacks.shift()?.(0);
      await vi.advanceTimersByTimeAsync(0);
    };

    popup.style.top = '-104px';
    await vi.advanceTimersByTimeAsync(0);
    await settlePopup();
    expect(popup.style.visibility).toBe('hidden');

    popup.style.top = '-94px';
    await vi.advanceTimersByTimeAsync(0);
    await settlePopup();
    expect(popup.style.visibility).not.toBe('hidden');
    expect(popup.style.display).toBe('block');
    expect(hidePopup).not.toHaveBeenCalled();

    dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reopens an Aladin-hidden popup when its marker returns fully into view', async () => {
    vi.useFakeTimers();
    const map = document.createElement('div');
    const popup = document.createElement('div');
    popup.className = 'aladin-popup-container';
    popup.style.display = 'block';
    popup.style.left = '150px';
    popup.style.top = '44px';
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    const title = document.createElement('div');
    title.className = 'aladin-popupTitle';
    title.textContent = 'RW Aurigae';
    const text = document.createElement('div');
    text.className = 'aladin-popupText';
    text.innerHTML = 'Coordinates (ICRS): 76.956526°, 30.401438°';
    card.append(title, text);
    popup.append(card, document.createElement('div'));
    Object.defineProperties(map, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    Object.defineProperties(card, { offsetWidth: { value: 200 }, offsetHeight: { value: 100 } });
    Object.defineProperties(popup, { offsetWidth: { value: 200 }, offsetHeight: { value: 112 } });
    map.append(popup);

    let sourcePoint: { x: number; y: number } | null = { x: 200, y: 150 };
    let onViewportChange: (() => void) | undefined;
    const reopenPopup = vi.fn();
    const unsubscribe = vi.fn();
    const dispose = installCatalogPopupControls(map, vi.fn(), {
      projectSource: () => sourcePoint,
      reopenPopup,
      subscribeToViewportChanges: (callback) => {
        onViewportChange = callback;
        return unsubscribe;
      },
    });

    popup.style.display = 'none';
    sourcePoint = { x: -20, y: 150 };
    await vi.advanceTimersByTimeAsync(0);
    expect(reopenPopup).not.toHaveBeenCalled();

    sourcePoint = { x: 1, y: 150 };
    popup.style.display = 'block';
    await Promise.resolve();
    expect(popup.style.visibility).toBe('hidden');

    sourcePoint = { x: 1, y: 150 };
    onViewportChange?.();
    expect(reopenPopup).not.toHaveBeenCalled();

    sourcePoint = { x: 12, y: 150 };
    onViewportChange?.();
    expect(reopenPopup).toHaveBeenCalledOnce();
    expect(popup.style.visibility).not.toBe('hidden');
    expect(reopenPopup).toHaveBeenCalledWith(
      76.956526,
      30.401438,
      'RW Aurigae',
      'Coordinates (ICRS): 76.956526°, 30.401438°',
    );

    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not reopen a popup that the user explicitly closed', async () => {
    vi.useFakeTimers();
    const map = document.createElement('div');
    const popup = document.createElement('div');
    popup.className = 'aladin-popup-container';
    popup.style.display = 'block';
    popup.style.left = '150px';
    popup.style.top = '44px';
    const card = document.createElement('div');
    card.className = 'aladin-popup';
    const title = document.createElement('div');
    title.className = 'aladin-popupTitle';
    title.textContent = 'RW Aurigae';
    const text = document.createElement('div');
    text.className = 'aladin-popupText';
    text.textContent = 'Coordinates (ICRS): 76.956526°, 30.401438°';
    const close = document.createElement('a');
    close.className = 'aladin-closeBtn';
    card.append(close, title, text);
    popup.append(card, document.createElement('div'));
    Object.defineProperties(map, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    Object.defineProperties(card, { offsetWidth: { value: 200 }, offsetHeight: { value: 100 } });
    Object.defineProperties(popup, { offsetWidth: { value: 200 }, offsetHeight: { value: 112 } });
    map.append(popup);

    let sourcePoint: { x: number; y: number } | null = { x: 200, y: 150 };
    let onViewportChange: (() => void) | undefined;
    const reopenPopup = vi.fn();
    const dispose = installCatalogPopupControls(map, vi.fn(), {
      projectSource: () => sourcePoint,
      reopenPopup,
      subscribeToViewportChanges: (callback) => {
        onViewportChange = callback;
        return () => {};
      },
    });

    close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    popup.style.display = 'none';
    sourcePoint = { x: -20, y: 150 };
    await vi.advanceTimersByTimeAsync(0);
    sourcePoint = { x: 12, y: 150 };
    onViewportChange?.();
    expect(reopenPopup).not.toHaveBeenCalled();

    dispose();
    vi.useRealTimers();
  });
});
