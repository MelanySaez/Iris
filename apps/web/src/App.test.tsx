// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Sky map and Spectral Lab need Aladin/WebGL; stub them so the test drives the real shell.
vi.mock('./components/sky/SkyWorkspace', () => ({ SkyWorkspace: () => <div>sky workspace</div> }));
vi.mock('./components/spectral/SpectralLab', () => ({ SpectralLab: () => <div>spectral lab</div> }));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
      listSelections: vi.fn().mockResolvedValue({ items: [], next_before: null }),
    },
  };
});

import { App } from './App';

describe('App workspace switch', () => {
  beforeEach(() => {
    window.location.hash = '#/sky';
  });
  afterEach(cleanup);

  it('opens the Records workspace from the top bar', async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Records' }));
    });
    expect(window.location.hash).toBe('#/records');
    expect(await screen.findByRole('button', { name: 'Records', pressed: true })).toBeTruthy();
    expect(document.querySelector('.records-layer.layer-active')).not.toBeNull();
    expect(document.querySelector('.sky-layer')?.classList.contains('layer-hidden')).toBe(true);
  });
});
