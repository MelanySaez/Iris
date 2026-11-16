// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobSnapshot } from '../../../src/types/types';
import { StageProgress, StageStatusChip } from '../../../src/components/plate/StageProgress';

function job(overrides: Partial<JobSnapshot>): JobSnapshot {
  return {
    id: 'j', status: 'discovering', progress: 10, stage: 'IRSA TAP · Attempt 1 of 2 in progress',
    error: null, events: [{ stage: 'Discovering products', at: Date.now() / 1000 - 5 }],
    request: { ra_deg: 1, dec_deg: 2, size_arcmin: 4, channels: [20], products: ['image'] },
    region: { ra_deg: 1, dec_deg: 2, size_arcmin: 4, fov_deg: 0.0667 }, channels: [],
    products: ['image'], frames: [], cutouts: [], cache: { hit: false },
    wavelength_status: 'wcs_wave_approximate', calibrated: false, multi_product_mosaic: 'pending',
    activity: { kind: 'discovery_attempt', provider: 'IRSA TAP', attempt: 1, max_attempts: 2,
      budget_seconds: 45, elapsed_seconds: 10 },
    ...overrides,
  } as JobSnapshot;
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('StageProgress', () => {
  it('shows overall progress and the live attempt budget inside the stage', () => {
    vi.useFakeTimers();
    render(<StageProgress job={job({})} />);
    const panel = screen.getByRole('status');
    expect(panel.textContent).toContain('IRSA TAP · Attempt 1 of 2 in progress');
    expect(panel.textContent).toContain('10%');
    expect(panel.textContent).toContain('IRSA TAP · attempt 1 of 2');
    expect(panel.textContent).toContain('10 s of 45 s max');
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('status').textContent).toContain('12 s of 45 s max');
    const bars = screen.getAllByRole('progressbar');
    expect(bars.map(b => b.getAttribute('aria-valuenow'))).toEqual(['10', '27']);
  });

  it('uses an indeterminate bar when the step has no measurable budget', () => {
    render(<StageProgress job={job({ activity: { kind: 'fallback', provider: 'S3 DR1 All-Sky Cube',
      elapsed_seconds: 1 } })} />);
    const bars = screen.getAllByRole('progressbar');
    expect(bars[1].hasAttribute('aria-valuenow')).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('S3 DR1 All-Sky Cube · checking');
  });

  it('shows the final status chip for ready and failed jobs', () => {
    const { rerender } = render(<StageStatusChip job={job({ status: 'ready', stage: 'Ready', progress: 100 })} />);
    expect(screen.getByText('Ready')).toBeTruthy();
    rerender(<StageStatusChip job={job({ status: 'failed', stage: 'Failed', error_kind: 'cube_unavailable' })} />);
    expect(screen.getByText('Failed · cube_unavailable')).toBeTruthy();
    rerender(<StageStatusChip job={job({})} />);
    expect(screen.getByText('10% · IRSA TAP · Attempt 1 of 2 in progress')).toBeTruthy();
  });
});
