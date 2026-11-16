// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/api/api';
import { useRecordsConsent } from '../../src/hooks/useRecordsConsent';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useRecordsConsent', () => {
  it('shows the bar until a choice is made', () => {
    expect(renderHook(() => useRecordsConsent(null)).result.current.barOpen).toBe(true);
    expect(renderHook(() => useRecordsConsent('none')).result.current.barOpen).toBe(false);
  });

  it('recovers the selections made before accepting', async () => {
    const setConsent = vi.spyOn(api, 'setConsent').mockResolvedValue({ level: 'necessary', records_enabled: true });
    const claim = vi.spyOn(api, 'claimSelections').mockResolvedValue({ claimed: 2 });
    const { result } = renderHook(() => useRecordsConsent(null));

    act(() => {
      result.current.beginJob()('job-a');
      result.current.beginJob()('job-b');
      result.current.beginJob()('job-a');
    });
    expect(result.current.recordsEnabled).toBe(false);

    await act(() => result.current.choose('necessary'));

    expect(setConsent).toHaveBeenCalledWith('necessary');
    expect(claim).toHaveBeenCalledWith(['job-a', 'job-b']);
    expect(result.current.recordsEnabled).toBe(true);
    expect(result.current.barOpen).toBe(false);
    expect(result.current.recordsVersion).toBe(1);

    // Later jobs are saved by the server directly; nothing is pending any more.
    act(() => result.current.beginJob()('job-c'));
    await act(() => result.current.choose('all'));
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('saves and recovers nothing when cookies are refused', async () => {
    vi.spyOn(api, 'setConsent').mockResolvedValue({ level: 'none', records_enabled: false });
    const claim = vi.spyOn(api, 'claimSelections');
    const { result } = renderHook(() => useRecordsConsent(null));

    act(() => result.current.beginJob()('job-a'));
    await act(() => result.current.choose('none'));

    expect(claim).not.toHaveBeenCalled();
    expect(result.current.level).toBe('none');
    expect(result.current.recordsEnabled).toBe(false);
    expect(result.current.barOpen).toBe(false);
  });

  it('keeps the bar open with the error and retries the recovery', async () => {
    vi.spyOn(api, 'setConsent').mockResolvedValue({ level: 'all', records_enabled: true });
    const claim = vi
      .spyOn(api, 'claimSelections')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ claimed: 1 });
    const { result } = renderHook(() => useRecordsConsent(null));

    act(() => result.current.beginJob()('job-a'));
    await act(() => result.current.choose('all'));
    expect(result.current.barOpen).toBe(true);
    expect(result.current.error).toContain('offline');

    await act(() => result.current.choose('all'));
    expect(claim).toHaveBeenLastCalledWith(['job-a']);
    expect(result.current.barOpen).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('recovers a job sent before accepting whose answer arrives after', async () => {
    vi.spyOn(api, 'setConsent').mockResolvedValue({ level: 'necessary', records_enabled: true });
    const claim = vi.spyOn(api, 'claimSelections').mockResolvedValue({ claimed: 1 });
    const { result } = renderHook(() => useRecordsConsent(null));

    const finishEarly = result.current.beginJob(); // request sent without cookies
    await act(() => result.current.choose('necessary'));
    expect(claim).not.toHaveBeenCalled(); // its id was not known yet

    await act(async () => finishEarly('in-flight'));
    expect(claim).toHaveBeenCalledWith(['in-flight']);
    expect(result.current.recordsVersion).toBe(2);

    // A job sent after accepting is saved by the server: nothing to recover.
    await act(async () => result.current.beginJob()('saved-by-server'));
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('can reopen the bar to change the choice', () => {
    const { result } = renderHook(() => useRecordsConsent('none'));
    act(() => result.current.openBar());
    expect(result.current.barOpen).toBe(true);
  });
});

it('keeps each pending selection name for later cookie acceptance', async () => {
  vi.spyOn(api, 'setConsent').mockResolvedValue({ level: 'necessary', records_enabled: true });
  const claim = vi.spyOn(api, 'claimSelections').mockResolvedValue({ claimed: 1 });
  const { result } = renderHook(() => useRecordsConsent(null));
  act(() => result.current.beginJob('M101 core')('named-job'));
  await act(() => result.current.choose('necessary'));
  expect(claim).toHaveBeenCalledWith(['named-job'], { 'named-job': 'M101 core' });
});

it('keeps the name when consent is accepted while the named job is in flight', async () => {
  vi.spyOn(api, 'setConsent').mockResolvedValue({ level: 'necessary', records_enabled: true });
  const claim = vi.spyOn(api, 'claimSelections').mockResolvedValue({ claimed: 1 });
  const { result } = renderHook(() => useRecordsConsent(null));
  const finish = result.current.beginJob('M31 centre');
  await act(() => result.current.choose('necessary'));
  await act(async () => finish('in-flight-named'));
  expect(claim).toHaveBeenCalledWith(['in-flight-named'], { 'in-flight-named': 'M31 centre' });
});

describe('useRecordsConsent across reloads', () => {
  afterEach(() => { window.sessionStorage.clear(); });

  it('keeps selections made before accepting through a page reload', async () => {
    window.sessionStorage.clear();
    const first = renderHook(() => useRecordsConsent(null));
    act(() => {
      first.result.current.beginJob('M101 core')('job-a');
      first.result.current.beginJob()('job-b');
    });
    first.unmount(); // the page reloads: in-memory state is gone

    vi.spyOn(api, 'setConsent').mockResolvedValue({ level: 'necessary', records_enabled: true });
    const claim = vi.spyOn(api, 'claimSelections').mockResolvedValue({ claimed: 2 });
    const second = renderHook(() => useRecordsConsent(null));
    await act(() => second.result.current.choose('necessary'));
    expect(claim).toHaveBeenCalledWith(['job-a', 'job-b'], { 'job-a': 'M101 core' });

    // Claimed jobs are forgotten: a later reload claims nothing again.
    claim.mockClear();
    second.unmount();
    const third = renderHook(() => useRecordsConsent(null));
    await act(() => third.result.current.choose('necessary'));
    expect(claim).not.toHaveBeenCalled();
  });

  it('still recovers selections in the same page when storage is blocked', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(api, 'setConsent').mockResolvedValue({ level: 'necessary', records_enabled: true });
    const claim = vi.spyOn(api, 'claimSelections').mockResolvedValue({ claimed: 1 });
    const { result } = renderHook(() => useRecordsConsent(null));
    act(() => { result.current.beginJob()('job-c'); });
    await act(() => result.current.choose('necessary'));
    expect(claim).toHaveBeenCalledWith(['job-c']);
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
