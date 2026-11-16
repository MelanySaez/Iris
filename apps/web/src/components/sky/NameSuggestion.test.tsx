// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/api';
import type { ResolvedName } from '../../types/types';
import { NameSuggestion, type SubmitLookup } from './NameSuggestion';

const m31: ResolvedName = {
  query: 'M31',
  name: 'M 31',
  ra_deg: 10.684708,
  dec_deg: 41.26875,
  object_type: 'AGN',
  source: 'simbad',
  cached: false,
  size_arcmin: 199.53,
};

function setup(query: string, resolve = vi.fn().mockResolvedValue(m31)) {
  const onSelect = vi.fn();
  const submitRef: { current: SubmitLookup | null } = { current: null };
  const view = render(
    <NameSuggestion query={query} resolve={resolve} onSelect={onSelect} submitRef={submitRef} delayMs={400} />,
  );
  const retype = (next: string) =>
    view.rerender(
      <NameSuggestion query={next} resolve={resolve} onSelect={onSelect} submitRef={submitRef} delayMs={400} />,
    );
  return { resolve, onSelect, submitRef, retype };
}

const settle = async (ms = 400) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('NameSuggestion', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows nothing for an empty search', async () => {
    const { resolve } = setup('   ');
    await settle();
    expect(resolve).not.toHaveBeenCalled();
    expect(document.querySelector('.name-suggestion')).toBeNull();
  });

  it('suggests the resolved object once typing pauses, and moves the map on click', async () => {
    const { resolve, onSelect } = setup(' M31 ');
    expect(resolve).not.toHaveBeenCalled(); // still waiting for the pause
    await settle();
    expect(resolve).toHaveBeenCalledWith('M31', expect.anything());

    const option = screen.getByRole('button', { name: /M 31/ });
    expect(option.textContent).toBe('M 31AGN · 10.6847°, +41.2687°SIMBAD');
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith({ ra_deg: 10.684708, dec_deg: 41.26875, name: 'M 31', size_arcmin: 199.53 });
  });

  it('asks the resolver once per pause, not once per keystroke', async () => {
    const { resolve, retype } = setup('M');
    await settle(100);
    retype('M3');
    await settle(100);
    retype('M31');
    await settle();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('M31', expect.anything());
  });

  it('never shows the answer to an older query', async () => {
    let finishOld!: (r: ResolvedName) => void;
    const resolve = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ResolvedName>((r) => (finishOld = r)))
      .mockResolvedValueOnce({ ...m31, query: 'NGC 224' });
    const { retype } = setup('M3', resolve);
    await settle(); // "M3" lookup in flight
    retype('NGC 224');
    await settle();
    await act(async () => finishOld({ ...m31, name: 'STALE' }));
    expect(screen.queryByText(/STALE/)).toBeNull();
    expect(screen.getByRole('button', { name: /M 31/ })).toBeTruthy();
  });

  it('explains a miss and an outage without offering a destination', async () => {
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('HTTP 404', 404, "No object named 'zzq' was found in SIMBAD or NED."))
      .mockRejectedValueOnce(new ApiError('HTTP 503', 503, 'Name resolvers are unavailable (simbad, ned).'));
    const { retype } = setup('zzq', resolve);
    await settle();
    expect(screen.getByRole('status').textContent).toBe("No object named 'zzq' was found in SIMBAD or NED.");
    retype('M31');
    await settle();
    expect(screen.getByRole('status').textContent).toBe(
      'Name resolvers are unavailable (simbad, ned). Use “Go to coordinates” meanwhile.',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Enter before the pause resolves immediately and reports the target', async () => {
    const { resolve, onSelect, submitRef } = setup('M31');
    let outcome: Awaited<ReturnType<SubmitLookup>> | undefined;
    await act(async () => {
      outcome = await submitRef.current!();
    });
    expect(outcome).toEqual({
      kind: 'found',
      target: { ra_deg: 10.684708, dec_deg: 41.26875, name: 'M 31', size_arcmin: 199.53 },
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled(); // the search box decides whether to move
    await settle(); // the pending debounce must not ask again
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('Enter after a suggestion appeared reuses it without asking again', async () => {
    const { resolve, submitRef } = setup('M31');
    await settle();
    let outcome: Awaited<ReturnType<SubmitLookup>> | undefined;
    await act(async () => {
      outcome = await submitRef.current!();
    });
    expect(outcome?.kind).toBe('found');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('Enter on an unknown name reports a miss', async () => {
    const resolve = vi.fn().mockRejectedValue(new ApiError('HTTP 404', 404, 'not found'));
    const { submitRef } = setup('zzq', resolve);
    let outcome: Awaited<ReturnType<SubmitLookup>> | undefined;
    await act(async () => {
      outcome = await submitRef.current!();
    });
    expect(outcome).toEqual({ kind: 'missed' });
  });

  it('an Enter overtaken by more typing reports stale, not a miss', async () => {
    let finish!: (r: ResolvedName) => void;
    const resolve = vi.fn().mockImplementationOnce(() => new Promise<ResolvedName>((r) => (finish = r)));
    const { submitRef, retype } = setup('M3', resolve);
    let pending!: ReturnType<SubmitLookup>;
    act(() => {
      pending = submitRef.current!();
    });
    retype('M31');
    await act(async () => finish(m31));
    expect(await pending).toEqual({ kind: 'stale' });
  });

  it('cancels the request of a query the user moved away from', async () => {
    const signals: AbortSignal[] = [];
    const resolve = vi.fn((_name: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<ResolvedName>(() => {});
    });
    const { retype } = setup('M3', resolve);
    await settle();
    retype('M31');
    expect(signals[0].aborted).toBe(true);
  });

  describe('when both catalogues know the name', () => {
    const both: ResolvedName = {
      ...m31,
      alternatives: [
        {
          name: 'MESSIER 031',
          ra_deg: 10.6848,
          dec_deg: 41.2691,
          object_type: 'G',
          size_arcmin: null,
          source: 'ned',
        },
      ],
    };

    it('lists SIMBAD first and NED second', async () => {
      setup('M31', vi.fn().mockResolvedValue(both));
      await settle();
      const rows = screen.getAllByRole('button');
      expect(rows.map((row) => row.textContent)).toEqual([
        'M 31AGN · 10.6847°, +41.2687°SIMBAD',
        'MESSIER 031G · 10.6848°, +41.2691°NED',
      ]);
    });

    it('moves the map to the NED position when its row is chosen', async () => {
      const { onSelect } = setup('M31', vi.fn().mockResolvedValue(both));
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /MESSIER 031/ }));
      expect(onSelect).toHaveBeenCalledWith({
        ra_deg: 10.6848,
        dec_deg: 41.2691,
        name: 'MESSIER 031',
        size_arcmin: null,
      });
    });

    it('Enter still takes the SIMBAD answer', async () => {
      const { submitRef } = setup('M31', vi.fn().mockResolvedValue(both));
      await settle();
      let outcome: Awaited<ReturnType<SubmitLookup>> | undefined;
      await act(async () => {
        outcome = await submitRef.current!();
      });
      expect(outcome).toEqual({
        kind: 'found',
        target: { ra_deg: 10.684708, dec_deg: 41.26875, name: 'M 31', size_arcmin: 199.53 },
      });
    });
  });
});

