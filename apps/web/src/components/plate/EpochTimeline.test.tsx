// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobFrame } from '../../types';
import { EpochTimeline, ProviderTrace } from './EpochTimeline';

function frames(channel = 44): JobFrame[] {
  return [2, 5, 9].map((epoch) => ({
    channel, epoch, product: 'image', detector: 3, obs_id: `obs-${epoch}`,
    date_iso: `2025-01-${String(epoch).padStart(2, '0')}T00:00:00Z`, source: 'remote',
    width: 10, height: 10, url: '', slice_url: '', window_um: [2, 3], calibrated: true,
  }));
}
function Harness({ channel = 44 }: { channel?: number }) {
  const [epoch, setEpoch] = useState(2);
  return <><output aria-label="Selected epoch">{epoch}</output><EpochTimeline
    jobId="job-1" channel={channel} frames={frames(channel)} ready epoch={epoch}
    onSelect={setEpoch} onPlaybackStart={() => {}} /></>;
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('EpochTimeline', () => {
  it('steps through real epoch ids and plays all calibrated epochs at 500ms', () => {
    vi.useFakeTimers(); render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Next epoch' }));
    expect(screen.getByLabelText('Selected epoch').textContent).toBe('5');
    fireEvent.click(screen.getByRole('button', { name: 'Play epochs' }));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByLabelText('Selected epoch').textContent).toBe('9');
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByLabelText('Selected epoch').textContent).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Pause epochs' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByLabelText('Selected epoch').textContent).toBe('2');
    expect(screen.getByRole('link', { name: 'Download GIF' }).getAttribute('href'))
      .toBe('/api/jobs/job-1/animation.gif?channel_id=44');
  });

  it('pauses when the selected channel changes and cleans up its timer', () => {
    vi.useFakeTimers(); const view = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Play epochs' }));
    view.rerender(<Harness channel={45} />);
    expect(screen.getByRole('button', { name: 'Play epochs' })).toBeTruthy();
    const selected = screen.getByLabelText('Selected epoch').textContent;
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByLabelText('Selected epoch').textContent).toBe(selected);
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps approximate frames viewable without offering a calibrated animation', () => {
    render(<EpochTimeline jobId="j" channel={44} frames={frames().map(f => ({ ...f, calibrated: false }))}
      ready epoch={2} onSelect={() => {}} onPlaybackStart={() => {}} reason="Calibration unavailable" />);
    expect(screen.queryByRole('link', { name: 'Download GIF' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Play epochs' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Calibration unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next epoch' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows provider failure and incomplete index coverage without claiming no observations', () => {
    render(<ProviderTrace events={[{ stage: 'IRSA failed', at: 1, provider: 'IRSA TAP',
      outcome: 'failed', detail: 'HTTP 502', fallback: true, coverage_state: 'unknown_not_indexed' }]} />);
    expect(screen.getByText(/HTTP 502/)).toBeTruthy();
    expect(screen.getByText(/not indexed/)).toBeTruthy();
    expect(screen.queryByText(/no observations/i)).toBeNull();
  });
});
