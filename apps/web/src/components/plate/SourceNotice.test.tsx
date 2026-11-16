// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobSnapshot } from '../../types/types';
import { CubeFallbackNotice, isCubeFallback, sourceLabel } from './SourceNotice';

const NOTICE = 'IRSA TAP discovery is unavailable, so this result comes from the SPHEREx DR1 '
  + 'All-Sky Cube on S3. The cube combines every DR1 observation from 2025-08-11 to 2026-05-04 '
  + 'into one image, so it has no temporal information.';

function job(overrides: Partial<JobSnapshot>): JobSnapshot {
  return {
    id: 'j', status: 'ready', progress: 100, stage: 'Ready', error: null,
    request: { ra_deg: 1, dec_deg: 2, size_arcmin: 4, channels: [20], products: ['image'] },
    region: { ra_deg: 1, dec_deg: 2, size_arcmin: 4, fov_deg: 0.0667 }, channels: [],
    products: ['image'], frames: [], cutouts: [], cache: { hit: false },
    wavelength_status: 'wcs_wave_approximate', calibrated: false, multi_product_mosaic: 'pending',
    ...overrides,
  } as JobSnapshot;
}

afterEach(cleanup);

describe('cube fallback notice', () => {
  it('labels every data source for people, not with internal codes', () => {
    expect(sourceLabel('remote')).toBe('IRSA');
    expect(sourceLabel('s3')).toBe('S3');
    expect(sourceLabel('cube')).toBe('DR1 All-Sky Cube (S3)');
    expect(sourceLabel('mixed')).toBe('MIXED');
  });

  it('warns that the cube fallback has no temporal information', () => {
    render(<CubeFallbackNotice job={job({
      discovery: { coverage_state: 'cube_fallback', temporal_available: false, fallback_notice: NOTICE },
    })} />);
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('IRSA TAP is unavailable');
    expect(notice.textContent).toContain('No temporal information');
    expect(notice.textContent).toContain('2025-08-11 to 2026-05-04');
    expect(notice.textContent).toContain('no VARIANCE');
  });

  it('still warns when only the frames say they come from the cube', () => {
    const frame = { channel: 20, epoch: 0, product: 'image', detector: 2, obs_id: 'cube',
      date_iso: '2026-05-04T12:55:15Z', source: 'cube', width: 4, height: 4, url: '',
      slice_url: '', window_um: [1, 2] } as const;
    const fromFrames = job({ frames: [{ ...frame, window_um: [1, 2] }] });
    expect(isCubeFallback(fromFrames)).toBe(true);
    render(<CubeFallbackNotice job={fromFrames} />);
    expect(screen.getByRole('status').textContent).toContain('No temporal information');
  });

  it('can be dismissed and brought back', () => {
    render(<CubeFallbackNotice job={job({ discovery: { coverage_state: 'cube_fallback', fallback_notice: NOTICE } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss fallback notice' }));
    expect(screen.queryByText(/No temporal information/)).toBeNull();
    const reopen = screen.getByRole('button', { name: /Fallback data: DR1 All-Sky Cube, no temporal information/ });
    fireEvent.click(reopen);
    expect(screen.getByRole('status').textContent).toContain('No temporal information');
  });

  it('stays hidden for IRSA and indexed S3 results', () => {
    const { container } = render(<CubeFallbackNotice job={job({ discovery: { coverage_state: 'complete' } })} />);
    expect(container.textContent).toBe('');
    expect(isCubeFallback(job({ discovery: { coverage_state: 'indexed_matches' } }))).toBe(false);
  });
});
