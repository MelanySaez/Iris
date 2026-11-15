// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const joyride = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
vi.mock('react-joyride', () => ({
  STATUS: { FINISHED: 'finished', SKIPPED: 'skipped' },
  ACTIONS: { CLOSE: 'close' },
  Joyride: (props: Record<string, unknown>) => {
    joyride.props = props;
    return null;
  },
}));

import { GuidedTour, TOUR_SEEN_KEY, hasSeenTour } from './GuidedTour';

describe('GuidedTour', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });
  afterEach(() => cleanup());

  it('only offers steps whose anchor is on screen (the welcome card always)', () => {
    document.body.innerHTML = '<div data-tour="map"></div>';
    const map = document.querySelector('[data-tour="map"]') as HTMLElement;
    map.getClientRects = () => [{}] as unknown as DOMRectList;
    render(<GuidedTour run onEnd={vi.fn()} />);
    const ids = (joyride.props?.steps as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toEqual(['welcome', 'map', 'nearby']);
    expect(joyride.props?.run).toBe(true);
    expect(joyride.props?.continuous).toBe(true);
  });

  it.each(['finished', 'skipped'])('ends and remembers the tour when it is %s', (status) => {
    const onEnd = vi.fn();
    render(<GuidedTour run onEnd={onEnd} />);
    expect(hasSeenTour()).toBe(false);
    joyride.props?.onEvent({ status }, {});
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(TOUR_SEEN_KEY)).toBe('1');
    expect(hasSeenTour()).toBe(true);
  });

  it('ends the tour when it is closed with Escape or the close button', () => {
    const onEnd = vi.fn();
    render(<GuidedTour run onEnd={onEnd} />);
    joyride.props?.onEvent({ status: 'running', action: 'close' }, {});
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('does not close the tour on a stray click outside the tooltip', () => {
    render(<GuidedTour run onEnd={vi.fn()} />);
    expect(joyride.props?.options.overlayClickAction).toBe(false);
  });

  it('keeps running on intermediate events', () => {
    const onEnd = vi.fn();
    render(<GuidedTour run onEnd={onEnd} />);
    joyride.props?.onEvent({ status: 'running', action: 'next' }, {});
    expect(onEnd).not.toHaveBeenCalled();
  });
});
