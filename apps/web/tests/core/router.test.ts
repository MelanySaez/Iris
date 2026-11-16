import { describe, expect, it } from 'vitest';
import { parseHash, routeToHash } from '../../src/core/router';

describe('router', () => {
  it('parses the records route', () => {
    expect(parseHash('#/records')).toEqual({ type: 'records' });
    expect(routeToHash({ type: 'records' })).toBe('#/records');
  });

  it('keeps sky and plate routes unchanged', () => {
    expect(parseHash('#/sky')).toEqual({ type: 'sky' });
    expect(parseHash('#/unknown')).toEqual({ type: 'sky' });
    expect(parseHash('#/plate/abc')).toEqual({ type: 'plate', jobId: 'abc' });
    expect(parseHash('#/plate')).toEqual({ type: 'plate', jobId: null });
    expect(parseHash('#/plate/')).toEqual({ type: 'plate', jobId: null });
    expect(routeToHash({ type: 'plate', jobId: null })).toBe('#/plate');
    expect(routeToHash({ type: 'plate', jobId: 'a b' })).toBe('#/plate/a%20b');
    expect(routeToHash({ type: 'sky' })).toBe('#/sky');
  });

  it('opens the landing page on an empty address', () => {
    expect(parseHash('')).toEqual({ type: 'landing' });
    expect(parseHash('#')).toEqual({ type: 'landing' });
    expect(parseHash('#/')).toEqual({ type: 'landing' });
    expect(routeToHash({ type: 'landing' })).toBe('#/');
  });
});
