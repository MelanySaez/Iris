import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import type { SubmitResult } from '../../searchEnter';
import type { ResolvedName } from '../../types';

export interface ResolvedTarget {
  ra_deg: number;
  dec_deg: number;
  name: string;
}

/** Called by the search box on Enter; reports what the lookup found. */
export type SubmitLookup = () => Promise<SubmitResult>;

interface NameSuggestionProps {
  /** Text typed in the Search objects box. */
  query: string;
  /** Backend name resolution (`api.resolveName`), injectable for tests. */
  resolve: (name: string, signal?: AbortSignal) => Promise<ResolvedName>;
  /** Moves the map to the chosen object. */
  onSelect: (target: ResolvedTarget) => void;
  /** Receives the Enter handler for the search box. */
  submitRef?: { current: SubmitLookup | null };
  /** Pause after the last keystroke before asking the resolver. */
  delayMs?: number;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; name: string }
  | { kind: 'found'; name: string; result: ResolvedName }
  | { kind: 'error'; name: string; message: string };

const SOURCE_LABEL: Record<ResolvedName['source'], string> = {
  simbad: 'SIMBAD',
  ned: 'NED',
  designation: 'Designation',
};

const toTarget = (r: ResolvedName): ResolvedTarget => ({
  ra_deg: r.ra_deg,
  dec_deg: r.dec_deg,
  name: r.name,
});

function errorMessage(err: unknown): string {
  const detail = err instanceof ApiError ? (err.detail ?? err.message) : String(err);
  return err instanceof ApiError && err.status === 503
    ? `${detail} Use “Go to coordinates” meanwhile.`
    : detail;
}

/**
 * First suggestion under the Search objects box: the object SIMBAD/NED knows
 * by the typed name or catalogue code (M31, NGC 224, HD 48915, J…). It is
 * looked up once typing pauses, and immediately when the user presses Enter.
 */
export function NameSuggestion({
  query,
  resolve,
  onSelect,
  submitRef,
  delayMs = 400,
}: NameSuggestionProps) {
  const name = query.trim();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const stateRef = useRef<State>(state);
  stateRef.current = state;
  // Each new query or Enter gets a sequence number; older answers are dropped.
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Request of the current lookup; aborted when the user moves on.
  const inFlight = useRef<AbortController | null>(null);

  const cancelPending = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    inFlight.current?.abort();
    inFlight.current = null;
  };

  const lookUp = useCallback(
    async (target: string): Promise<SubmitResult> => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      seq.current += 1;
      const id = seq.current;
      setState({ kind: 'loading', name: target });
      try {
        const result = await resolve(target, controller.signal);
        if (id !== seq.current) return { kind: 'stale' };
        setState({ kind: 'found', name: target, result });
        return { kind: 'found', target: toTarget(result) };
      } catch (err) {
        if (id !== seq.current || controller.signal.aborted) return { kind: 'stale' };
        setState({ kind: 'error', name: target, message: errorMessage(err) });
        return { kind: 'missed' };
      }
    },
    [resolve],
  );

  // Debounced lookup whenever the typed name changes.
  useEffect(() => {
    cancelPending();
    seq.current += 1; // invalidate any answer still in flight
    setState({ kind: 'idle' });
    if (!name) return undefined;
    timer.current = setTimeout(() => {
      timer.current = null;
      void lookUp(name);
    }, delayMs);
    return cancelPending;
  }, [name, delayMs, lookUp]);

  // Enter: use the suggestion if it is ready, otherwise resolve right now.
  const submit = useCallback<SubmitLookup>(async () => {
    if (!name) return { kind: 'missed' };
    const current = stateRef.current;
    if (current.kind === 'found' && current.name === name) {
      return { kind: 'found', target: toTarget(current.result) };
    }
    cancelPending();
    return lookUp(name);
  }, [name, lookUp]);

  useEffect(() => {
    if (!submitRef) return undefined;
    submitRef.current = submit;
    return () => {
      if (submitRef.current === submit) submitRef.current = null;
    };
  }, [submitRef, submit]);

  if (!name || state.kind === 'idle') return null;

  if (state.kind === 'found') {
    const r = state.result;
    return (
      <button type="button" className="catalog-row name-suggestion" onClick={() => onSelect(toTarget(r))}>
        <div className="catalog-row-top">
          <span className="object-name">{r.name}</span>
        </div>
        <div className="catalog-row-bottom">
          <span className="object-type">
            {[r.object_type, `${r.ra_deg.toFixed(4)}°, ${r.dec_deg >= 0 ? '+' : ''}${r.dec_deg.toFixed(4)}°`]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="name-suggestion-source">{SOURCE_LABEL[r.source]}</span>
        </div>
      </button>
    );
  }

  return (
    <p
      className={`name-suggestion name-suggestion-${state.kind}`}
      role="status"
    >
      {state.kind === 'loading'
        ? `Looking up “${state.name}” in SIMBAD / NED…`
        : state.message}
    </p>
  );
}
