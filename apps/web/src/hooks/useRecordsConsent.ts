import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { MAX_CLAIMED_JOBS, readConsent, recordsEnabled, type ConsentLevel } from '../consent';

export interface RecordsConsent {
  level: ConsentLevel | null;
  recordsEnabled: boolean;
  /** The cookie bar is shown until a choice is made, or when reopened. */
  barOpen: boolean;
  saving: boolean;
  error: string | null;
  /** Grows whenever saved records may have changed, so Records reloads. */
  recordsVersion: number;
  openBar: () => void;
  choose: (level: ConsentLevel) => Promise<void>;
  /** Remember a job submitted while records are off, to recover it on acceptance. */
  trackJob: (jobId: string) => void;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.detail ?? err.message) : err instanceof Error ? err.message : String(err);
}

/**
 * Cookie consent for Records. Jobs submitted before accepting are kept in
 * memory for this page session only; accepting sends them to the backend so
 * they become this browser's saved selections.
 */
export function useRecordsConsent(initial: ConsentLevel | null = readConsent()): RecordsConsent {
  const [level, setLevel] = useState<ConsentLevel | null>(initial);
  const [barOpen, setBarOpen] = useState(initial === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordsVersion, setRecordsVersion] = useState(0);
  const levelRef = useRef(level);
  levelRef.current = level;
  const pending = useRef<string[]>([]);

  const trackJob = useCallback((jobId: string) => {
    // With records on, the backend saves the job itself.
    if (recordsEnabled(levelRef.current) || pending.current.includes(jobId)) return;
    pending.current = [...pending.current, jobId].slice(-MAX_CLAIMED_JOBS);
  }, []);

  const choose = useCallback(async (next: ConsentLevel) => {
    setSaving(true);
    setError(null);
    try {
      await api.setConsent(next);
      setLevel(next);
      levelRef.current = next;
      if (recordsEnabled(next)) {
        const jobIds = pending.current;
        if (jobIds.length > 0) {
          await api.claimSelections(jobIds);
          pending.current = pending.current.filter((id) => !jobIds.includes(id));
        }
        setRecordsVersion((version) => version + 1);
      }
      setBarOpen(false);
    } catch (err) {
      // Keep the bar (and any pending jobs) so the visitor can try again.
      setError(errorText(err));
      setBarOpen(true);
    } finally {
      setSaving(false);
    }
  }, []);

  const openBar = useCallback(() => setBarOpen(true), []);

  return {
    level,
    recordsEnabled: recordsEnabled(level),
    barOpen,
    saving,
    error,
    recordsVersion,
    openBar,
    choose,
    trackJob,
  };
}
