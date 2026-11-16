// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PanelToggle, useCollapsiblePanels } from './PanelToggle';

function Harness() {
  const panels = useCollapsiblePanels();
  return <>
    <PanelToggle side="left" label="plate record" controls="plate-sheet" open={panels.sheetOpen} onToggle={panels.toggleSheet} />
    <PanelToggle side="right" label="spectral channels" controls="plate-rail" open={panels.railOpen} onToggle={panels.toggleRail} />
    <output aria-label="state">{`${panels.sheetOpen}:${panels.railOpen}`}</output>
  </>;
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('collapsible plate panels', () => {
  it('starts open and toggles each sidebar independently', () => {
    render(<Harness />);
    const left = screen.getByRole('button', { name: 'Hide plate record' });
    expect(left.getAttribute('aria-expanded')).toBe('true');
    expect(left.textContent).toBe('Hide');
    expect(left.getAttribute('aria-controls')).toBe('plate-sheet');
    fireEvent.click(left);
    expect(screen.getByLabelText('state').textContent).toBe('false:true');
    expect(screen.getByRole('button', { name: 'Show plate record' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Show plate record' }).textContent).toBe('Show');
    fireEvent.click(screen.getByRole('button', { name: 'Hide spectral channels' }));
    expect(screen.getByLabelText('state').textContent).toBe('false:false');
  });

  it('remembers the choice for the next visit', () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide spectral channels' }));
    first.unmount();
    render(<Harness />);
    expect(screen.getByLabelText('state').textContent).toBe('true:false');
  });

  it('still works when storage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Hide plate record' }));
      expect(screen.getByLabelText('state').textContent).toBe('false:true');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
