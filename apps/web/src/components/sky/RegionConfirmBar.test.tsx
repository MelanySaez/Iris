// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegionConfirmBar } from './RegionConfirmBar';

const region = { ra_deg: 310.52956, dec_deg: 21.97696, size_arcmin: 1 };

describe('RegionConfirmBar', () => {
  afterEach(() => cleanup());

  it('shows the draft region and confirms it', () => {
    const onConfirm = vi.fn();
    render(<RegionConfirmBar region={region} onConfirm={onConfirm} onDiscard={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Confirm selected region' }).textContent).toContain('1.0′');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm region' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('discards the draft region with the close button', () => {
    const onDiscard = vi.fn();
    render(<RegionConfirmBar region={region} onConfirm={vi.fn()} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard region' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
