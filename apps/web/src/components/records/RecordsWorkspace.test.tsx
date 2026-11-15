// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { RecordsWorkspace } from './RecordsWorkspace';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RecordsWorkspace consent', () => {
  it('says selections cannot be saved without cookies and never loads them', () => {
    const list = vi.spyOn(api, 'listSelections');
    const onOpenCookieSettings = vi.fn();
    render(
      <RecordsWorkspace
        onOpenPlate={vi.fn()}
        recordsEnabled={false}
        onOpenCookieSettings={onOpenCookieSettings}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'Your selections cannot be saved without cookies.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));
    expect(onOpenCookieSettings).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it('loads the browser selections once cookies are accepted', async () => {
    const list = vi.spyOn(api, 'listSelections').mockResolvedValue({ items: [], next_before: null });
    render(
      <RecordsWorkspace onOpenPlate={vi.fn()} recordsEnabled onOpenCookieSettings={vi.fn()} />,
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/No saved selections yet/)).toBeTruthy();
  });
});
