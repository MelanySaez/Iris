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
        activeJobId={null}
        onOpenPlate={vi.fn()}
        onViewSpectrum={onViewSpectrum}
      />,
    );
    const button = screen.getByRole('button', { name: 'View spectrum →' });
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
      <SelectionActions selection={null} activeJobId={null} onOpenPlate={vi.fn()} onViewSpectrum={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'View spectrum →' })).toBeNull();
  });

  it('keeps the existing plate button for an active job', () => {
    const onOpenPlate = vi.fn();
    render(
      <SelectionActions selection={null} activeJobId="job-7" onOpenPlate={onOpenPlate} onViewSpectrum={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open spectral plate →' }));
    expect(onOpenPlate).toHaveBeenCalledWith('job-7');
  });
});
