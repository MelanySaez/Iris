import type { ReactNode } from 'react';
import type { SpectralChannel } from '../../hips';
import { RGB_PRESETS, presetChannels, type RgbChannels } from '../../rgb';

interface RgbControlsProps {
  ready: boolean;
  rgbMode: boolean;
  /** Composite currently drawn on the map, or null when none is. */
  rgb: RgbChannels | null;
  rgbError: string | null;
  channels: SpectralChannel[];
  onModeChange: (rgb: boolean) => void;
  onApply: (next: RgbChannels) => void;
  /** Single-channel controls, shown whenever no composite is drawn. */
  children: ReactNode;
}

function channelLabel(channels: SpectralChannel[], index: number): string {
  const wavelength = channels.find((c) => c.index === index)?.wavelengthMicrometres;
  return wavelength === undefined ? `ch ${index}` : `ch ${index} · ${wavelength.toFixed(3)} µm`;
}

/**
 * Sky dock colour controls: Single channel / RGB composite switch, presets and
 * R/G/B selects. The error is shown in both modes, so a failed attempt to turn
 * RGB on is visible even though the map stays on the single channel.
 */
export function RgbControls({
  ready,
  rgbMode,
  rgb,
  rgbError,
  channels,
  onModeChange,
  onApply,
  children,
}: RgbControlsProps) {
  const error = rgbError ? (
    <p className="dock-rgb-error" role="alert">
      {rgbError}
    </p>
  ) : null;

  return (
    <>
      <div className="dock-mode-switch" role="group" aria-label="Sky colour mode">
        <button
          type="button"
          className={`dock-mode-btn ${rgbMode ? '' : 'active'}`}
          aria-pressed={!rgbMode}
          disabled={!ready}
          onClick={() => onModeChange(false)}
        >
          Single channel
        </button>
        <button
          type="button"
          className={`dock-mode-btn ${rgbMode ? 'active' : ''}`}
          aria-pressed={rgbMode}
          disabled={!ready}
          onClick={() => onModeChange(true)}
        >
          RGB composite
        </button>
      </div>

      {rgbMode && rgb ? (
        <div className="dock-rgb" aria-label="RGB band selector">
          <div className="dock-rgb-presets">
            {RGB_PRESETS.map((preset) => {
              const target = presetChannels(channels, preset);
              // Derived from the map, so editing a channel by hand clears the mark.
              const active = target.r === rgb.r && target.g === rgb.g && target.b === rgb.b;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`dock-preset-btn${active ? ' active' : ''}`}
                  aria-pressed={active}
                  title={preset.description}
                  onClick={() => onApply(target)}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <div className="dock-rgb-selects">
            {(['r', 'g', 'b'] as const).map((band) => (
              <label key={band} className={`dock-rgb-select band-${band}`}>
                <span>{band.toUpperCase()}</span>
                <select
                  value={rgb[band]}
                  aria-label={`${band.toUpperCase()} channel`}
                  onChange={(e) => onApply({ ...rgb, [band]: Number(e.target.value) })}
                >
                  {channels.map((c) => (
                    <option key={c.index} value={c.index}>
                      {channelLabel(channels, c.index)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {error ?? (
            <p className="dock-rgb-note">
              False colour from display tiles: for seeing where bands differ, not for measuring.
            </p>
          )}
        </div>
      ) : (
        <>
          {error}
          {children}
        </>
      )}
    </>
  );
}
