// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CubeSpectrumResponse } from '../../types';

const getSpectrum = vi.fn();

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    api: {
      getCatalog: vi.fn(() => Promise.reject(new Error('offline'))), // keep the fallback list
      getSpectrum: (...args: unknown[]) => getSpectrum(...args),
    },
  };
});

const { ApiError } = await import('../../api');
const { SpectralLab } = await import('./SpectralLab');

function spectrum(values: (number | null)[], npix = 1901): CubeSpectrumResponse {
  return {
    ra_deg: 0,
    dec_deg: 0,
    unit: 'MJy/sr',
    source: 'test',
    tile: { order: 5, npix, x: 1, y: 2, url: '' },
    date_beg: '',
    date_end: '',
    quick_look: true,
    calibrated: false,
    notes: [],
    points: values.map((value, channel) => ({
      channel,
      detector: 1,
      subchannel: channel + 1,
      wavelength_um: 1 + channel,
      bandwidth_um: 0.02,
      wl_min_um: 0.99 + channel,
      wl_max_um: 1.01 + channel,
      value,
      nhits: value === null ? 0 : 5,
      flags: 0,
      available: value !== null,
    })),
  };
}

/** A promise the test resolves or rejects when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const legendItems = () =>
  Array.from(document.querySelectorAll('.spectral-legend li')) as HTMLElement[];
const catalogButton = (name: string) =>
  within(document.querySelector('.spectral-catalog') as HTMLElement).getByRole('button', {
    name: new RegExp(name),
  });

function addByCoordinates(ra: string, dec: string) {
  const [raInput, decInput] = screen.getAllByRole('textbox');
  fireEvent.change(raInput, { target: { value: ra } });
  fireEvent.change(decInput, { target: { value: dec } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
}

describe('SpectralLab', () => {
  beforeEach(() => {
    getSpectrum.mockReset();
  });
  afterEach(() => cleanup());

  it('adds a catalog object, shows loading, then its channel coverage and the chart', async () => {
    const pending = deferred<CubeSpectrumResponse>();
    getSpectrum.mockReturnValueOnce(pending.promise);
    render(<SpectralLab />);

    fireEvent.click(catalogButton('M101 field'));
    expect(screen.getByText('Reading cube tile…')).toBeTruthy();
    expect(catalogButton('M101 field').hasAttribute('disabled')).toBe(true);

    await act(async () => pending.resolve(spectrum([10, null, 30], 2858)));

    expect(screen.getByText('2/3 channels · tile 2858')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Spectra of M101 field/ })).toBeTruthy();
    expect(getSpectrum).toHaveBeenCalledWith(210.80227, 54.34895);
  });

  it('refuses the same position twice', async () => {
    getSpectrum.mockResolvedValue(spectrum([1, 2]));
    render(<SpectralLab />);
    await act(async () => addByCoordinates('148.888', '69.065'));
    await act(async () => addByCoordinates('148.888', '69.065'));

    expect(screen.getByRole('alert').textContent).toBe(
      'RA 148.888°, Dec 69.065° is already in the comparison.',
    );
    expect(legendItems()).toHaveLength(1);
    expect(getSpectrum).toHaveBeenCalledTimes(1);
  });

  it('refuses a ninth spectrum', async () => {
    getSpectrum.mockResolvedValue(spectrum([1, 2]));
    render(<SpectralLab />);
    for (let i = 0; i < 8; i += 1) {
      await act(async () => addByCoordinates(String(10 + i), '5'));
    }
    await act(async () => addByCoordinates('99', '5'));

    expect(legendItems()).toHaveLength(8);
    expect(screen.getByText('Compare at most 8 spectra; remove one first.')).toBeTruthy();
    expect(screen.getByText('Comparing 8/8')).toBeTruthy();
  });

  it('shows the backend detail when a spectrum fails', async () => {
    getSpectrum.mockRejectedValueOnce(
      new ApiError('HTTP 404', 404, 'No All-Sky Cube tile covers this position.'),
    );
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('WISE 0855')));

    expect(screen.getByText('Failed: No All-Sky Cube tile covers this position.')).toBeTruthy();
  });

  it('ignores a stale response after the spectrum was removed and re-added', async () => {
    const first = deferred<CubeSpectrumResponse>();
    const second = deferred<CubeSpectrumResponse>();
    getSpectrum.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<SpectralLab />);

    fireEvent.click(catalogButton('M101 field'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove M101 field' }));
    fireEvent.click(catalogButton('M101 field'));

    await act(async () => second.resolve(spectrum([4, 5], 2858)));
    await act(async () => first.reject(new Error('late failure from the first request')));

    expect(legendItems()).toHaveLength(1);
    expect(screen.getByText('2/2 channels · tile 2858')).toBeTruthy();
    expect(screen.queryByText(/late failure/)).toBeNull();
  });

  it('hides and shows a spectrum, then removes it', async () => {
    getSpectrum.mockResolvedValue(spectrum([1, 2]));
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('M101 field')));

    fireEvent.click(screen.getByRole('button', { name: 'Hide M101 field' }));
    expect(screen.getByText('No spectrum plotted yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show M101 field' }));
    expect(screen.getByRole('img', { name: /Spectra of M101 field/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove M101 field' }));
    expect(legendItems()).toHaveLength(0);
    expect(catalogButton('M101 field').hasAttribute('disabled')).toBe(false);
  });

  it('notes how many values the log axis cannot draw', async () => {
    getSpectrum.mockResolvedValue(spectrum([-2, 0, 5, 50]));
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('M101 field')));

    // Linear axis: only the quick-look disclaimer, no hidden-value note.
    const linearNotes = screen.getAllByRole('note').map((n) => n.textContent ?? '');
    expect(linearNotes.some((t) => t.includes('not drawn on the log axis'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));

    const notes = screen.getAllByRole('note').map((n) => n.textContent ?? '');
    expect(notes.some((t) => t.startsWith('2 values ≤ 0 are not drawn on the log axis'))).toBe(true);
    expect(within(document.body).getByRole('button', { name: 'Log' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

