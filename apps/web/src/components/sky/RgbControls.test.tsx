// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpectralChannel } from '../../api/hips';
import { RgbControls } from './RgbControls';

const channels: SpectralChannel[] = [
  { index: 16, wavelengthMicrometres: 1.102 },
  { index: 32, wavelengthMicrometres: 1.592 },
  { index: 46, wavelengthMicrometres: 2.189 },
  { index: 62, wavelengthMicrometres: 3.293 },
];

function renderControls(overrides: Partial<Parameters<typeof RgbControls>[0]> = {}) {
  const props = {
    ready: true,
    rgbMode: false,
    rgb: null,
    rgbError: null,
    channels,
    onModeChange: vi.fn(),
    onApply: vi.fn(),
    children: <p>single-channel slider</p>,
    ...overrides,
  };
  render(<RgbControls {...props} />);
  return props;
}

describe('RgbControls', () => {
  afterEach(() => cleanup());

  it('shows why RGB could not be enabled while staying on the single channel', () => {
    renderControls({ rgbError: 'Aladin viewer does not support overlay image layers for RGB.' });

    expect(screen.getByRole('alert').textContent).toBe(
      'Aladin viewer does not support overlay image layers for RGB.',
    );
    expect(screen.getByText('single-channel slider')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Single channel' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the single-channel controls without an alert when there is no error', () => {
    renderControls();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('single-channel slider')).toBeTruthy();
  });

  it('shows the drawn channels, presets and the false-colour note in RGB mode', () => {
    const props = renderControls({ rgbMode: true, rgb: { r: 46, g: 32, b: 16 } });

    expect(screen.queryByText('single-channel slider')).toBeNull();
    expect((screen.getByRole('combobox', { name: 'R channel' }) as HTMLSelectElement).value).toBe('46');
    expect(screen.getAllByRole('option', { name: 'ch 62 · 3.293 µm' })).toHaveLength(3);
    expect(screen.getByText(/False colour from display tiles/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Organic dust' }));
    expect(props.onApply).toHaveBeenCalledWith({ r: 62, g: 46, b: 32 });
    fireEvent.change(screen.getByRole('combobox', { name: 'G channel' }), { target: { value: '62' } });
    expect(props.onApply).toHaveBeenLastCalledWith({ r: 46, g: 62, b: 16 });
  });

  it('switches modes and disables the switch until the map is ready', () => {
    const props = renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'RGB composite' }));
    expect(props.onModeChange).toHaveBeenCalledWith(true);

    cleanup();
    renderControls({ ready: false });
    expect(screen.getByRole('button', { name: 'RGB composite' }).hasAttribute('disabled')).toBe(true);
  });
  it('marks the preset whose channels are on the map', () => {
    renderControls({ rgbMode: true, rgb: { r: 46, g: 32, b: 16 } });
    expect(screen.getByRole('button', { name: 'Stars' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Organic dust' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Full range' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('marks no preset once a channel is changed by hand', () => {
    renderControls({ rgbMode: true, rgb: { r: 62, g: 32, b: 16 } });
    for (const name of ['Stars', 'Organic dust', 'Full range']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('false');
    }
  });
});
