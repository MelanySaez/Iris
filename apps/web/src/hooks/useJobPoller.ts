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
  const [pollRetry, setPollRetry] = useState<{ attempt: number; delaySeconds: number } | null>(null);
  const [restartToken, setRestartToken] = useState(0);
  const activeJobIdRef = useRef<string | null>(jobId);

  useEffect(() => {
    activeJobIdRef.current = jobId;
    if (!jobId) {
      setSnapshot(null);
      setIsPolling(false);
      setPollError(null);
      setPollRetry(null);
      return;
    }

    setSnapshot((current) => current?.id === jobId ? current : null);
    setPollError(null);
    setPollRetry(null);

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
    let failures = 0;

    const poll = async () => {
      try {
        const next = await api.getJob(jobId);
        if (!isMounted || activeJobIdRef.current !== jobId) return;

        setSnapshot(next);
        setPollError(null);
        setPollRetry(null);
        failures = 0;

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
        failures += 1;
        if ((err instanceof ApiError && err.status === 404) || failures >= 5) {
          setIsPolling(false);
          setPollRetry(null);
        } else {
          const delay = Math.min(11200, 700 * 2 ** (failures - 1));
          setPollRetry({ attempt: failures, delaySeconds: delay / 1000 });
          timer = window.setTimeout(poll, delay);
        }
      }
    };

    setIsPolling(true);
    void poll();

    return () => {
      isMounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId, initialSnapshot, restartToken]);

  const updateSnapshot = (newSnap: JobSnapshot) => {
    setSnapshot(newSnap);
  };

  return { snapshot, isPolling, pollError, pollRetry, retryPoll: () => setRestartToken((value) => value + 1), updateSnapshot };
}
