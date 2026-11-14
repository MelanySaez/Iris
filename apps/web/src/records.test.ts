import { describe, expect, it } from 'vitest';
import { canOpenInPlate, describeSelectionRegion, failureDetails, removeSelection, selectionError } from './records';
import type { SelectionSummary } from './types';

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
