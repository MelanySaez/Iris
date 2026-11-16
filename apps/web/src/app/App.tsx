import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/api';
import { TopBar } from '../components/TopBar';
import { WorkspaceErrorBoundary } from '../components/WorkspaceErrorBoundary';
import { PlateWorkspace } from '../components/plate/PlateWorkspace';
import { RecordsWorkspace } from '../components/records/RecordsWorkspace';
import {
  SkyWorkspace,
  type AssistantSkyCommand,
  type SelectionRestoreRequest,
  type SkyUiState,
} from '../components/sky/SkyWorkspace';
import { AssistantWidget, type ActionResult } from '../components/assistant/AssistantWidget';
import { AssistantGuide, type GuideCueItem } from '../components/assistant/AssistantGuide';
import { Landing } from '../components/landing/Landing';
import { GuidedTour, hasSeenTour, tourAnchorsReady } from '../components/tour/GuidedTour';
import { tourForRoute, type TourId } from '../components/tour/tourSteps';
import { ConsentBar } from '../components/consent/ConsentBar';
import { guideCueFor, type AssistantAction, type AssistantUiContext } from '../services/assistant';
import { SpectralLab, type SpectrumRequest } from '../components/spectral/SpectralLab';
import type { SpectrumTarget } from '../components/sky/SelectionActions';
import { useJobPoller } from '../hooks/useJobPoller';
import { useRecordsConsent } from '../hooks/useRecordsConsent';
import { useRoute } from '../core/router';
import type { JobCreateRequest, RegionRequest } from '../types/types';

