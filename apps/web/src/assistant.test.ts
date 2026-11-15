import { describe, expect, it } from 'vitest';
import { describeAssistantAction, validateAssistantAction } from './assistant';

describe('validateAssistantAction', () => {
  it('accepts 180-arcmin mosaics and rejects larger assistant regions', () => {
    for (const size_arcmin of [1, 60, 180]) {
      expect(validateAssistantAction({ type: 'show_region', ra_deg: 10, dec_deg: 0, size_arcmin }))
        .toEqual({ action: { type: 'show_region', ra_deg: 10, dec_deg: 0, size_arcmin } });
    }
    expect(validateAssistantAction({ type: 'show_region', ra_deg: 10, dec_deg: 0, size_arcmin: 181 }))
      .toEqual({ error: 'size_arcmin must be in [1, 180]' });
  });
  it('accepts every action the backend can return', () => {
    expect(validateAssistantAction({ type: 'navigate', workspace: 'records' })).toEqual({
      action: { type: 'navigate', workspace: 'records' },
    });
    expect(
      validateAssistantAction({ type: 'show_region', ra_deg: 210.8, dec_deg: 54.35, size_arcmin: 12 }),
    ).toEqual({ action: { type: 'show_region', ra_deg: 210.8, dec_deg: 54.35, size_arcmin: 12 } });
    expect(validateAssistantAction({ type: 'set_channel', channel: 44 })).toEqual({
      action: { type: 'set_channel', channel: 44 },
    });
    expect(validateAssistantAction({ type: 'set_color_mode', mode: 'rgb', rgb: [16, 32, 46] })).toEqual({
      action: { type: 'set_color_mode', mode: 'rgb', rgb: [16, 32, 46] },
    });
    expect(validateAssistantAction({ type: 'set_color_mode', mode: 'single', rgb: null })).toEqual({
      action: { type: 'set_color_mode', mode: 'single', rgb: null },
    });
  });

  it.each([
    [{ type: 'delete_selection', id: 'x' }, 'Unknown action'],
    [{ type: 'navigate', workspace: 'settings' }, 'workspace'],
    [{ type: 'show_region', ra_deg: 360, dec_deg: 0, size_arcmin: 6 }, 'ra_deg'],
    [{ type: 'show_region', ra_deg: 10, dec_deg: -91, size_arcmin: 6 }, 'dec_deg'],
    [{ type: 'show_region', ra_deg: 10, dec_deg: 0, size_arcmin: 0.5 }, 'size_arcmin'],
    [{ type: 'set_channel', channel: 51 }, 'channel'],
    [{ type: 'set_channel', channel: 4.5 }, 'channel'],
    [{ type: 'set_color_mode', mode: 'rgb', rgb: [16, 32] }, 'rgb'],
    [{ type: 'set_color_mode', mode: 'single', rgb: [1, 2, 3] }, 'rgb'],
    [{ type: 'navigate', workspace: 'sky', href: 'https://evil.example' }, 'Unexpected'],
    ['navigate', 'Unknown action'],
  ])('rejects %j', (raw, message) => {
    const result = validateAssistantAction(raw);
    expect('error' in result && result.error).toContain(message);
  });
});

describe('describeAssistantAction', () => {
  it('describes actions in plain words', () => {
    expect(describeAssistantAction({ type: 'navigate', workspace: 'spectral' })).toBe('Open Spectral Lab');
    expect(describeAssistantAction({ type: 'set_color_mode', mode: 'rgb', rgb: [16, 32, 46] })).toBe(
      'RGB composite 16/32/46',
    );
    expect(describeAssistantAction({ type: 'show_region', ra_deg: 10, dec_deg: -5, size_arcmin: 6 })).toBe(
      'Show region RA 10.000°, Dec -5.000°, 6′',
    );
  });
});
