/**
 * Pure helpers for the saved-selections (records) workspace.
 */
import { formatRaDec } from '../utils/format';
import type { SelectionView } from './selectionView';
import type { SelectionEvent, SelectionSummary } from '../types/types';

export const RECORDS_PAGE_SIZE = 25;

export function describeSelectionRegion(selection: SelectionSummary): string {
  const { ra_deg, dec_deg, size_arcmin } = selection.region;
  return `${formatRaDec(ra_deg, dec_deg)} · ${Number(size_arcmin.toFixed(3))}′`;
}

export function canOpenInPlate(selection: SelectionSummary): boolean {
  return selection.job_status === 'ready';
}

export function removeSelection(list: SelectionSummary[], id: string): SelectionSummary[] {
  return list.filter((item) => item.id !== id);
}

/** Reason shown for a failed selection; null for any other status. */
export function selectionError(selection: SelectionSummary): string | null {
  if (selection.job_status !== 'failed') return null;
  return selection.job_error ?? 'Failed without a recorded reason.';
}

export interface FailureDetails {
  message: string;
  /** Pipeline stage that was running when the job failed. */
  stage: string | null;
  /** Stable failure category, e.g. no_coverage or download_failed. */
  kind: string | null;
  /** Traceback for unexpected errors (file and line of the failure). */
  trace: string | null;
  timeline: { stage: string; offset: string }[];
}

function timelineOffsets(events: SelectionEvent[] | null): FailureDetails['timeline'] {
  if (!events || events.length === 0) return [];
  const start = events[0].at;
  return events.map((event) => ({
    stage: event.stage,
    offset: `+${(event.at - start).toFixed(1)}s`,
  }));
}

/** Everything known about why and where a failed selection stopped. */
export function failureDetails(selection: SelectionSummary): FailureDetails | null {
  const message = selectionError(selection);
  if (message === null) return null;
  return {
    message,
    stage: selection.failed_stage,
    kind: selection.error_kind,
    trace: selection.error_trace,
    timeline: timelineOffsets(selection.job_events),
  };
}

export interface SelectionViewLabel {
  /** `Single` or `RGB · 16/32/46`; the evaluated channel lives in the Channels column. */
  label: string;
  /** `cache`: this browser's saved view; `database`: the view the backend recorded. */
  source: 'cache' | 'database';
}

function rgbLabel(r: number, g: number, b: number): string {
  return `RGB · ${r}/${g}/${b}`;
}

/**
 * How the Sky map showed a selection: the view cached in this browser when it
 * belongs to this record (same evaluated channel), else the one the backend
 * recorded, else null for selections made before views were recorded.
 */
export function describeSelectionView(
  selection: SelectionSummary,
  cached: SelectionView | null,
): SelectionViewLabel | null {
  if (cached && cached.channel !== null && selection.channels.includes(cached.channel)) {
    const label = cached.rgb ? rgbLabel(cached.rgb.r, cached.rgb.g, cached.rgb.b) : 'Single';
    return { label, source: 'cache' };
  }
  if (selection.view_mode === 'rgb' && selection.rgb_channels?.length === 3) {
    const [r, g, b] = selection.rgb_channels;
    return { label: rgbLabel(r, g, b), source: 'database' };
  }
  if (selection.view_mode === 'single') {
    return { label: 'Single', source: 'database' };
  }
  return null;
}

/** Same limit the backend enforces on selection names. */
export const MAX_SELECTION_NAME_LENGTH = 80;

/** Trims a typed name; blank means no name. Rejects names over the backend limit. */
export function normalizeSelectionName(raw: string): { name: string | null } | { error: string } {
  const name = raw.trim();
  if (name.length > MAX_SELECTION_NAME_LENGTH) {
    return { error: `Names can be at most ${MAX_SELECTION_NAME_LENGTH} characters.` };
  }
  return { name: name || null };
}
