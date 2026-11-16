// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegionConfirmBar } from '../../../src/components/sky/RegionConfirmBar';

afterEach(() => cleanup());

const region = { ra_deg: 310.52956, dec_deg: 21.97696, size_arcmin: 1 };

describe('RegionConfirmBar', () => {

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

it('confirms an optional normalized name from the selection card', () => {
  const onConfirm = vi.fn();
  render(<RegionConfirmBar region={region} onConfirm={onConfirm} onDiscard={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Selection name (optional)' }), { target: { value: '  M101 core  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm region' }));
  expect(onConfirm).toHaveBeenCalledWith('M101 core');
});

it('accepts an unnamed selection and rejects names over the Records limit', () => {
  const onConfirm = vi.fn();
  render(<RegionConfirmBar region={region} onConfirm={onConfirm} onDiscard={vi.fn()} />);
  const input = screen.getByRole('textbox', { name: 'Selection name (optional)' });
  fireEvent.change(input, { target: { value: 'x'.repeat(81) } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm region' }));
  expect(screen.getByRole('alert').textContent).toBe('Names can be at most 80 characters.');
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm region' }));
  expect(onConfirm).toHaveBeenCalledWith();
});
