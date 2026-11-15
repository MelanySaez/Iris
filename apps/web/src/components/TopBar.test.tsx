// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

describe('TopBar brand', () => {
  afterEach(() => cleanup());

  it('takes the visitor back to the landing page', () => {
    const onNavigate = vi.fn();
    render(<TopBar currentRoute={{ type: 'sky' }} activeJobId={null} onNavigate={onNavigate} />);
    const brand = screen.getByRole('button', { name: 'Iris home' });
    expect(brand.tagName).toBe('BUTTON'); // reachable and operable from the keyboard
    fireEvent.click(brand);
    expect(onNavigate).toHaveBeenCalledWith('#/');
  });
});

describe('TopBar tab indicator', () => {
  afterEach(() => cleanup());

  it('shows one shared underline under the active workspace', () => {
    const { container } = render(
      <TopBar currentRoute={{ type: 'spectral' }} activeJobId={null} onNavigate={vi.fn()} />,
    );
    const indicators = container.querySelectorAll('.switch-indicator');
    expect(indicators).toHaveLength(1);
    expect(indicators[0].getAttribute('data-visible')).toBe('true');
    expect(indicators[0].getAttribute('aria-hidden')).toBe('true');
  });

  it('hides the underline when no workspace is active', () => {
    const { container } = render(
      <TopBar currentRoute={{ type: 'landing' }} activeJobId={null} onNavigate={vi.fn()} />,
    );
    expect(container.querySelector('.switch-indicator')?.getAttribute('data-visible')).toBe('false');
  });
});
