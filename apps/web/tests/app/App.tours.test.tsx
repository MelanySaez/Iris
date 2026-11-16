// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TourProps {
  tour: string;
  run: boolean;
  onEnd: () => void;
}

// The tour itself and "has the workspace drawn its anchors?" are controlled here;
// everything else is the real App shell.
const tour = vi.hoisted(() => ({ ready: true, props: null as TourProps | null }));

vi.mock('../../src/components/sky/SkyWorkspace', () => ({ SkyWorkspace: () => <div>sky workspace</div> }));
vi.mock('../../src/components/spectral/SpectralLab', () => ({ SpectralLab: () => <div>spectral lab</div> }));
vi.mock('../../src/components/landing/Landing', () => ({
  Landing: ({ onTour }: { onTour: () => void }) => <button type="button" onClick={onTour}>Guided Tour</button>,
}));
vi.mock('../../src/components/tour/GuidedTour', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/tour/GuidedTour')>();
  return {
    ...actual,
    tourAnchorsReady: () => tour.ready,
    GuidedTour: (props: TourProps) => {
      tour.props = props;
      return null;
    },
  };
});
vi.mock('../../src/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
      listSelections: vi.fn().mockResolvedValue({ items: [], next_before: null }),
      createJob: vi.fn(),
      setConsent: vi.fn().mockResolvedValue({ level: 'necessary', records_enabled: true }),
      claimSelections: vi.fn().mockResolvedValue({ claimed: 0 }),
    },
  };
});

import { App } from '../../src/app/App';
import { TOUR_SEEN_KEY } from '../../src/components/tour/GuidedTour';

const settle = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};

const running = () => (tour.props?.run ? tour.props.tour : null);

describe('App first-visit guided tours', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    tour.ready = true;
    tour.props = null;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.location.hash = '';
  });

  it('starts the tour of a workspace the first time the visitor opens it', async () => {
    window.location.hash = '#/spectral';
    render(<App />);
    await settle(1000);
    expect(running()).toBe('spectral');
  });

  it('starts the Sky tour only after the arrival from the landing page has faded', async () => {
    window.location.hash = '#/sky';
    render(<App />);
    await settle(600);
    expect(running()).toBeNull();
    await settle(1000);
    expect(running()).toBe('sky');
  });

  it('does not start a tour the visitor has already seen', async () => {
    localStorage.setItem(`${TOUR_SEEN_KEY}:records`, '1');
    window.location.hash = '#/records';
    render(<App />);
    await settle(3000);
    expect(running()).toBeNull();
  });

  it('does not start any tour on the landing page', async () => {
    window.location.hash = '#/';
    render(<App />);
    await settle(3000);
    expect(running()).toBeNull();
  });

  it('offers each workspace tour once, on its own first visit', async () => {
    window.location.hash = '#/spectral';
    render(<App />);
    await settle(1000);
    expect(running()).toBe('spectral');

    await go('#/records');
    await settle(1000);
    expect(running()).toBe('records');

    // Back on the Lab without having finished its tour: it is not offered again this visit.
    await go('#/spectral');
    await settle(3000);
    expect(running()).toBeNull();
  });

  it('replays every workspace tour, once each, after the landing Guided Tour button, even if seen before', async () => {
    for (const id of ['sky', 'plate', 'spectral', 'records']) localStorage.setItem(`${TOUR_SEEN_KEY}:${id}`, '1');
    window.location.hash = '#/';
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Guided Tour' }));
    await settle(1500);
    expect(running()).toBe('sky');
    act(() => tour.props?.onEnd());

    await go('#/spectral');
    await settle(1000);
    expect(running()).toBe('spectral');
    act(() => tour.props?.onEnd());

    await go('#/records');
    await settle(1000);
    expect(running()).toBe('records');
    act(() => tour.props?.onEnd());

    // Each tour once per guided visit: returning to the Lab does not start it again.
    await go('#/spectral');
    await settle(3000);
    expect(running()).toBeNull();
  });

  it('waits until the workspace has drawn what the tour points at (e.g. a loading plate)', async () => {
    tour.ready = false;
    window.location.hash = '#/spectral';
    render(<App />);
    await settle(3000);
    expect(running()).toBeNull();

    tour.ready = true;
    await settle(1000);
    expect(running()).toBe('spectral');
  });
});
