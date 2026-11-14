/**
 * Pure helpers for the saved-selections (records) workspace.
 */
import { formatRaDec } from './format';
import type { SelectionSummary } from './types';

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
