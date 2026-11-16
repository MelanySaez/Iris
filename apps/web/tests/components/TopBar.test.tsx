// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from '../../src/components/TopBar';

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

describe('TopBar tour button', () => {
  afterEach(() => cleanup());

  it('replays the guided tour and marks where the tour points', () => {
    const onStartTour = vi.fn();
    const { container } = render(
      <TopBar currentRoute={{ type: 'sky' }} activeJobId={null} onNavigate={vi.fn()} onStartTour={onStartTour} />,
    );
    const help = screen.getByRole('button', { name: 'Take the guided tour' });
    expect(help.getAttribute('data-tour')).toBe('tour-help');
    fireEvent.click(help);
    expect(onStartTour).toHaveBeenCalledTimes(1);
    expect(container.querySelector('nav[data-tour="workspaces"]')).not.toBeNull();
  });
});

describe('TopBar assistant targets', () => {
  afterEach(() => cleanup());

  it('marks every workspace button so the assistant guide can point at it', () => {
    render(<TopBar currentRoute={{ type: 'sky' }} activeJobId={null} onNavigate={vi.fn()} />);
    for (const workspace of ['sky', 'plate', 'spectral', 'records']) {
      const target = document.querySelectorAll(`[data-assistant-target="workspace-${workspace}"]`);
      expect(target).toHaveLength(1);
      expect(target[0].tagName).toBe('BUTTON');
    }
  });
});
