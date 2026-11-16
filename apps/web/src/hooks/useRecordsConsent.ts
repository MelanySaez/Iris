import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../api/api';
import { MAX_CLAIMED_JOBS, readConsent, recordsEnabled, type ConsentLevel } from '../core/consent';

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
  /**
   * Call right before sending a job; call the returned function with its id
   * once the backend answers. A job sent while records were off is recovered:
   * at acceptance, or at once if the visitor accepted while it was in flight.
   */
  beginJob: (name?: string) => (jobId: string) => void;
}

/**
 * Jobs sent before accepting cookies, kept in sessionStorage so a reload of
 * this tab does not lose them. Only job ids and optional names are stored;
 * they leave the browser only when the visitor accepts. Closing the tab
 * forgets them.
 */
const PENDING_KEY = 'iris.records.pending';

interface PendingRecords {
  ids: string[];
  names: Record<string, string>;
}

function loadPending(): PendingRecords {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PendingRecords>) : null;
    const ids = Array.isArray(parsed?.ids)
      ? parsed.ids.filter((id): id is string => typeof id === 'string').slice(-MAX_CLAIMED_JOBS)
      : [];
    const names: Record<string, string> = {};
    for (const [id, name] of Object.entries(parsed?.names ?? {})) {
      if (ids.includes(id) && typeof name === 'string') names[id] = name;
    }
    return { ids, names };
  } catch {
    return { ids: [], names: {} };
  }
}

function savePending(state: PendingRecords): void {
  try {
    if (state.ids.length) window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(state));
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Blocked storage: pending jobs still live in memory for this page.
  }
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.detail ?? err.message) : err instanceof Error ? err.message : String(err);
}

/**
 * Cookie consent for Records. Jobs submitted before accepting are kept for
 * this tab (memory plus sessionStorage, so a reload keeps them); accepting
 * sends them to the backend so they become this browser's saved selections.
 */
export function useRecordsConsent(initial: ConsentLevel | null = readConsent()): RecordsConsent {
  const [level, setLevel] = useState<ConsentLevel | null>(initial);
  const [barOpen, setBarOpen] = useState(initial === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordsVersion, setRecordsVersion] = useState(0);
  const levelRef = useRef(level);
  levelRef.current = level;
  const [restored] = useState(loadPending);
  const pending = useRef<string[]>(restored.ids);
  const pendingNames = useRef<Record<string, string>>(restored.names);
  const persist = () => savePending({ ids: pending.current, names: pendingNames.current });

  const remember = (jobId: string, name?: string) => {
    if (name) pendingNames.current[jobId] = name;
    if (!pending.current.includes(jobId)) {
      pending.current = [...pending.current, jobId].slice(-MAX_CLAIMED_JOBS);
      pendingNames.current = Object.fromEntries(
        Object.entries(pendingNames.current).filter(([id]) => pending.current.includes(id)),
      );
    }
    persist();
  };

  const beginJob = useCallback((name?: string) => {
    // With records on when the request leaves, the backend saves the job itself.
    const sentWithRecords = recordsEnabled(levelRef.current);
    return (jobId: string) => {
      if (sentWithRecords) return;
      if (!recordsEnabled(levelRef.current)) {
        remember(jobId, name);
        return;
      }
      // The visitor accepted while this request was in flight: recover it now.
      const claim = name ? api.claimSelections([jobId], { [jobId]: name }) : api.claimSelections([jobId]);
      void claim
        .then(() => setRecordsVersion((version) => version + 1))
        .catch((err: unknown) => {
          remember(jobId, name);
          setError(errorText(err));
          setBarOpen(true);
        });
    };
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
          const names = Object.fromEntries(
            jobIds.filter((id) => pendingNames.current[id]).map((id) => [id, pendingNames.current[id]]),
          );
          if (Object.keys(names).length) await api.claimSelections(jobIds, names);
          else await api.claimSelections(jobIds);
          pending.current = pending.current.filter((id) => !jobIds.includes(id));
          for (const id of jobIds) delete pendingNames.current[id];
          persist();
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
    beginJob,
  };
}
