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

    fireEvent.click(catalogButton('Andromeda Galaxy'));
    expect(screen.getByText('Loading cube spectrum…')).toBeTruthy();
    expect(catalogButton('Andromeda Galaxy').hasAttribute('disabled')).toBe(true);

    await act(async () => pending.resolve(spectrum([10, null, 30], 2858)));

    expect(screen.getByText('2/3 channels · tile 2858')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Spectra of Andromeda Galaxy/ })).toBeTruthy();
    expect(getSpectrum).toHaveBeenCalledWith(10.684708, 41.26875);
  });

  it('keeps an explicit loading status while a spectrum request is pending', () => {
    getSpectrum.mockReturnValue(new Promise(() => {}));
    render(<SpectralLab />);
    fireEvent.click(catalogButton('Andromeda Galaxy'));

    expect(screen.getByRole('status').textContent).toMatch(/Loading cube spectrum/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders positive estimates on the log axis', async () => {
    getSpectrum.mockResolvedValue(spectrum([10, null, 100]));
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('Andromeda Galaxy')));
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));

    expect(document.querySelector('.spectral-estimated-marker')).toBeTruthy();
    expect(document.querySelector('.spectral-estimated-line')).toBeTruthy();
  });

  it('explains that nonpositive interpolated flux cannot be drawn on a log axis', async () => {
    getSpectrum.mockResolvedValue(spectrum([-5, null, -1]));
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('Andromeda Galaxy')));
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));

    expect(screen.getByText(/Interpolated estimate.*cannot be shown on a log axis/i)).toBeTruthy();
    expect(document.querySelector('.spectral-estimated-marker')).toBeNull();
    expect(screen.getByText('-3.0 (estimated)')).toBeTruthy();
  });

  it('supports reversible sidebar and chart zoom controls', async () => {
    getSpectrum.mockResolvedValue(spectrum([10, 20, 30]));
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('Andromeda Galaxy')));

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.querySelector('#spectra-sidebar')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(screen.getByRole('complementary')).toBeTruthy();
    expect(document.querySelector('#spectra-sidebar')?.getAttribute('aria-hidden')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('Zoom 1.5×')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(screen.getByText('Zoom 1.0×')).toBeTruthy();
  });

  it('does not expose NHITS in the primary hover flux readout', async () => {
    getSpectrum.mockResolvedValue(spectrum([10, 20, 30]));
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('Andromeda Galaxy')));
    const chart = screen.getByRole('img', { name: /Spectra of Andromeda Galaxy/ });
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      width: 720, height: 380, left: 0, top: 0, right: 720, bottom: 380, x: 0, y: 0,
      toJSON: () => ({}),
    });
    fireEvent(chart, new MouseEvent('pointermove', { bubbles: true, clientX: 360, clientY: 100 }));
    const tooltip = document.querySelector('.spectral-tooltip');
    expect(tooltip).toBeTruthy();
    expect(tooltip?.textContent ?? '').not.toMatch(/hits/i);
  });

  it('announces interpolated values and distinguishes estimates in the chart and table', async () => {
    const response = spectrum([10, null, 30]);
    expect(response.points[1].available).toBe(false);
    getSpectrum.mockResolvedValue(response);
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('Andromeda Galaxy')));

    expect(screen.getByText('Observed')).toBeTruthy();
    expect(screen.getByText('Interpolated (estimated)')).toBeTruthy();
    expect(document.querySelector('.spectral-estimated-marker')).toBeTruthy();
    expect(screen.getByText('20.0 (estimated)')).toBeTruthy();
  });

  it('hides every estimate from the chart, legend and table when Show estimates is off', async () => {
    getSpectrum.mockResolvedValue(spectrum([10, null, 30]));
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('Andromeda Galaxy')));

    const toggle = screen.getByRole('button', { name: 'Show estimates' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.spectral-estimated-marker')).toBeNull();
    expect(document.querySelector('.spectral-estimated-line')).toBeNull();
    expect(screen.queryByText('Interpolated (estimated)')).toBeNull();
    expect(screen.queryByText(/chart-only estimates/)).toBeNull();
    expect(screen.queryByText('20.0 (estimated)')).toBeNull();
    expect(screen.getByText('Observed')).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.getByText('20.0 (estimated)')).toBeTruthy();
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
    await act(async () => fireEvent.click(catalogButton('Eagle Nebula')));

    expect(screen.getByText('Failed: No All-Sky Cube tile covers this position.')).toBeTruthy();
  });

  it('ignores a stale response after the spectrum was removed and re-added', async () => {
    const first = deferred<CubeSpectrumResponse>();
    const second = deferred<CubeSpectrumResponse>();
    getSpectrum.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<SpectralLab />);

    fireEvent.click(catalogButton('Andromeda Galaxy'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Andromeda Galaxy' }));
    fireEvent.click(catalogButton('Andromeda Galaxy'));

    await act(async () => second.resolve(spectrum([4, 5], 2858)));
    await act(async () => first.reject(new Error('late failure from the first request')));

    expect(legendItems()).toHaveLength(1);
    expect(screen.getByText('2/2 channels · tile 2858')).toBeTruthy();
    expect(screen.queryByText(/late failure/)).toBeNull();
  });

  it('hides and shows a spectrum, then removes it', async () => {
    getSpectrum.mockResolvedValue(spectrum([1, 2]));
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('Andromeda Galaxy')));

    fireEvent.click(screen.getByRole('button', { name: 'Hide Andromeda Galaxy' }));
    expect(screen.getByText('No spectrum plotted yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show Andromeda Galaxy' }));
    expect(screen.getByRole('img', { name: /Spectra of Andromeda Galaxy/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Andromeda Galaxy' }));
    expect(legendItems()).toHaveLength(0);
    expect(catalogButton('Andromeda Galaxy').hasAttribute('disabled')).toBe(false);
  });

  it('notes how many values the log axis cannot draw', async () => {
    getSpectrum.mockResolvedValue(spectrum([-2, 0, 5, 50]));
    render(<SpectralLab />);
    await act(async () => fireEvent.click(catalogButton('Andromeda Galaxy')));

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

  it('adds a spectrum requested from the Sky selection exactly once per request', async () => {
    getSpectrum.mockResolvedValue(spectrum([1, 2], 3016));
    const request = { id: 1, ra: 270.69303, dec: 61.87652, label: '270.693°, 61.877°' };
    const { rerender } = render(<SpectralLab request={request} />);
    await act(async () => {});

    expect(getSpectrum).toHaveBeenCalledTimes(1);
    expect(getSpectrum).toHaveBeenCalledWith(270.69303, 61.87652);
    expect(screen.getByText('270.693°, 61.877°')).toBeTruthy();

    rerender(<SpectralLab request={request} />); // same request re-rendered: no second add
    await act(async () => {});
    expect(getSpectrum).toHaveBeenCalledTimes(1);
    expect(legendItems()).toHaveLength(1);

    rerender(<SpectralLab request={{ ...request, id: 2 }} />); // same place requested again
    await act(async () => {});
    expect(getSpectrum).toHaveBeenCalledTimes(1);
    expect(screen.getByText('270.693°, 61.877° is already in the comparison.')).toBeTruthy();
  });
});

describe('SpectralLab featured objects panel', () => {
  afterEach(() => cleanup());

  it('presents the examples as featured objects, apart from the coordinates form', () => {
    render(<SpectralLab request={null} />);
    expect(screen.getByRole('heading', { name: 'Featured objects' })).toBeTruthy();
    expect(screen.getByText('Well-known targets to get you started')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Or enter coordinates' })).toBeTruthy();
  });

  it('offers only the five best-known objects, popular name first and catalogue name below', () => {
    render(<SpectralLab request={null} />);
    const rows = Array.from(document.querySelectorAll('.spectral-catalog button'));
    expect(rows.map((row) => [
      row.querySelector('.spectral-catalog-title')?.textContent,
      row.querySelector('.spectral-catalog-subtitle')?.textContent,
      row.querySelector('.spectral-catalog-type')?.textContent,
    ])).toEqual([
      ['Andromeda Galaxy', 'M31', 'Galaxy'],
      ['Eagle Nebula', 'M16', 'Nebula'],
      ['Pleiades', 'M45', 'Star cluster'],
      ['Crab Nebula', 'M1', 'Supernova remnant'],
      ['Whirlpool Galaxy', 'M51', 'Galaxy'],
    ]);
  });

  it('plots a featured object at its SIMBAD position under its popular name', async () => {
    render(<SpectralLab request={null} />);
    await act(async () => fireEvent.click(catalogButton('Andromeda Galaxy')));
    expect(getSpectrum).toHaveBeenCalledWith(10.684708, 41.26875);
  });
});

describe('SpectralLab tour anchors', () => {
  afterEach(() => cleanup());

  it('marks each part the Spectral Lab tour points at', () => {
    render(<SpectralLab request={null} />);
    for (const anchor of ['lab-add', 'lab-compare', 'lab-axis', 'lab-chart', 'lab-sidebar']) {
      expect(document.querySelectorAll(`[data-tour="${anchor}"]`)).toHaveLength(1);
    }
  });
});
