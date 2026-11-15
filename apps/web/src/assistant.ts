/**
 * Contextual assistant: shared types and the browser-side guardrail for the
 * UI actions the backend returns. The backend already validates every action;
 * this second check means a tampered or malformed reply can never drive the UI
 * outside the same allowlist and ranges.
 */

export type AssistantWorkspace = 'sky' | 'plate' | 'spectral' | 'records';

export type AssistantAction =
  | { type: 'navigate'; workspace: AssistantWorkspace }
  | { type: 'show_region'; ra_deg: number; dec_deg: number; size_arcmin: number }
  | { type: 'set_channel'; channel: number }
  | { type: 'set_color_mode'; mode: 'single'; rgb: null }
  | { type: 'set_color_mode'; mode: 'rgb'; rgb: [number, number, number] };

/** What the browser tells the assistant about the interface (sent as data, never as instructions). */
export interface AssistantUiContext {
  workspace: AssistantWorkspace;
  channel?: number;
  color_mode?: 'single' | 'rgb';
  rgb?: [number, number, number];
  selected_region?: { ra_deg: number; dec_deg: number; size_arcmin: number };
  region_confirmed?: boolean;
  center?: [number, number];
  fov_deg?: number;
  active_job_id?: string;
}

const WORKSPACES: AssistantWorkspace[] = ['sky', 'plate', 'spectral', 'records'];
const WORKSPACE_LABELS: Record<AssistantWorkspace, string> = {
  sky: 'Sky',
  plate: 'Plate',
  spectral: 'Spectral Lab',
  records: 'Records',
};
const FIELDS: Record<AssistantAction['type'], string[]> = {
  navigate: ['workspace'],
  show_region: ['ra_deg', 'dec_deg', 'size_arcmin'],
  set_channel: ['channel'],
  set_color_mode: ['mode', 'rgb'],
};

type Validation = { action: AssistantAction } | { error: string };

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isChannel(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 101 && value !== 50 && value !== 51;
}

export function validateAssistantAction(raw: unknown): Validation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Unknown action' };
  const data = raw as Record<string, unknown>;
  const type = data.type as AssistantAction['type'];
  if (!Object.hasOwn(FIELDS, type)) return { error: `Unknown action ${String(data.type)}` };
  const extra = Object.keys(data).filter((key) => key !== 'type' && !FIELDS[type].includes(key));
  if (extra.length) return { error: `Unexpected field(s) ${extra.join(', ')}` };

  switch (type) {
    case 'navigate':
      return WORKSPACES.includes(data.workspace as AssistantWorkspace)
        ? { action: { type, workspace: data.workspace as AssistantWorkspace } }
        : { error: 'workspace is not a Planet X workspace' };
    case 'show_region': {
      const { ra_deg, dec_deg, size_arcmin } = data;
      if (!isNumber(ra_deg) || ra_deg < 0 || ra_deg >= 360) return { error: 'ra_deg must be in [0, 360)' };
      if (!isNumber(dec_deg) || dec_deg < -90 || dec_deg > 90) return { error: 'dec_deg must be in [-90, 90]' };
      if (!isNumber(size_arcmin) || size_arcmin < 1 || size_arcmin > 60) {
        return { error: 'size_arcmin must be in [1, 60]' };
      }
      return { action: { type, ra_deg, dec_deg, size_arcmin } };
    }
    case 'set_channel':
      return isChannel(data.channel)
        ? { action: { type, channel: data.channel } }
        : { error: 'channel must be 0-101 and not 50 or 51' };
    case 'set_color_mode': {
      if (data.mode === 'single') {
        return data.rgb === null || data.rgb === undefined
          ? { action: { type, mode: 'single', rgb: null } }
          : { error: 'rgb must be null in single mode' };
      }
      if (data.mode !== 'rgb') return { error: 'mode must be single or rgb' };
      const rgb = data.rgb;
      if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every(isChannel)) {
        return { error: 'rgb must be three available channels' };
      }
      return { action: { type, mode: 'rgb', rgb: [rgb[0], rgb[1], rgb[2]] } };
    }
  }
}

/** Short label shown under the assistant's reply for each action it ran. */
export function describeAssistantAction(action: AssistantAction): string {
  switch (action.type) {
    case 'navigate':
      return `Open ${WORKSPACE_LABELS[action.workspace]}`;
    case 'show_region':
      return `Show region RA ${action.ra_deg.toFixed(3)}°, Dec ${action.dec_deg.toFixed(3)}°, ${action.size_arcmin}′`;
    case 'set_channel':
      return `Channel ${action.channel}`;
    case 'set_color_mode':
      return action.mode === 'rgb' ? `RGB composite ${action.rgb.join('/')}` : 'Single channel';
  }
}

/**
 * Where the visual guide points for an action: a control it changes ("field")
 * or the map position it moves to ("position", the centre of the map, since
 * the move centres the map there). ``target`` is a CSS selector.
 */
export interface GuideCue {
  kind: 'field' | 'position';
  target: string;
  label: string;
}

const guideTarget = (name: string) => `[data-assistant-target="${name}"]`;

export function guideCueFor(action: AssistantAction): GuideCue {
  const label = describeAssistantAction(action);
  switch (action.type) {
    case 'navigate':
      return { kind: 'field', target: guideTarget(`workspace-${action.workspace}`), label };
    case 'show_region':
      return { kind: 'position', target: guideTarget('map'), label };
    case 'set_channel':
      return { kind: 'field', target: guideTarget('channel'), label };
    case 'set_color_mode':
      return { kind: 'field', target: guideTarget('color-mode'), label };
  }
}
