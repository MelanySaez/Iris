// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectionActions } from './SelectionActions';

const selection = { ra_deg: 270.69303, dec_deg: 61.87652, size_arcmin: 6 };

describe('SelectionActions', () => {
  afterEach(() => cleanup());

  it('offers the spectrum of the selection centre', () => {
    const onViewSpectrum = vi.fn();
    render(
      <SelectionActions
        selection={selection}
        confirmed
        activeJobId={null}
        onOpenPlate={vi.fn()}
        onViewSpectrum={onViewSpectrum}
      />,
    );
    const button = screen.getByRole('button', { name: 'Visualize spectrum' });
    expect(button.getAttribute('title')).toBe(
      'Plot the spectrum at the centre of the selection (RA 270.69303°, Dec 61.87652°)',
    );
    fireEvent.click(button);
    expect(onViewSpectrum).toHaveBeenCalledWith({
      ra_deg: 270.69303,
      dec_deg: 61.87652,
      label: 'Selection centre (270.693°, 61.877°)',
    });
  });

  it('shows no spectrum button without a selection', () => {
    render(
      <SelectionActions selection={null} confirmed activeJobId={null} onOpenPlate={vi.fn()} onViewSpectrum={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Visualize spectrum' })).toBeNull();
  });

  it('opens the spectral plate of a confirmed region', () => {
    const onOpenPlate = vi.fn();
    render(
      <SelectionActions selection={selection} confirmed activeJobId="job-7" onOpenPlate={onOpenPlate} onViewSpectrum={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open spectral plate' }));
    expect(onOpenPlate).toHaveBeenCalledWith('job-7');
  });

  it('offers nothing while the region is still a draft, even with an earlier job active', () => {
    render(
      <SelectionActions selection={selection} confirmed={false} activeJobId="job-7" onOpenPlate={vi.fn()} onViewSpectrum={vi.fn()} />,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('offers nothing without a selected region, even with a job active', () => {
    render(
      <SelectionActions selection={null} confirmed activeJobId="job-7" onOpenPlate={vi.fn()} onViewSpectrum={vi.fn()} />,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
