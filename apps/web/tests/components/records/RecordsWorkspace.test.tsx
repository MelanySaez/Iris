// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../src/api/api';
import { RecordsWorkspace } from '../../../src/components/records/RecordsWorkspace';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RecordsWorkspace consent', () => {
  it('says selections cannot be saved without cookies and never loads them', () => {
    const list = vi.spyOn(api, 'listSelections');
    const onOpenCookieSettings = vi.fn();
    render(
      <RecordsWorkspace
        onOpenPlate={vi.fn()}
        recordsEnabled={false}
        onOpenCookieSettings={onOpenCookieSettings}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'Your selections cannot be saved without cookies.',
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Records you saved earlier in this browser are kept and shown again when you accept.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));
    expect(onOpenCookieSettings).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it('loads the browser selections once cookies are accepted', async () => {
    const list = vi.spyOn(api, 'listSelections').mockResolvedValue({ items: [], next_before: null });
    render(
      <RecordsWorkspace onOpenPlate={vi.fn()} recordsEnabled onOpenCookieSettings={vi.fn()} />,
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/No saved selections yet/)).toBeTruthy();
  });
});

describe('RecordsWorkspace tour anchors', () => {
  const anchors = () => Array.from(document.querySelectorAll('[data-tour]'), (el) => el.getAttribute('data-tour'));

  it('marks the header and the cookie notice before cookies are accepted', () => {
    render(<RecordsWorkspace onOpenPlate={vi.fn()} recordsEnabled={false} onOpenCookieSettings={vi.fn()} />);
    expect(anchors()).toEqual(['records-intro', 'records-consent']);
  });

  it('marks the table and only the first row of actions once there are selections', async () => {
    const selection = {
      id: 's1', job_id: 'j1',
      region: { ra_deg: 10, dec_deg: 41, size_arcmin: 6, fov_deg: 1, coverage: 'available', checked_at: '2026-11-15T00:00:00Z' },
      channels: [44], products: ['image'], mode: 'latest', stretch: 'asinh', job_status: 'ready',
      job_error: null, failed_stage: null, error_kind: null, error_trace: null, job_events: null,
      view_mode: null, rgb_channels: null, name: 'M31', hits: 1,
      created_at: '2026-11-15T00:00:00Z', last_seen_at: '2026-11-15T00:00:00Z',
    };
    vi.spyOn(api, 'listSelections').mockResolvedValue({
      items: [selection, { ...selection, id: 's2', job_id: 'j2', name: 'M81' }],
      next_before: null,
    } as never);
    render(<RecordsWorkspace onOpenPlate={vi.fn()} recordsEnabled onOpenCookieSettings={vi.fn()} />);
    await screen.findByText('M81');
    expect(anchors()).toEqual(['records-intro', 'records-table', 'records-actions']);
  });
});

describe('RecordsWorkspace live status', () => {
  const selection = (job_status: string) => ({
    id: 's1', job_id: 'j1',
    region: { ra_deg: 1.57, dec_deg: 0.62, size_arcmin: 121.5, fov_deg: 2, coverage: 'unknown', checked_at: '2026-11-15T00:00:00Z' },
    channels: [44], products: ['image'], mode: 'latest', stretch: 'asinh', job_status,
    job_error: null, failed_stage: null, error_kind: null, error_trace: null, job_events: null,
    view_mode: null, rgb_channels: null, name: null, hits: 1,
    created_at: '2026-11-15T00:00:00Z', last_seen_at: '2026-11-15T00:00:00Z',
  });

  it('refreshes a record whose job is still running until it finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const list = vi.spyOn(api, 'listSelections')
      .mockResolvedValueOnce({ items: [selection('queued')], next_before: null } as never)
      .mockResolvedValue({ items: [selection('ready')], next_before: null } as never);
    render(<RecordsWorkspace onOpenPlate={vi.fn()} recordsEnabled onOpenCookieSettings={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Inspect' })).toBeTruthy();

    await vi.advanceTimersByTimeAsync(3000);
    expect(await screen.findByRole('button', { name: 'Open' })).toBeTruthy();
    const calls = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(list.mock.calls.length).toBe(calls); // nothing pending: polling stopped
    vi.useRealTimers();
  });
});
