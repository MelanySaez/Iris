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

import { GuidedTour, TOUR_SEEN_KEY, hasSeenTour, tourAnchorsReady } from './GuidedTour';

const onScreen = (selector: string) => {
  const element = document.createElement('div');
  element.setAttribute('data-tour', selector);
  element.getClientRects = () => [{}] as unknown as DOMRectList;
  document.body.appendChild(element);
};

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
    render(<GuidedTour tour="sky" run onEnd={vi.fn()} />);
    const ids = (joyride.props?.steps as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toEqual(['welcome', 'map', 'nearby']);
    expect(joyride.props?.run).toBe(true);
    expect(joyride.props?.continuous).toBe(true);
  });

  it.each(['finished', 'skipped'])('ends and remembers only that workspace tour when it is %s', (status) => {
    const onEnd = vi.fn();
    render(<GuidedTour tour="spectral" run onEnd={onEnd} />);
    expect(hasSeenTour('spectral')).toBe(false);
    joyride.props?.onEvent({ status }, {});
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`${TOUR_SEEN_KEY}:spectral`)).toBe('1');
    expect(hasSeenTour('spectral')).toBe(true);
    expect(hasSeenTour('sky')).toBe(false);
    expect(hasSeenTour('records')).toBe(false);
  });

  it('remembers the tour when it is closed, so it does not start again by itself', () => {
    render(<GuidedTour tour="records" run onEnd={vi.fn()} />);
    joyride.props?.onEvent({ status: 'running', action: 'close' }, {});
    expect(hasSeenTour('records')).toBe(true);
  });

  it('treats the old single flag as the Sky tour having been seen', () => {
    localStorage.setItem(TOUR_SEEN_KEY, '1');
    expect(hasSeenTour('sky')).toBe(true);
    expect(hasSeenTour('plate')).toBe(false);
    expect(hasSeenTour('spectral')).toBe(false);
  });

  it('is ready to run only once the workspace has drawn an anchor its tour points at', () => {
    expect(tourAnchorsReady('plate')).toBe(false); // still loading: only the welcome card
    onScreen('plate-image');
    expect(tourAnchorsReady('plate')).toBe(true);
    expect(tourAnchorsReady('records')).toBe(false);
  });

  it('ends the tour when it is closed with Escape or the close button', () => {
    const onEnd = vi.fn();
    render(<GuidedTour tour="sky" run onEnd={onEnd} />);
    joyride.props?.onEvent({ status: 'running', action: 'close' }, {});
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('does not close the tour on a stray click outside the tooltip', () => {
    render(<GuidedTour tour="sky" run onEnd={vi.fn()} />);
    expect(joyride.props?.options.overlayClickAction).toBe(false);
  });

  it('runs the tour of the workspace it is given', () => {
    document.body.innerHTML = '<div data-tour="lab-axis"></div>';
    const axis = document.querySelector('[data-tour="lab-axis"]') as HTMLElement;
    axis.getClientRects = () => [{}] as unknown as DOMRectList;
    render(<GuidedTour tour="spectral" run onEnd={vi.fn()} />);
    expect((joyride.props?.steps as Array<{ id: string }>).map((s) => s.id)).toEqual(['lab-axis']);
  });

  it('keeps running on intermediate events', () => {
    const onEnd = vi.fn();
    render(<GuidedTour tour="sky" run onEnd={onEnd} />);
    joyride.props?.onEvent({ status: 'running', action: 'next' }, {});
    expect(onEnd).not.toHaveBeenCalled();
  });
});
