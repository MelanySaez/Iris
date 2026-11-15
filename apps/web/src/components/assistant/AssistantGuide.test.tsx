// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantGuide, GUIDE_DELAY_MS, GUIDE_DURATION_MS } from './AssistantGuide';

function target(name: string, rect: { left: number; top: number; width: number; height: number }) {
  const element = document.createElement('div');
  element.setAttribute('data-assistant-target', name);
  element.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('AssistantGuide', () => {
  it('rings the field an action changes, labelled, and then fades away', () => {
    target('channel', { left: 100, top: 400, width: 200, height: 40 });
    render(
      <AssistantGuide
        cues={[{ id: 1, kind: 'field', target: '[data-assistant-target="channel"]', label: 'Channel 44' }]}
      />,
    );
    expect(document.querySelector('.assistant-guide-ring')).toBeNull(); // waits for the UI to settle

    act(() => vi.advanceTimersByTime(GUIDE_DELAY_MS));
    const ring = document.querySelector<HTMLElement>('.assistant-guide-ring')!;
    expect(ring.style.left).toBe('100px');
    expect(ring.style.top).toBe('400px');
    expect(ring.style.width).toBe('200px');
    expect(ring.style.height).toBe('40px');
    expect(screen.getByRole('status').textContent).toBe('Channel 44');

    act(() => vi.advanceTimersByTime(GUIDE_DURATION_MS));
    expect(document.querySelector('.assistant-guide-ring')).toBeNull();
  });

  it('closes a reticle on the centre of the map for a move', () => {
    target('map', { left: 0, top: 50, width: 800, height: 600 });
    render(
      <AssistantGuide
        cues={[{ id: 1, kind: 'position', target: '[data-assistant-target="map"]', label: 'Show region' }]}
      />,
    );
    act(() => vi.advanceTimersByTime(GUIDE_DELAY_MS));
    const reticle = document.querySelector<HTMLElement>('.assistant-guide-reticle')!;
    expect(reticle.style.left).toBe('400px');
    expect(reticle.style.top).toBe('350px');
    expect(screen.getByRole('status').textContent).toBe('Show region');
  });

  it('plays several cues one after another and skips a missing target', () => {
    target('channel', { left: 10, top: 10, width: 50, height: 20 });
    target('color-mode', { left: 70, top: 10, width: 50, height: 20 });
    const { rerender } = render(
      <AssistantGuide
        cues={[{ id: 1, kind: 'field', target: '[data-assistant-target="channel"]', label: 'Channel 44' }]}
      />,
    );
    rerender(
      <AssistantGuide
        cues={[
          { id: 1, kind: 'field', target: '[data-assistant-target="channel"]', label: 'Channel 44' },
          { id: 2, kind: 'field', target: '[data-assistant-target="missing"]', label: 'Nowhere' },
          { id: 3, kind: 'field', target: '[data-assistant-target="color-mode"]', label: 'Single channel' },
        ]}
      />,
    );

    act(() => vi.advanceTimersByTime(GUIDE_DELAY_MS));
    expect(screen.getByRole('status').textContent).toBe('Channel 44');
    act(() => vi.advanceTimersByTime(GUIDE_DURATION_MS)); // first cue ends
    act(() => vi.advanceTimersByTime(GUIDE_DELAY_MS)); // the next one settles
    expect(screen.getByRole('status').textContent).toBe('Single channel');
    expect(document.querySelector<HTMLElement>('.assistant-guide-ring')!.style.left).toBe('70px');
    act(() => vi.advanceTimersByTime(GUIDE_DURATION_MS));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
