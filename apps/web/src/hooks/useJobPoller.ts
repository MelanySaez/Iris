import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { JobSnapshot } from '../types';

export function useJobPoller(
  jobId: string | null,
  initialSnapshot: JobSnapshot | null = null,
) {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(initialSnapshot);
  const [isPolling, setIsPolling] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const activeJobIdRef = useRef<string | null>(jobId);

  useEffect(() => {
    activeJobIdRef.current = jobId;
    if (!jobId) {
      setSnapshot(null);
      setIsPolling(false);
      setPollError(null);
      return;
    }

    // If initialSnapshot matches and is already terminal, use it and don't poll
    if (initialSnapshot && initialSnapshot.id === jobId) {
      setSnapshot(initialSnapshot);
      if (initialSnapshot.status === 'ready' || initialSnapshot.status === 'failed') {
        setIsPolling(false);
        return;
      }
    }

    let isMounted = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const next = await api.getJob(jobId);
        if (!isMounted || activeJobIdRef.current !== jobId) return;

        setSnapshot(next);
        setPollError(null);

        if (next.status === 'ready' || next.status === 'failed') {
          setIsPolling(false);
        } else {
          setIsPolling(true);
          timer = window.setTimeout(poll, 700);
        }
      } catch (err) {
        if (!isMounted || activeJobIdRef.current !== jobId) return;
        const msg = err instanceof ApiError ? (err.detail ?? err.message) : String(err);
        setPollError(msg);
        // Continue polling or stop on terminal 404? Continue retry unless 404
        if (err instanceof ApiError && err.status === 404) {
          setIsPolling(false);
        } else {
          timer = window.setTimeout(poll, 700);
        }
      }
    };

    setIsPolling(true);
    void poll();

    return () => {
      isMounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId, initialSnapshot]);

  const updateSnapshot = (newSnap: JobSnapshot) => {
    setSnapshot(newSnap);
  };

  return { snapshot, isPolling, pollError, updateSnapshot };
}
