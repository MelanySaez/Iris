import { describe, expect, it } from 'vitest';
import { describeActivity } from './activity';

describe('describeActivity', () => {
  it('shows how much of a discovery attempt budget has been used', () => {
    const view = describeActivity({ kind: 'discovery_attempt', provider: 'IRSA TAP', attempt: 1,
      max_attempts: 2, budget_seconds: 45, elapsed_seconds: 12 }, 3);
    expect(view).toEqual({ title: 'IRSA TAP · attempt 1 of 2', detail: '15 s of 45 s max',
      fraction: 15 / 45, overdue: false });
  });

  it('flags an attempt that runs past its budget', () => {
    const view = describeActivity({ kind: 'discovery_attempt', provider: 'IRSA TAP', attempt: 2,
      max_attempts: 2, budget_seconds: 45, elapsed_seconds: 50 }, 0);
    expect(view?.overdue).toBe(true);
    expect(view?.fraction).toBe(1);
    expect(view?.detail).toBe('50 s · over the 45 s limit, stopping this attempt');
  });

  it('counts down to the next attempt', () => {
    const view = describeActivity({ kind: 'retry_wait', provider: 'IRSA TAP', attempt: 1,
      max_attempts: 2, budget_seconds: 4, elapsed_seconds: 1 }, 0);
    expect(view).toEqual({ title: 'Retrying IRSA TAP · attempt 2 of 2', detail: 'next attempt in 3 s',
      fraction: 0.25, overdue: false });
  });

  it('shows an indeterminate fallback check with elapsed time', () => {
    const view = describeActivity({ kind: 'fallback', provider: 'S3 DR1 All-Sky Cube',
      elapsed_seconds: 1.6 }, 0.5);
    expect(view).toEqual({ title: 'S3 DR1 All-Sky Cube · checking', detail: '2 s elapsed',
      fraction: null, overdue: false });
  });

  it('reports cube tiles read for the current channel', () => {
    expect(describeActivity({ kind: 'cube_read', channel: 44, channel_index: 1, channels: 2,
      tiles_done: 3, tiles_total: 8, elapsed_seconds: 4 }, 0)).toEqual({
      title: 'Sky tiles for channel 44', detail: '3 of 8 sky tiles · 4 s',
      fraction: 3 / 8, overdue: false });
    expect(describeActivity({ kind: 'cube_read', channel: 44, channel_index: 1, channels: 1,
      tiles_done: 0, tiles_total: null, elapsed_seconds: 0 }, 0)?.detail).toBe('locating sky tiles · 0 s');
  });

  it('returns nothing when the worker is between steps', () => {
    expect(describeActivity(null, 0)).toBeNull();
    expect(describeActivity(undefined, 0)).toBeNull();
  });
});
