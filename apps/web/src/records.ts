/**
 * Pure helpers for the saved-selections (records) workspace.
 */
import { formatRaDec } from './format';
import type { SelectionEvent, SelectionSummary } from './types';

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
