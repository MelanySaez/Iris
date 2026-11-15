import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { TopBar } from './components/TopBar';
import { PlateWorkspace } from './components/plate/PlateWorkspace';
import { RecordsWorkspace } from './components/records/RecordsWorkspace';
import { SkyWorkspace, type SelectionRestoreRequest } from './components/sky/SkyWorkspace';
import { SpectralLab, type SpectrumRequest } from './components/spectral/SpectralLab';
import type { SpectrumTarget } from './components/sky/SelectionActions';
import { useJobPoller } from './hooks/useJobPoller';
import { useRoute } from './router';
import type { JobCreateRequest, RegionRequest } from './types';

export function App() {
  const { route, navigate } = useRoute();

  const [contractError, setContractError] = useState<string | null>(null);
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
      try {
        const snap = await api.createJob(req);
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
    [updateSnapshot, navigate],
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

  const isSky = route.type === 'sky';
  const isPlate = route.type === 'plate';
  const isSpectral = route.type === 'spectral';
  const isRecords = route.type === 'records';

  return (
    <div className="planet-app-shell">
      <TopBar currentRoute={route} activeJobId={activeJobId} onNavigate={navigate} />

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
          <SkyWorkspace
            activeJob={activeJob}
            onStartJob={handleStartJob}
            onOpenPlate={handleOpenPlate}
            onViewSpectrum={handleViewSpectrum}
            restoreRequest={restoreRequest}
            onRetryJob={handleRetryJob}
          />
        </div>

        {/* Spectral Lab - kept mounted so the comparison survives navigation */}
        <div
          className={`workspace-layer spectral-layer ${isSpectral ? 'layer-active' : 'layer-hidden'}`}
          aria-hidden={!isSpectral}
        >
          <SpectralLab request={spectrumRequest} />
        </div>

        {isRecords && (
          <div className="workspace-layer records-layer layer-active" aria-hidden={false}>
            <RecordsWorkspace onOpenPlate={handleOpenPlate} onShowInSky={handleShowInSky} />
          </div>
        )}

        {/* Plate Workspace - rendered when route is plate and job is loaded */}
        {isPlate && (
          <div className="workspace-layer plate-layer layer-active" aria-hidden={false}>
            {activeJob ? (
              <PlateWorkspace
                job={activeJob}
                pollError={pollError}
                pollRetry={pollRetry}
                onRetryPoll={retryPoll}
                onBackToSky={() => navigate('#/sky')}
                onRequestNewJob={handleStartJob}
              />
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
    </div>
  );
}
