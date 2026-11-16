// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/api';
import type { JobSnapshot } from '../../types/types';
import { PlateFitsLoader } from './PlateFitsLoader';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const file = () => new File([new Uint8Array([1, 2, 3])], 'mine.fits', { type: 'application/fits' });

describe('PlateFitsLoader', () => {
  it('explains which SPHEREx files it opens and offers the Sky flow', () => {
    const onBrowseSky = vi.fn();
    render(<PlateFitsLoader onOpened={vi.fn()} onBrowseSky={onBrowseSky} />);
    const page = screen.getByRole('region', { name: 'Open a SPHEREx FITS' });
    expect(page.textContent).toContain('SPHEREx Level-2 image or cutout');
    expect(page.textContent).toContain('DR1 All-Sky Cube tile');
    fireEvent.click(screen.getByRole('button', { name: 'Select a region in Sky' }));
    expect(onBrowseSky).toHaveBeenCalledTimes(1);
  });

  it('uploads the chosen file, shows progress and opens the plate', async () => {
    let report: (sent: number, total: number) => void = () => {};
    let finish: (snap: JobSnapshot) => void = () => {};
    const upload = vi.spyOn(api, 'uploadFits').mockImplementation((_file, onProgress) => {
      report = onProgress ?? (() => {});
      return new Promise((resolve) => { finish = resolve; });
    });
    const onOpened = vi.fn();
    render(<PlateFitsLoader onOpened={onOpened} onBrowseSky={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Choose a FITS file'), { target: { files: [file()] } });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ name: 'mine.fits' }), expect.any(Function));
    act(() => report(50, 200));
    expect(screen.getByRole('progressbar', { name: 'Uploading mine.fits' }).getAttribute('aria-valuenow')).toBe('25');
    act(() => report(200, 200));
    expect(screen.getByRole('status').textContent).toContain('Reading mine.fits on the server');

    await act(async () => finish({ id: 'upload-abc' } as JobSnapshot));
    expect(onOpened).toHaveBeenCalledWith({ id: 'upload-abc' });
  });

  it('shows why a file was rejected and lets the user try another', async () => {
    vi.spyOn(api, 'uploadFits').mockRejectedValue(
      new ApiError('Upload rejected', 422, 'This FITS is not a SPHEREx file Plate can open.'),
    );
    render(<PlateFitsLoader onOpened={vi.fn()} onBrowseSky={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Choose a FITS file'), { target: { files: [file()] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toContain('This FITS is not a SPHEREx file Plate can open.'));
    expect(screen.getByLabelText('Choose a FITS file').hasAttribute('disabled')).toBe(false);
  });

  it('accepts a dropped file', () => {
    const upload = vi.spyOn(api, 'uploadFits').mockReturnValue(new Promise(() => {}));
    render(<PlateFitsLoader onOpened={vi.fn()} onBrowseSky={vi.fn()} />);
    fireEvent.drop(screen.getByRole('region', { name: 'Open a SPHEREx FITS' }), { dataTransfer: { files: [file()] } });
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

it.each(['picker', 'drop'])('rejects a file above 350 MB through %s before uploading and permits retry', (method) => {
  const upload = vi.spyOn(api, 'uploadFits').mockReturnValue(new Promise(() => {}));
  const onOpened = vi.fn();
  render(<PlateFitsLoader onOpened={onOpened} onBrowseSky={vi.fn()} />);
  const oversized = file();
  Object.defineProperty(oversized, 'size', { value: 350_000_001 });
  if (method === 'picker') {
    fireEvent.change(screen.getByLabelText('Choose a FITS file'), { target: { files: [oversized] } });
  } else {
    fireEvent.drop(screen.getByRole('region', { name: 'Open a SPHEREx FITS' }), { dataTransfer: { files: [oversized] } });
  }
  expect(screen.getByRole('alert').textContent).toBe('The file exceeds the 350 MB upload limit. Choose a smaller FITS file.');
  expect(upload).not.toHaveBeenCalled();
  expect(onOpened).not.toHaveBeenCalled();
  const atLimit = file();
  Object.defineProperty(atLimit, 'size', { value: 350_000_000 });
  fireEvent.change(screen.getByLabelText('Choose a FITS file'), { target: { files: [atLimit] } });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
});
