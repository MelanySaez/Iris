// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceErrorBoundary } from './WorkspaceErrorBoundary';

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error('chart exploded');
  return <p>Lab is back</p>;
}

describe('WorkspaceErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a fallback naming the workspace instead of a blank screen, and logs the error', () => {
    render(
      <>
        <p>Top bar</p>
        <WorkspaceErrorBoundary workspace="Spectral Lab"><Flaky /></WorkspaceErrorBoundary>
      </>,
    );

    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong in Spectral Lab/);
    expect(screen.getByText('chart exploded')).toBeTruthy();
    expect(screen.getByText('Top bar')).toBeTruthy();
    expect(console.error).toHaveBeenCalledWith(
      '[Iris] Spectral Lab crashed:',
      expect.objectContaining({ message: 'chart exploded' }),
      expect.any(String),
    );
  });

  it('renders the workspace again after Try again once the cause is gone', () => {
    render(<WorkspaceErrorBoundary workspace="Sky"><Flaky /></WorkspaceErrorBoundary>);
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Lab is back')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders children untouched when nothing throws', () => {
    shouldThrow = false;
    render(<WorkspaceErrorBoundary workspace="Records"><Flaky /></WorkspaceErrorBoundary>);
    expect(screen.getByText('Lab is back')).toBeTruthy();
  });
});
