// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Sky map and Spectral Lab need Aladin/WebGL; stub them so the test drives the real shell.
const skyProps = vi.hoisted(() => vi.fn());
vi.mock('../../src/components/sky/SkyWorkspace', () => ({
  SkyWorkspace: (props: unknown) => {
    skyProps(props);
    return <div>sky workspace</div>;
  },
}));
vi.mock('../../src/components/spectral/SpectralLab', () => ({ SpectralLab: () => <div>spectral lab</div> }));
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
      claimSelections: vi.fn().mockResolvedValue({ claimed: 1 }),
    },
  };
});

import { api } from '../../src/api/api';
import { App } from '../../src/app/App';
import type { SelectionSummary } from '../../src/types/types';

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

function setConsentCookie(value: string | null) {
  document.cookie = value === null
    ? 'iris_consent=; max-age=0; path=/'
    : `iris_consent=${value}; path=/`;
}

describe('App workspace switch', () => {
  beforeEach(() => {
    window.location.hash = '#/sky';
    // These tests use Records as a browser that already accepted cookies.
    setConsentCookie('necessary');
  });
  afterEach(() => {
    cleanup();
    setConsentCookie(null);
  });

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

  it('lets the assistant drive the interface through validated actions', async () => {
    vi.spyOn(api, 'assistantStatus').mockResolvedValue({ enabled: true, model: 'test-model' });
    const outcome = vi.spyOn(api, 'reportAssistantOutcome').mockResolvedValue(undefined);
    vi.spyOn(api, 'assistantChat').mockResolvedValue({
      conversation_id: 'c',
      request_id: 'r1',
      reply: 'Showing it in Sky.',
      actions: [
        { type: 'navigate', workspace: 'records' },
        { type: 'show_region', ra_deg: 210.8, dec_deg: 54.35, size_arcmin: 12 },
        { type: 'navigate', workspace: 'plate' },
      ],
      cached: false,
      cache_kind: null,
    });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));
    const box = await screen.findByRole('textbox', { name: 'Message the assistant' });
    fireEvent.change(box, { target: { value: 'show M101' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });

    expect(await screen.findByText('Showing it in Sky.')).toBeTruthy();
    // show_region reaches Sky as a command (a draft, never a confirmed job) and opens Sky.
    expect(skyProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        assistantCommands: [
          { id: 1, action: { type: 'show_region', ra_deg: 210.8, dec_deg: 54.35, size_arcmin: 12 } },
        ],
      }),
    );
    await waitFor(() => expect(window.location.hash).toBe('#/sky'));
    // Plate needs an active job, so that action is reported as failed.
    expect(outcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', action: { type: 'navigate', workspace: 'plate' } }),
    );
    expect(api.assistantChat).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ workspace: 'sky' }) }),
    );
  });
});

describe('App cookie consent', () => {
  beforeEach(() => {
    window.location.hash = '#/sky';
    setConsentCookie(null);
    vi.clearAllMocks();
    vi.mocked(api.createJob).mockResolvedValue({ id: 'early-job' } as Awaited<
      ReturnType<typeof api.createJob>
    >);
  });
  afterEach(() => {
    cleanup();
    setConsentCookie(null);
  });

  it('asks for consent in a footer bar and recovers selections made before accepting', async () => {
    render(<App />);
    expect(screen.getByRole('region', { name: 'Cookie consent' })).toBeTruthy();

    const { onStartJob } = skyProps.mock.calls.at(-1)![0] as {
      onStartJob: (req: unknown) => Promise<void>;
    };
    await act(async () => {
      await onStartJob({ ra_deg: 1, dec_deg: 2, size_arcmin: 6, channels: [44] });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept necessary' }));
    });

    expect(api.setConsent).toHaveBeenCalledWith('necessary');
    expect(api.claimSelections).toHaveBeenCalledWith(['early-job']);
    expect(screen.queryByRole('region', { name: 'Cookie consent' })).toBeNull();
  });

  it('tells Records visitors that selections cannot be saved without cookies', async () => {
    setConsentCookie('none');
    window.location.hash = '#/records';
    render(<App />);

    expect(screen.queryByRole('region', { name: 'Cookie consent' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      'Your selections cannot be saved without cookies.',
    );
    expect(api.listSelections).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));
    expect(screen.getByRole('region', { name: 'Cookie consent' })).toBeTruthy();
  });
});
