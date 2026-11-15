// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsentBar } from './ConsentBar';

afterEach(cleanup);

describe('ConsentBar', () => {
  it('offers necessary, all or no cookies and explains what refusing means', () => {
    const onChoose = vi.fn();
    render(<ConsentBar onChoose={onChoose} saving={false} error={null} />);

    const bar = screen.getByRole('region', { name: 'Cookie consent' });
    expect(bar.textContent).toContain('without cookies your selections (Records) cannot be saved');

    fireEvent.click(screen.getByRole('button', { name: 'Accept necessary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    expect(onChoose.mock.calls).toEqual([['necessary'], ['all'], ['none']]);
  });

  it('shows the error and disables the buttons while saving', () => {
    render(<ConsentBar onChoose={vi.fn()} saving error="offline" />);
    expect(screen.getByRole('alert').textContent).toContain('offline');
    for (const button of screen.getAllByRole<HTMLButtonElement>('button')) expect(button.disabled).toBe(true);
  });

  it('lifts the chat button by its height while shown and lets it settle back after', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(96);
    const root = document.documentElement;

    const { unmount } = render(<ConsentBar onChoose={vi.fn()} saving={false} error={null} />);
    expect(root.style.getPropertyValue('--consent-bar-height')).toBe('96px');

    unmount();
    expect(root.style.getPropertyValue('--consent-bar-height')).toBe('');
    height.mockRestore();
  });
});
