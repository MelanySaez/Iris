import { describe, expect, it } from 'vitest';
import { canOpenInPlate, describeSelectionRegion, removeSelection } from './records';
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
});
