import { describe, expect, it } from 'vitest';
import {
  isSelectionPending,
  mergeSelectionPage,
  canOpenInPlate,
  describeSelectionRegion,
  describeSelectionView,
  failureDetails,
  normalizeSelectionName,
  removeSelection,
  selectionError,
} from './records';
import type { SelectionView } from './selectionView';
import type { SelectionSummary } from '../types/types';

function selection(overrides: Partial<SelectionSummary> = {}): SelectionSummary {
  return {
    id: 's1',
    job_id: 'job1',
    region: {
      ra_deg: 270.69303,
      dec_deg: 61.87652,
      size_arcmin: 4,
      fov_deg: 0.0667,
      coverage: 'available',
      checked_at: '2026-11-14T10:00:00Z',
    },
    channels: [12, 44],
    products: ['image'],
    mode: 'latest',
    stretch: 'asinh',
    job_status: 'ready',
    job_error: null,
    failed_stage: null,
    error_kind: null,
    error_trace: null,
    view_mode: null,
    rgb_channels: null,
    name: null,
    job_events: null,
    hits: 1,
    created_at: '2026-11-14T10:00:00Z',
    last_seen_at: '2026-11-14T10:00:00Z',
    ...overrides,
  };
}

describe('records helpers', () => {
  it('describes the region with RA, Dec and size', () => {
    expect(describeSelectionRegion(selection())).toBe("270.69303°, +61.87652° · 4′");
  });

  it('only ready jobs can be reopened in the plate view', () => {
    expect(canOpenInPlate(selection({ job_status: 'ready' }))).toBe(true);
    expect(canOpenInPlate(selection({ job_status: 'failed' }))).toBe(false);
    expect(canOpenInPlate(selection({ job_status: 'queued' }))).toBe(false);
  });

  it('removes a deleted selection from the list without mutating it', () => {
    const list = [selection({ id: 'a' }), selection({ id: 'b' })];
    const next = removeSelection(list, 'a');
    expect(next.map((s) => s.id)).toEqual(['b']);
    expect(list).toHaveLength(2);
  });

  it('shows the stored error only for failed selections', () => {
    const reason = 'Coverage could not be determined: IRSA TAP discovery failed.';
    expect(selectionError(selection({ job_status: 'failed', job_error: reason }))).toBe(reason);
    expect(selectionError(selection({ job_status: 'failed', job_error: null }))).toBe('Failed without a recorded reason.');
    expect(selectionError(selection({ job_status: 'ready', job_error: null }))).toBeNull();
    expect(selectionError(selection({ job_status: 'queued', job_error: 'stale' }))).toBeNull();
  });

  it('builds failure details with stage, kind, timeline offsets and trace', () => {
    const details = failureDetails(
      selection({
        job_status: 'failed',
        job_error: 'RuntimeError: No network',
        failed_stage: 'downloading',
        error_kind: 'download_failed',
        error_trace: 'Traceback (most recent call last):\nRuntimeError: No network',
        job_events: [
          { stage: 'Discovering products', at: 100 },
          { stage: 'Downloading DR1 cutouts 0/1', at: 101.25 },
          { stage: 'Failed', at: 160.5 },
        ],
      }),
    );
    expect(details).toEqual({
      message: 'RuntimeError: No network',
      stage: 'downloading',
      kind: 'download_failed',
      trace: 'Traceback (most recent call last):\nRuntimeError: No network',
      timeline: [
        { stage: 'Discovering products', offset: '+0.0s' },
        { stage: 'Downloading DR1 cutouts 0/1', offset: '+1.3s' },
        { stage: 'Failed', offset: '+60.5s' },
      ],
    });
  });

  it('has no failure details for non-failed selections and tolerates old rows', () => {
    expect(failureDetails(selection({ job_status: 'ready' }))).toBeNull();
    expect(failureDetails(selection({ job_status: 'failed' }))).toEqual({
      message: 'Failed without a recorded reason.',
      stage: null,
      kind: null,
      trace: null,
      timeline: [],
    });
  });
});

describe('describeSelectionView', () => {
  const cached = (overrides: Partial<SelectionView> = {}): SelectionView => ({
    region: { ra_deg: 270.69303, dec_deg: 61.87652, size_arcmin: 4 },
    center: [270.69303, 61.87652],
    fov_deg: 0.13,
    projection: 'SIN',
    channel: 44,
    rgb: null,
    ...overrides,
  });

  it('prefers the view cached in this browser', () => {
    const record = selection({ view_mode: 'single', rgb_channels: null });
    expect(describeSelectionView(record, cached({ rgb: { r: 16, g: 32, b: 46 } }))).toEqual({
      label: 'RGB · 16/32/46',
      source: 'cache',
    });
  });

  it('shows a single-channel view from the cache without repeating the channel', () => {
    expect(describeSelectionView(selection(), cached())).toEqual({ label: 'Single', source: 'cache' });
  });

  it('falls back to the database when nothing is cached', () => {
    const record = selection({ view_mode: 'rgb', rgb_channels: [10, 20, 30] });
    expect(describeSelectionView(record, null)).toEqual({ label: 'RGB · 10/20/30', source: 'database' });
  });

  it('shows a single-channel view from the database without repeating the channel', () => {
    const record = selection({ channels: [44], view_mode: 'single' });
    expect(describeSelectionView(record, null)).toEqual({ label: 'Single', source: 'database' });
  });

  it('ignores a cached view made for another channel of the same region', () => {
    const record = selection({ channels: [12], view_mode: 'single' });
    expect(describeSelectionView(record, cached({ channel: 44 }))).toEqual({
      label: 'Single',
      source: 'database',
    });
  });

  it('reports no view when neither source has one', () => {
    expect(describeSelectionView(selection(), null)).toBeNull();
  });
});

describe('normalizeSelectionName', () => {
  it('trims the name', () => {
    expect(normalizeSelectionName('  M101 core  ')).toEqual({ name: 'M101 core' });
  });

  it('turns a blank name into no name', () => {
    expect(normalizeSelectionName('   ')).toEqual({ name: null });
  });

  it('accepts 80 characters and rejects more', () => {
    expect(normalizeSelectionName('x'.repeat(80))).toEqual({ name: 'x'.repeat(80) });
    expect(normalizeSelectionName('x'.repeat(81))).toEqual({ error: 'Names can be at most 80 characters.' });
  });
});

describe('record status refresh', () => {
  const row = (id: string, job_status: SelectionSummary['job_status']) =>
    ({ id, job_status } as SelectionSummary);

  it('treats every non-final job status as pending', () => {
    expect(['queued', 'discovering', 'downloading', 'extracting', 'rendering']
      .map((status) => isSelectionPending(row('a', status as SelectionSummary['job_status']))))
      .toEqual([true, true, true, true, true]);
    expect(isSelectionPending(row('a', 'ready'))).toBe(false);
    expect(isSelectionPending(row('a', 'failed'))).toBe(false);
  });

  it('updates known rows in place, adds new ones on top and keeps older pages', () => {
    const shown = [row('new', 'queued'), row('old', 'ready'), row('page2', 'ready')];
    const fresh = [row('newer', 'queued'), row('new', 'ready'), row('old', 'ready')];
    expect(mergeSelectionPage(shown, fresh).map((r) => `${r.id}:${r.job_status}`))
      .toEqual(['newer:queued', 'new:ready', 'old:ready', 'page2:ready']);
  });
});
