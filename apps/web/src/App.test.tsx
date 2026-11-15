// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Sky map and Spectral Lab need Aladin/WebGL; stub them so the test drives the real shell.
const skyProps = vi.hoisted(() => vi.fn());
vi.mock('./components/sky/SkyWorkspace', () => ({
  SkyWorkspace: (props: unknown) => {
    skyProps(props);
    return <div>sky workspace</div>;
  },
}));
vi.mock('./components/spectral/SpectralLab', () => ({ SpectralLab: () => <div>spectral lab</div> }));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
      listSelections: vi.fn().mockResolvedValue({ items: [], next_before: null }),
    },
  };
});

import { api } from './api';
import { App } from './App';
import type { SelectionSummary } from './types';

const recorded: SelectionSummary = {
  id: 'sel-1',
  job_id: 'job-1',
  region: {
    ra_deg: 210.80227,
    dec_deg: 54.34895,
    size_arcmin: 6,
    fov_deg: 0.1,
    coverage: 'available',
    checked_at: '2026-11-14T12:00:00Z',
  },
  channels: [44],
  products: ['image'],
  mode: 'latest',
  stretch: 'asinh',
  job_status: 'ready',
  job_error: null,
  failed_stage: null,
  error_kind: null,
  error_trace: null,
  job_events: null,
  view_mode: null,
  rgb_channels: null,
  name: null,
  hits: 1,
  created_at: '2026-11-14T12:00:00Z',
  last_seen_at: '2026-11-14T12:00:00Z',
};

describe('App workspace switch', () => {
  beforeEach(() => {
    window.location.hash = '#/sky';
  });
  afterEach(cleanup);

  it('opens the Records workspace from the top bar', async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Records' }));
    });
    expect(window.location.hash).toBe('#/records');
    expect(await screen.findByRole('button', { name: 'Records', pressed: true })).toBeTruthy();
    expect(document.querySelector('.records-layer.layer-active')).not.toBeNull();
    expect(document.querySelector('.sky-layer')?.classList.contains('layer-hidden')).toBe(true);
  });

  it('hides Products and Hits columns in Records', async () => {
    vi.mocked(api.listSelections).mockResolvedValueOnce({ items: [recorded], next_before: null });
    window.location.hash = '#/records';
    render(<App />);

    expect(await screen.findByRole('columnheader', { name: 'Name' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Products' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Hits' })).toBeNull();
    expect(document.querySelector('.records-table tbody tr')?.children).toHaveLength(8);
  });

  it('rebuilds a recorded selection on the Sky map from Records', async () => {
    vi.mocked(api.listSelections).mockResolvedValueOnce({ items: [recorded], next_before: null });
    window.location.hash = '#/records';
    render(<App />);
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Show in Sky' }));
    });

    expect(window.location.hash).toBe('#/sky');
    await waitFor(() =>
      expect(document.querySelector('.sky-layer')?.classList.contains('layer-active')).toBe(true),
    );
    expect(skyProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        restoreRequest: { id: 1, region: { ra_deg: 210.80227, dec_deg: 54.34895, size_arcmin: 6 } },
      }),
    );
  });

  it('shows the view mode each selection was made in', async () => {
    vi.mocked(api.listSelections).mockResolvedValueOnce({
      items: [
        { ...recorded, id: 'rgb', job_id: 'job-rgb', view_mode: 'rgb', rgb_channels: [16, 32, 46] },
        { ...recorded, id: 'old', job_id: 'job-old' },
      ],
      next_before: null,
    });
    window.location.hash = '#/records';
    render(<App />);

    expect(await screen.findByRole('columnheader', { name: 'View' })).toBeTruthy();
    expect(screen.getByText('RGB · 16/32/46').getAttribute('title')).toBe('Recorded by the backend');
    expect(screen.getByTitle('Selected before view modes were recorded').textContent).toBe('—');
  });

  it('names a selection from Records and shows the name', async () => {
    vi.mocked(api.listSelections).mockResolvedValueOnce({ items: [recorded], next_before: null });
    const rename = vi.spyOn(api, 'renameSelection').mockResolvedValue({ ...recorded, name: 'M101 core' });
    window.location.hash = '#/records';
    render(<App />);

    expect(await screen.findByText('Untitled')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rename selection' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    const input = screen.getByRole('textbox', { name: 'Selection name' });
    fireEvent.change(input, { target: { value: '  M101 core ' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(rename).toHaveBeenCalledWith('sel-1', 'M101 core');
    expect(await screen.findByText('M101 core')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Selection name' })).toBeNull();
  });

  it('edits the title in place and saves on blur', async () => {
    vi.mocked(api.listSelections).mockResolvedValueOnce({ items: [recorded], next_before: null });
    const rename = vi.spyOn(api, 'renameSelection').mockResolvedValue({ ...recorded, name: 'M31' });
    window.location.hash = '#/records';
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Untitled' }));
    const input = screen.getByRole('textbox', { name: 'Selection name' });
    expect(input.parentElement?.className).toBe('records-name');
    fireEvent.change(input, { target: { value: 'M31' } });
    await act(async () => { fireEvent.blur(input); });

    expect(rename).toHaveBeenCalledWith('sel-1', 'M31');
    expect(await screen.findByRole('button', { name: 'M31' })).toBeTruthy();
  });

  it('cancels renaming with Escape without saving', async () => {
    vi.mocked(api.listSelections).mockResolvedValueOnce({ items: [recorded], next_before: null });
    const rename = vi.spyOn(api, 'renameSelection');
    window.location.hash = '#/records';
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rename selection' }));
    const input = screen.getByRole('textbox', { name: 'Selection name' });
    fireEvent.change(input, { target: { value: 'Not saved' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(rename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Selection name' })).toBeNull();
    expect(screen.getByText('Untitled')).toBeTruthy();
  });
});
