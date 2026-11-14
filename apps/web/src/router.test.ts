import { describe, expect, it } from 'vitest';
import { parseHash, routeToHash } from './router';

describe('router', () => {
  it('parses the records route', () => {
    expect(parseHash('#/records')).toEqual({ type: 'records' });
    expect(routeToHash({ type: 'records' })).toBe('#/records');
  });

  it('keeps sky and plate routes unchanged', () => {
    expect(parseHash('#/sky')).toEqual({ type: 'sky' });
    expect(parseHash('')).toEqual({ type: 'sky' });
    expect(parseHash('#/plate/abc')).toEqual({ type: 'plate', jobId: 'abc' });
    expect(routeToHash({ type: 'plate', jobId: 'a b' })).toBe('#/plate/a%20b');
    expect(routeToHash({ type: 'sky' })).toBe('#/sky');
  });
});
