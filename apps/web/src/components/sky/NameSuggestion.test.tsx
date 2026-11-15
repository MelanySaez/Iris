// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type { ResolvedName } from '../../types';
import { NameSuggestion, type SubmitLookup } from './NameSuggestion';

const m31: ResolvedName = {
  query: 'M31',
  name: 'M 31',
  ra_deg: 10.684708,
  dec_deg: 41.26875,
  object_type: 'AGN',
  source: 'simbad',
  cached: false,
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
    expect(resolve).toHaveBeenCalledWith('M31');

    const option = screen.getByRole('button', { name: /M 31/ });
    expect(option.textContent).toBe('M 31AGN · 10.6847°, +41.2687°SIMBAD');
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith({ ra_deg: 10.684708, dec_deg: 41.26875, name: 'M 31' });
  });

  it('asks the resolver once per pause, not once per keystroke', async () => {
    const { resolve, retype } = setup('M');
    await settle(100);
    retype('M3');
    await settle(100);
    retype('M31');
    await settle();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('M31');
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

  it('Enter before the pause resolves immediately and moves the map', async () => {
    const { resolve, onSelect, submitRef } = setup('M31');
    let handled: boolean | undefined;
    await act(async () => {
      handled = await submitRef.current!();
    });
    expect(handled).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ ra_deg: 10.684708, dec_deg: 41.26875, name: 'M 31' });
    await settle(); // the pending debounce must not ask again
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('Enter after a suggestion appeared reuses it without asking again', async () => {
    const { resolve, onSelect, submitRef } = setup('M31');
    await settle();
    await act(async () => {
      await submitRef.current!();
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('Enter on an unknown name reports it was not handled', async () => {
    const resolve = vi.fn().mockRejectedValue(new ApiError('HTTP 404', 404, 'not found'));
    const { onSelect, submitRef } = setup('zzq', resolve);
    let handled: boolean | undefined;
    await act(async () => {
      handled = await submitRef.current!();
    });
    expect(handled).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
