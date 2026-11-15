import { describe, expect, it } from 'vitest';
import { TOUR_STEPS } from './tourSteps';

describe('guided tour steps', () => {
  it('follows the demo path in seven steps', () => {
    expect(TOUR_STEPS.map((step) => step.id)).toEqual([
      'welcome',
      'search',
      'map',
      'channels',
      'region',
      'workspaces',
      'replay',
    ]);
  });

  it('opens and closes as centred cards and points every other step at a data-tour anchor', () => {
    expect(TOUR_STEPS[0].placement).toBe('center');
    for (const step of TOUR_STEPS.slice(1, -1)) {
      expect(step.target).toMatch(/^\[data-tour="[a-z-]+"\]$/);
    }
    expect(TOUR_STEPS.at(-1)?.target).toBe('[data-tour="tour-help"]');
  });
});
