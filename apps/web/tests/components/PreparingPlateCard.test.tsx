// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobSnapshot } from '../../src/types/types';
import { PreparingPlateCard } from '../../src/components/PreparingPlateCard';

const makeJob = (overrides: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: 'job-123',
  status: 'failed',
  progress: 100,
  stage: 'Failed',
  events: [],
  error: 'Coverage could not be determined.',
  failed_stage: 'discovering',
  error_kind: 'discovery_unavailable',
  error_trace: null,
  request_id: 'request-123',
  request: {} as JobSnapshot['request'],
  region: { ra_deg: 36.9, dec_deg: 62.26, size_arcmin: 1, fov_deg: 0.0167 },
  channels: [],
  products: ['image'],
  frames: [],
  cutouts: [],
  cache: { hit: false },
  wavelength_status: 'wcs_wave_approximate',
  calibrated: false,
  multi_product_mosaic: 'pending',
  ...overrides,
});

describe('PreparingPlateCard discovery trace', () => {
  afterEach(cleanup);

  it('shows the failed attempt count and each upstream outcome', () => {
    render(
      <PreparingPlateCard
        job={makeJob({
          error: 'Coverage could not be determined: IRSA TAP discovery failed.',
          events: [
            {
              stage: 'IRSA TAP · Attempt 1 of 2 failed; retrying',
              at: 1_800_000_000,
              event_type: 'discovery_attempt',
              provider: 'IRSA TAP',
              attempt: 1,
              max_attempts: 2,
              outcome: 'failed',
              will_retry: true,
              detail: 'ReadTimeout: The read operation timed out',
            },
            {
              stage: 'IRSA TAP · Attempt 2 of 2 failed',
              at: 1_800_000_001,
              event_type: 'discovery_attempt',
              provider: 'IRSA TAP',
              attempt: 2,
              max_attempts: 2,
              outcome: 'failed',
              will_retry: false,
              detail: 'HTTP 502',
            },
          ],
        })}
        onOpenPlate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('IRSA TAP failed on attempt 2 of 2.')).toBeTruthy();
    expect(screen.getByText(/Attempt 1 of 2 failed; retrying/)).toBeTruthy();
    expect(screen.getByText(/ReadTimeout: The read operation timed out/)).toBeTruthy();
    expect(screen.getByText(/Attempt 2 of 2 failed/)).toBeTruthy();
    expect(screen.getByText(/HTTP 502/)).toBeTruthy();
  });

  it('shows the in-flight provider attempt while discovery is running', () => {
    render(
      <PreparingPlateCard
        job={makeJob({
          status: 'discovering',
          progress: 10,
          stage: 'IRSA TAP · Attempt 2 of 2 in progress',
          error: null,
          failed_stage: null,
          error_kind: null,
          events: [
            {
              stage: 'IRSA TAP · Attempt 2 of 2 in progress',
              at: 1_800_000_001,
              event_type: 'discovery_attempt',
              provider: 'IRSA TAP',
              attempt: 2,
              max_attempts: 2,
              outcome: 'started',
            },
          ],
        })}
        onOpenPlate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('IRSA TAP · Attempt 2 of 2 in progress', { selector: '.stage-text' })).toBeTruthy();
  });

  it('makes the next retry delay visible while discovery waits', () => {
    render(
      <PreparingPlateCard
        job={makeJob({
          status: 'discovering',
          error: null,
          events: [{
            stage: 'IRSA TAP · Attempt 1 of 2 failed; retrying',
            at: Date.now() / 1000,
            event_type: 'discovery_attempt',
            provider: 'IRSA TAP',
            attempt: 1,
            max_attempts: 2,
            outcome: 'failed',
            will_retry: true,
            retry_after_seconds: 2,
          }],
        })}
        onOpenPlate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('Next discovery attempt in 2s')).toBeTruthy();
  });
});
