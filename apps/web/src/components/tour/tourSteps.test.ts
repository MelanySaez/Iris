import { describe, expect, it } from 'vitest';
import { TOURS, tourForRoute } from './tourSteps';

const ids = (tour: keyof typeof TOURS) => TOURS[tour].map((step) => step.id);

describe('guided tours, one per workspace', () => {
  it('walks Sky along the demo path, including the hidden right-click search', () => {
    expect(ids('sky')).toEqual(['welcome', 'search', 'map', 'nearby', 'channels', 'region', 'workspaces', 'replay']);
  });

  it('ends the Sky tour by saying every tab has its own guide behind the same button', () => {
    const replay = TOURS.sky.at(-1)!;
    expect(replay.target).toBe('[data-tour="tour-help"]');
    expect(String(replay.content)).toMatch(/each tab has its own guide/i);
  });

  it('has short tours for Plate, Spectral Lab and Records', () => {
    expect(ids('plate')).toEqual(['plate-intro', 'plate-record', 'plate-image', 'plate-epochs', 'plate-channels', 'plate-readout']);
    expect(ids('spectral')).toEqual(['lab-add', 'lab-compare', 'lab-axis', 'lab-chart', 'lab-sidebar']);
    expect(ids('records')).toEqual(['records-intro', 'records-consent', 'records-table', 'records-actions']);
  });

  it('points every step at a data-tour anchor, or at the page for centred cards', () => {
    for (const steps of Object.values(TOURS)) {
      for (const step of steps) {
        if (step.target === 'body') expect(step.placement).toBe('center');
        else expect(step.target).toMatch(/^\[data-tour="[a-z-]+"\]$/);
      }
    }
  });

  it('gives every step an id unique across all tours', () => {
    const all = Object.values(TOURS).flat().map((step) => step.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('picks the tour of the tab the visitor is on (Sky from the landing page)', () => {
    expect(tourForRoute('sky')).toBe('sky');
    expect(tourForRoute('plate')).toBe('plate');
    expect(tourForRoute('spectral')).toBe('spectral');
    expect(tourForRoute('records')).toBe('records');
    expect(tourForRoute('landing')).toBe('sky');
  });
});