export function App() {
  const { route, navigate } = useRoute();

  const [contractError, setContractError] = useState<string | null>(null);
  // After "Explore the Sky" the landing stays on top while it fades into the viewer.
  const [landingExit, setLandingExit] = useState(false);
  const endLandingExit = useCallback(() => setLandingExit(false), []);
  // Guided tours: one per workspace, started from the same "?" button for the tab on screen.
  const [tourRun, setTourRun] = useState(false);
  const [tourId, setTourId] = useState<TourId>('sky');
  // A new key per start remounts Joyride, so every press begins a fresh tour
  // even if an earlier one was left half-way (paused by a tab change, closed, …).
  const [tourKey, setTourKey] = useState(0);
  const tourTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tours already started this session (by "?", the landing or a first visit).
  const toursOffered = useRef(new Set<TourId>());
  // Set by the landing's Guided Tour button: every workspace then shows its tour
  // once more on the next visit, even if this browser has seen it before.
  const guidedVisit = useRef(false);
  const startTour = useCallback(
    (tour: TourId, delayMs: number) => {
      toursOffered.current.add(tour);
      if (tour === 'sky') navigate('#/sky');
      if (tourTimer.current) clearTimeout(tourTimer.current);
      setTourId(tour);
      setTourRun(false);
      setTourKey((key) => key + 1);
      tourTimer.current = setTimeout(() => setTourRun(true), delayMs);
    },
    [navigate],
  );
  useEffect(() => () => {
    if (tourTimer.current) clearTimeout(tourTimer.current);
  }, []);
  const endTour = useCallback(() => setTourRun(false), []);

  // The first visit to each workspace runs its tour once; "?" replays it any time. It waits
  // until the workspace has drawn what the tour points at (a plate may still be loading)
  // and gives up after ~10 s, to try again on the next visit.
  useEffect(() => {
    if (route.type === 'landing') return undefined;
    const tour = tourForRoute(route.type);
    if ((!guidedVisit.current && hasSeenTour(tour)) || toursOffered.current.has(tour)) return undefined;
    let polls = 0;
    const poll = setInterval(() => {
      polls += 1;
      if (tourAnchorsReady(tour)) {
        clearInterval(poll);
        // Sky waits for the arrival from the landing page to fade, like the landing's tour button.
        startTour(tour, tour === 'sky' ? 1100 : 300);
      } else if (polls >= 40) {
        clearInterval(poll);
      }
    }, 250);
    return () => clearInterval(poll);
  }, [route.type, startTour]);

  // The viewer's own arrival (900 ms) outlasts the landing fade, so it has its own timer.
  const [appArriving, setAppArriving] = useState(false);
  useEffect(() => {
    if (!appArriving) return undefined;
    const timer = setTimeout(() => setAppArriving(false), 1000);
    return () => clearTimeout(timer);
  }, [appArriving]);
  useEffect(() => {
    let active = true;
    void api.getHealth().then((health) => {
      if (active && 'api_contract' in health && health.api_contract === 'spectral-local-v1') {
        setContractError('Backend API mismatch: this workspace requires /api/jobs, but apps/server currently exposes /api/spectral. Spectral discovery is not connected yet.');
      }
    }).catch((error) => { if (active) setContractError(`Backend unavailable: ${String(error)}`); });
    return () => { active = false; };
  }, []);

  // Active Job state
  const [activeJobId, setActiveJobId] = useState<string | null>(() => {
    return route.type === 'plate' ? route.jobId : null;
  });
  const [jobCreateError, setJobCreateError] = useState<string | null>(null);

  const { snapshot: activeJob, updateSnapshot, pollError, pollRetry, retryPoll } = useJobPoller(activeJobId);
  const consent = useRecordsConsent();
  const { beginJob } = consent;

  // Track the live route so job creation can follow the current workspace
  // without re-creating the callback on every navigation.
  const routeRef = useRef(route);
  routeRef.current = route;

  // If URL changes to #/plate/{id}, keep activeJobId in sync
  useEffect(() => {
    if (route.type === 'plate' && route.jobId !== activeJobId) {
      setActiveJobId(route.jobId);
    }
  }, [route, activeJobId]);

  // Create job from sky or plate
  const handleStartJob = useCallback(
    async (req: JobCreateRequest) => {
      // Without cookies the backend saves nothing; the job is recovered on acceptance.
      const finishJob = beginJob();
      try {
        const snap = await api.createJob(req);
        finishJob(snap.id);
        updateSnapshot(snap);
        setActiveJobId(snap.id);
        setJobCreateError(null);
        // When a job is created from the plate workspace (channel switch or
        // optional product load), follow it in the route. Otherwise the route
        // sync effect above would revert activeJobId to the previous job.
        if (routeRef.current.type === 'plate') {
          navigate({ type: 'plate', jobId: snap.id });
        }
      } catch (err) {
        const detail = err instanceof ApiError ? (err.detail ?? err.message) : String(err);
        setJobCreateError(detail);
        // Let callers that await the job (plate channel/product switches)
        // surface their own contextual error state.
        throw err;
      }
    },
    [updateSnapshot, navigate, beginJob],
  );

  // Sky selection → Spectral Lab: each click is a new request id, consumed once.
  const [spectrumRequest, setSpectrumRequest] = useState<SpectrumRequest | null>(null);
  const handleViewSpectrum = useCallback(
    (target: SpectrumTarget) => {
      setSpectrumRequest((prev) => ({
        id: (prev?.id ?? 0) + 1,
        ra: target.ra_deg,
        dec: target.dec_deg,
        label: target.label,
      }));
      navigate('#/spectral');
    },
    [navigate],
  );

  // Records → Sky: rebuild a recorded selection on the map; each click is a new request id.
  const [restoreRequest, setRestoreRequest] = useState<SelectionRestoreRequest | null>(null);
  const handleShowInSky = useCallback(
    (region: RegionRequest) => {
      setRestoreRequest((prev) => ({ id: (prev?.id ?? 0) + 1, region }));
      navigate('#/sky');
    },
    [navigate],
  );

  // Assistant: reads the interface through skyStateRef (no re-render on every
  // map update) and drives it with validated actions.
  const skyStateRef = useRef<SkyUiState>({});
  const handleSkyState = useCallback((state: SkyUiState) => {
    skyStateRef.current = state;
  }, []);
  const [assistantCommands, setAssistantCommands] = useState<AssistantSkyCommand[]>([]);
  const assistantCommandId = useRef(0);

  const getAssistantContext = (): AssistantUiContext => {
    const { center, ...sky } = skyStateRef.current;
    return {
      // The assistant is hidden on the landing page; the viewer starts on Sky.
      workspace: route.type === 'landing' ? 'sky' : route.type,
      ...sky,
      ...(center && center.every(Number.isFinite)
        ? { center: [((center[0] % 360) + 360) % 360, center[1]] as [number, number] }
        : {}),
      ...(activeJobId ? { active_job_id: activeJobId } : {}),
    };
  };

  // Visual guide: each action the assistant runs points at what it changed.
  const [guideCues, setGuideCues] = useState<GuideCueItem[]>([]);
  const guideCueId = useRef(0);

  const handleAssistantAction = (action: AssistantAction): ActionResult => {
    const result = runAssistantAction(action);
    if (result.ok) {
      guideCueId.current += 1;
      const cue = { id: guideCueId.current, ...guideCueFor(action) };
      setGuideCues((prev) => [...prev, cue]);
    }
    return result;
  };

  const runAssistantAction = (action: AssistantAction): ActionResult => {
    if (action.type === 'navigate') {
      if (action.workspace === 'plate') {
        if (!activeJobId) return { ok: false, detail: 'No active job to open in Plate' };
        navigate({ type: 'plate', jobId: activeJobId });
      } else {
        navigate(`#/${action.workspace}`);
      }
      return { ok: true };
    }
    assistantCommandId.current += 1;
    const command = { id: assistantCommandId.current, action };
    // Keep a short tail; SkyWorkspace applies each id once.
    setAssistantCommands((prev) => [...prev, command].slice(-20));
    navigate('#/sky');
    return { ok: true };
  };

  const handleOpenPlate = (jobId: string) => {
    navigate({ type: 'plate', jobId });
  };

  const handleRetryJob = () => {
    if (activeJob?.request) {
      void handleStartJob(activeJob.request).catch(() => {
        // Error is surfaced through jobCreateError.
      });
    }
  };

  const isLanding = route.type === 'landing';
  const isSky = route.type === 'sky';
  const isPlate = route.type === 'plate';
  const isSpectral = route.type === 'spectral';
  const isRecords = route.type === 'records';

  return (
    <div className={`planet-app-shell${appArriving ? ' app-arriving' : ''}`}>
      {/* The viewer stays mounted underneath so the sky is ready when the visitor enters. */}
      {(isLanding || landingExit) && (
        <Landing
          leaving={!isLanding}
          onExplore={() => {
            setLandingExit(true);
            setAppArriving(true);
            navigate('#/sky');
          }}
          onTour={() => {
            setLandingExit(true);
            setAppArriving(true);
            guidedVisit.current = true;
            toursOffered.current.clear();
            startTour('sky', 1100); // after the viewer has come out of the dark
          }}
          onExited={endLandingExit}
        />
      )}
      <TopBar currentRoute={route} activeJobId={activeJobId} onNavigate={navigate} onStartTour={() => startTour(tourForRoute(route.type), 250)} />
      <GuidedTour key={tourKey} tour={tourId} run={tourRun && route.type === tourId} onEnd={endTour} />

      {contractError && <p role="alert">{contractError}</p>}
      {jobCreateError && (
        <div className="job-create-error-banner" role="alert">
          <span>Could not prepare the spectral job: {jobCreateError}</span>
          <button
            type="button"
            className="banner-close"
            aria-label="Dismiss job error"
            onClick={() => setJobCreateError(null)}
          >
            ×
          </button>
        </div>
      )}
      <div className="workspace-container">
        {/* Sky Workspace - kept permanently mounted to preserve Aladin canvas state */}
        <div
          className={`workspace-layer sky-layer ${isSky ? 'layer-active' : 'layer-hidden'}`}
          aria-hidden={!isSky}
        >
          <WorkspaceErrorBoundary workspace="Sky">
            <SkyWorkspace
              activeJob={activeJob}
              onStartJob={handleStartJob}
              onOpenPlate={handleOpenPlate}
              onViewSpectrum={handleViewSpectrum}
              restoreRequest={restoreRequest}
              assistantCommands={assistantCommands}
              onStateChange={handleSkyState}
              onRetryJob={handleRetryJob}
            />
          </WorkspaceErrorBoundary>
        </div>

        {/* Spectral Lab - kept mounted so the comparison survives navigation */}
        <div
          className={`workspace-layer spectral-layer ${isSpectral ? 'layer-active' : 'layer-hidden'}`}
          aria-hidden={!isSpectral}
        >
          <WorkspaceErrorBoundary workspace="Spectral Lab">
            <SpectralLab request={spectrumRequest} />
          </WorkspaceErrorBoundary>
        </div>

        {isRecords && (
          <div className="workspace-layer records-layer layer-active" aria-hidden={false}>
            <WorkspaceErrorBoundary workspace="Records">
              <RecordsWorkspace
                key={consent.recordsVersion}
                onOpenPlate={handleOpenPlate}
                onShowInSky={handleShowInSky}
                recordsEnabled={consent.recordsEnabled}
                onOpenCookieSettings={consent.openBar}
              />
            </WorkspaceErrorBoundary>
          </div>
        )}

        {/* Plate Workspace - rendered when route is plate and job is loaded */}
        {isPlate && (
          <div className="workspace-layer plate-layer layer-active" aria-hidden={false}>
            {activeJob ? (
              <WorkspaceErrorBoundary workspace="Plate">
                <PlateWorkspace
                  job={activeJob}
                  pollError={pollError}
                  pollRetry={pollRetry}
                  onRetryPoll={retryPoll}
                  onBackToSky={() => navigate('#/sky')}
                  onRequestNewJob={handleStartJob}
                />
              </WorkspaceErrorBoundary>
            ) : pollError ? (<div className="plate-loading-page" role="alert"><h2>Could not load the spectral job</h2><p>{pollError}</p><button type="button" onClick={retryPoll}>Try again</button></div>) : (
              <div className="plate-loading-page" role="status">
                <div className="plate-paper-skeleton">
                  <div className="skeleton-line title" />
                  <div className="skeleton-box stage" />
                  <p className="skeleton-msg">Loading Level-2 Spectral Plate {route.jobId}…</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {!isLanding && <AssistantWidget getContext={getAssistantContext} onAction={handleAssistantAction} />}
      {!isLanding && <AssistantGuide cues={guideCues} />}
      {consent.barOpen && (
        <ConsentBar onChoose={(level) => void consent.choose(level)} saving={consent.saving} error={consent.error} />
      )}
    </div>
  );
}
