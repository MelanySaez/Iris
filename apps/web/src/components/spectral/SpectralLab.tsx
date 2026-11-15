import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { LAB_FEATURED } from '../../labFeatured';
import { api, ApiError } from '../../api';
import {
  MAX_SPECTRA,
  SERIES_COLORS,
  applyIfCurrent,
  computeDomain,
  countNonPositive,
  lineSegments,
  interpolateMissingFlux,
  interpolatedLineSegments,
  linearScale,
  logScale,
  logTicks,
  nearestChannel,
  panDomain,
  planAdd,
  niceTicks,
  parseCoordinates,
  spectrumKey,
  zoomDomainAt,
} from '../../spectrum';
import type { YScaleMode } from '../../spectrum';
import type { CubeSpectrumResponse } from '../../types';
import './SpectralLab.css';

interface SpectrumEntry {
  key: string;
  /** Identifies the fetch that owns this entry; a re-add gets a new one. */
  requestId: number;
  label: string;
  ra: number;
  dec: number;
  slot: number;
  visible: boolean;
  status: 'loading' | 'ready' | 'error';
  data?: CubeSpectrumResponse;
  error?: string;
}

const CHART_HEIGHT = 380;
const MARGIN = { top: 16, right: 96, bottom: 44, left: 64 };
const MAX_CHART_ZOOM = 8;

function formatValue(value: number | null): string {
  if (value === null) return 'no data';
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/** A spectrum to add, e.g. the centre of a Sky selection; `id` makes each click unique. */
export interface SpectrumRequest {
  id: number;
  ra: number;
  dec: number;
  label: string;
}

export function SpectralLab({ request = null }: { request?: SpectrumRequest | null } = {}) {
  const [entries, setEntries] = useState<SpectrumEntry[]>([]);
  const [raText, setRaText] = useState('');
  const [decText, setDecText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [yMode, setYMode] = useState<YScaleMode>('linear');
  const [showEstimates, setShowEstimates] = useState(true);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const requestCounter = useRef(0);
  // Source of truth for entries between renders: two clicks before React
  // re-renders must both see the first add (no duplicate key or colour slot).
  const entriesRef = useRef<SpectrumEntry[]>([]);
  const updateEntries = useCallback((change: (prev: SpectrumEntry[]) => SpectrumEntry[]) => {
    entriesRef.current = change(entriesRef.current);
    setEntries(entriesRef.current);
  }, []);


  const addSpectrum = useCallback(
    (label: string, ra: number, dec: number) => {
      const key = spectrumKey(ra, dec);
      const plan = planAdd(entriesRef.current, key, label);
      if ('error' in plan) {
        setFormError(plan.error);
        return;
      }
      setFormError(null);
      requestCounter.current += 1;
      const requestId = requestCounter.current;
      updateEntries((prev) => [
        ...prev,
        { key, requestId, label, ra, dec, slot: plan.slot, visible: true, status: 'loading' },
      ]);
      api
        .getSpectrum(ra, dec)
        .then((data) => {
          updateEntries((prev) =>
            applyIfCurrent(prev, key, requestId, { status: 'ready', data }),
          );
        })
        .catch((err: unknown) => {
          const message =
            err instanceof ApiError ? (err.detail ?? err.message) : String(err);
          updateEntries((prev) =>
            applyIfCurrent(prev, key, requestId, { status: 'error', error: message }),
          );
        });
    },
    [updateEntries],
  );

  // Add a requested spectrum once per request id (effects may re-run).
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!request || handledRequest.current === request.id) return;
    handledRequest.current = request.id;
    addSpectrum(request.label, request.ra, request.dec);
  }, [request, addSpectrum]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseCoordinates(raText, decText);
    if ('error' in parsed) {
      setFormError(parsed.error);
      return;
    }
    addSpectrum(`RA ${parsed.ra.toFixed(3)}°, Dec ${parsed.dec.toFixed(3)}°`, parsed.ra, parsed.dec);
  };

  const toggle = (key: string) =>
    updateEntries((prev) => prev.map((e) => (e.key === key ? { ...e, visible: !e.visible } : e)));
  const remove = (key: string) => updateEntries((prev) => prev.filter((e) => e.key !== key));

  const plotted = entries.filter(
    (e): e is SpectrumEntry & { data: CubeSpectrumResponse } =>
      e.visible && e.status === 'ready' && !!e.data,
  );

  return (
    <div className={`spectral-lab${sidebarVisible ? '' : ' sidebar-collapsed'}`}>
      <aside id="spectra-sidebar" className="spectral-sidebar" aria-label="Spectra to compare"
        aria-hidden={!sidebarVisible} inert={!sidebarVisible}>
        <section data-tour="lab-add">
          <h2 className="spectral-heading">Add a spectrum</h2>
          <h3 className="spectral-subheading">Featured objects</h3>
          <p className="spectral-subheading-note">Well-known targets to get you started</p>
          <ul className="spectral-catalog">
            {LAB_FEATURED.map((obj) => {
              const taken = entries.some((e) => e.key === spectrumKey(obj.ra_deg, obj.dec_deg));
              return (
                <li key={obj.id}>
                  <button
                    type="button"
                    disabled={taken}
                    onClick={() => addSpectrum(obj.name, obj.ra_deg, obj.dec_deg)}
                    title={`RA ${obj.ra_deg.toFixed(3)}°, Dec ${obj.dec_deg.toFixed(3)}°`}
                  >
                    <span className="spectral-catalog-names">
                      <span className="spectral-catalog-title">{obj.name}</span>
                      <span className="spectral-catalog-subtitle">{obj.catalogue}</span>
                    </span>
                    <span className="spectral-catalog-type">{taken ? 'added' : obj.type}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <h3 className="spectral-subheading spectral-subheading-coords">Or enter coordinates</h3>
          <form className="spectral-coords" onSubmit={handleSubmit} noValidate>
            <label>
              RA (deg)
              <input
                inputMode="decimal"
                value={raText}
                onChange={(e) => setRaText(e.target.value)}
                placeholder="148.888"
              />
            </label>
            <label>
              Dec (deg)
              <input
                inputMode="decimal"
                value={decText}
                onChange={(e) => setDecText(e.target.value)}
                placeholder="69.065"
              />
            </label>
            <button type="submit">Add</button>
          </form>
          {formError && (
            <p className="spectral-form-error" role="alert">
              {formError}
            </p>
          )}
        </section>

        <section data-tour="lab-compare">
          <h2 className="spectral-heading">
            Comparing {entries.length}/{MAX_SPECTRA}
          </h2>
          {entries.length === 0 && (
            <p className="spectral-muted">Pick an object or type a position to plot its spectrum.</p>
          )}
          <ul className="spectral-legend">
            {entries.map((e) => (
              <li key={e.key} className={e.visible ? '' : 'is-hidden'}>
                <span
                  className="spectral-swatch"
                  style={{ background: SERIES_COLORS[e.slot] }}
                  aria-hidden="true"
                />
                <div className="spectral-legend-text">
                  <strong>{e.label}</strong>
                  <span className="spectral-muted">
                    {e.status === 'loading' && (
                      <span className="spectral-loading" role="status" aria-live="polite" aria-busy="true">
                        Loading cube spectrum…
                      </span>
                    )}
                    {e.status === 'error' && <span role="alert">Failed: {e.error}</span>}
                    {e.status === 'ready' &&
                      e.data &&
                      `${e.data.points.filter((p) => p.available).length}/${e.data.points.length} channels · tile ${e.data.tile.npix}`}
                  </span>
                </div>
                <button
                  type="button"
                  className="spectral-icon-btn"
                  aria-pressed={e.visible}
                  aria-label={`${e.visible ? 'Hide' : 'Show'} ${e.label}`}
                  onClick={() => toggle(e.key)}
                  disabled={e.status !== 'ready'}
                >
                  {e.visible ? 'Hide' : 'Show'}
                </button>
                <button
                  type="button"
                  className="spectral-icon-btn"
                  aria-label={`Remove ${e.label}`}
                  onClick={() => remove(e.key)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>
      <button
        type="button"
        className="spectral-sidebar-toggle"
        data-tour="lab-sidebar"
        aria-label={`${sidebarVisible ? 'Hide' : 'Show'} sidebar`}
        aria-expanded={sidebarVisible}
        aria-controls="spectra-sidebar"
        onClick={() => setSidebarVisible((visible) => !visible)}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
          {/* One arrow, rotated by CSS when collapsed, so it turns instead of jumping. */}
          <path d="M10 3 5 8l5 5" />
        </svg>
        <span>{sidebarVisible ? 'Hide' : 'Show'}</span>
      </button>

      <main className="spectral-main">
        <header className="spectral-main-header">
          <h1>Spectral Lab</h1>
          <p className="spectral-muted">
            Surface brightness per channel from the SPHEREx DR1 All-Sky Cube, 0.75–5 µm.
          </p>
        </header>
        <p className="spectral-disclaimer" role="note">
          Quick-look: one mosaic pixel per position, not calibrated source photometry. Use the
          SPHEREx Spectrophotometry Tool for science-grade spectra. Gaps are channels with no
          coverage at that pixel.
        </p>
        <div className="spectral-controls" data-tour="lab-axis">
          <div className="spectral-toolbar" role="group" aria-label="Brightness axis scale">
            <span className="spectral-muted">Brightness axis</span>
            {(['linear', 'log'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`spectral-toggle ${yMode === mode ? 'active' : ''}`}
                aria-pressed={yMode === mode}
                onClick={() => setYMode(mode)}
              >
                {mode === 'linear' ? 'Linear' : 'Log'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`spectral-toggle ${showEstimates ? 'active' : ''}`}
            aria-pressed={showEstimates}
            title="Fill gaps of up to two channels on the same detector with a straight line"
            onClick={() => setShowEstimates((v) => !v)}
          >
            Show estimates
          </button>
        </div>
        <SpectrumChart entries={plotted} mode={yMode} showEstimates={showEstimates} />
        {plotted.length > 0 && <SpectrumTable entries={plotted} showEstimates={showEstimates} />}
      </main>
    </div>
  );
}

interface PlottedEntry extends SpectrumEntry {
  data: CubeSpectrumResponse;
}

/** Longest run of blank channels the chart fills in; 0 shows the raw measurements only. */
const estimateGap = (showEstimates: boolean) => (showEstimates ? 2 : 0);

function SpectrumChart({ entries, mode, showEstimates }: {
  entries: PlottedEntry[];
  mode: YScaleMode;
  showEstimates: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartId = useId().replace(/:/g, '');
  const [width, setWidth] = useState(720);
  const [hoverChannel, setHoverChannel] = useState<number | null>(null);
  const [viewDomain, setViewDomain] = useState<{ x: [number, number] | null; y: [number, number] | null }>({ x: null, y: null });
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // While the sidebar animates the width changes every frame: redraw at most once per frame.
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(280, Math.floor(entry.contentRect.width));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(next));
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const plottedSeries = useMemo(
    () => entries.map((e) => interpolateMissingFlux(e.data.points, estimateGap(showEstimates))),
    [entries, showEstimates],
  );
  const series = plottedSeries;
  const domain = useMemo(() => computeDomain(series, mode), [series, mode]);
  useEffect(() => {
    setViewDomain({ x: null, y: null });
  }, [domain?.x[0], domain?.x[1], domain?.y[0], domain?.y[1], mode]);
  const hiddenInLog = mode === 'log' ? countNonPositive(series) : 0;
  const hasNonPositiveEstimate = mode === 'log' && plottedSeries.some((points) =>
    points.some((p) => p.interpolated && p.value !== null && p.value <= 0),
  );
  const unit = entries[0]?.data.unit ?? 'MJy/sr';

  if (!domain) {
    return (
      <div ref={containerRef} className="spectral-chart spectral-chart-empty" data-tour="lab-chart">
        <p className="spectral-muted">
          {hasNonPositiveEstimate
            ? 'Interpolated estimate at or below zero cannot be shown on a log axis; switch to Linear or see its value in the data table.'
            : entries.length && mode === 'log'
            ? 'No positive values to draw on a log axis; switch to Linear.'
            : 'No spectrum plotted yet.'}
        </p>
      </div>
    );
  }

  const xDomain = viewDomain.x ?? domain.x;
  const yDomain = viewDomain.y ?? domain.y;

  const plotRight = width - MARGIN.right;
  const plotBottom = CHART_HEIGHT - MARGIN.bottom;
  const x = linearScale(xDomain, [MARGIN.left, plotRight]);
  const y =
    mode === 'log'
      ? logScale(yDomain, [plotBottom, MARGIN.top])
      : linearScale(yDomain, [plotBottom, MARGIN.top]);
  const xTicks = niceTicks(xDomain[0], xDomain[1], Math.max(4, Math.floor(width / 110)));
  const yTicks =
    mode === 'log' ? logTicks(yDomain[0], yDomain[1]) : niceTicks(yDomain[0], yDomain[1], 5);
  const reference = entries[0].data.points;
  const plotWidth = plotRight - MARGIN.left;
  const plotHeight = plotBottom - MARGIN.top;
  const zoomFactor = Math.min(
    (domain.x[1] - domain.x[0]) / (xDomain[1] - xDomain[0]),
    (domain.y[1] - domain.y[0]) / (yDomain[1] - yDomain[0]),
  );

  const setZoom = (factor: number, anchorX = 0.5, anchorY = 0.5) => {
    setViewDomain((current) => ({
      x: panDomain(zoomDomainAt(current.x ?? domain.x, factor, anchorX), 0, domain.x),
      y: panDomain(zoomDomainAt(current.y ?? domain.y, factor, anchorY, mode === 'log'), 0, domain.y, mode === 'log'),
    }));
  };

  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    const localY = ((event.clientY - rect.top) / rect.height) * CHART_HEIGHT;
    if (localX < MARGIN.left || localX > plotRight || localY < MARGIN.top || localY > plotBottom) return;
    setZoom(event.deltaY < 0 ? 1.2 : 1 / 1.2,
      (localX - MARGIN.left) / plotWidth,
      1 - (localY - MARGIN.top) / plotHeight);
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    const localY = ((event.clientY - rect.top) / rect.height) * CHART_HEIGHT;
    if (localX < MARGIN.left || localX > plotRight || localY < MARGIN.top || localY > plotBottom) return;
    dragRef.current = { x: event.clientX, y: event.clientY };
    setHoverChannel(null);
    event.currentTarget.classList.add('is-panning');
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer capture may be unavailable. */ }
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    event.currentTarget.classList.remove('is-panning');
  };

  const handleMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    if (dragRef.current) {
      const dx = event.clientX - dragRef.current.x;
      const dy = event.clientY - dragRef.current.y;
      dragRef.current = { x: event.clientX, y: event.clientY };
      setViewDomain((current) => ({
        x: panDomain(current.x ?? domain.x, -dx / plotWidth, domain.x),
        y: panDomain(current.y ?? domain.y, dy / plotHeight, domain.y, mode === 'log'),
      }));
      return;
    }
    if (px < MARGIN.left || px > plotRight) {
      setHoverChannel(null);
      return;
    }
    const wavelength = xDomain[0] + ((px - MARGIN.left) / (plotRight - MARGIN.left)) * (xDomain[1] - xDomain[0]);
    setHoverChannel(nearestChannel(reference, wavelength));
  };

  // Direct labels at the last available point, nudged apart vertically.
  const labels = entries
    .map((e) => {
      const last = [...e.data.points]
        .reverse()
        .find((p) => p.value !== null && Number.isFinite(y(p.value)));
      return last ? { key: e.key, text: e.label, y: y(last.value as number) } : null;
    })
    .filter((l): l is { key: string; text: string; y: number } => l !== null)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i += 1) {
    labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14);
  }

  const hovered = hoverChannel !== null ? reference[hoverChannel] : null;
  const tooltipLeft = hovered ? x(hovered.wavelength_um) : 0;

  return (
    <div ref={containerRef} className="spectral-chart" data-tour="lab-chart">
      <div className="spectral-chart-zoom" role="group" aria-label="Chart zoom controls">
        <button type="button" className="spectral-toggle" aria-label="Zoom out" disabled={zoomFactor <= 1.01}
          onClick={() => setZoom(1 / 1.5)}>−</button>
        <span aria-live="polite">Zoom {Math.max(1, zoomFactor).toFixed(1)}×</span>
        <button type="button" className="spectral-toggle" aria-label="Zoom in" disabled={zoomFactor >= MAX_CHART_ZOOM}
          onClick={() => setZoom(1.5)}>+</button>
        <button type="button" className="spectral-toggle" aria-label="Reset zoom" disabled={zoomFactor <= 1.01}
          onClick={() => setViewDomain({ x: null, y: null })}>Reset</button>
        <span className="spectral-chart-hint">Scroll to zoom · drag to move</span>
      </div>
      <svg
        width="100%"
        height={CHART_HEIGHT}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        role="img"
        aria-label={`Spectra of ${entries.map((e) => e.label).join(', ')}: wavelength in microns against surface brightness in ${unit}, zoom ${Math.max(1, zoomFactor).toFixed(1)} times`}
        onPointerDown={handlePointerDown}
        onPointerMove={handleMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onPointerLeave={(event) => { if (!dragRef.current) setHoverChannel(null); else handlePointerUp(event); }}
      >
        <defs>
          <clipPath id={`${chartId}-plot-clip`}>
            <rect x={MARGIN.left} y={MARGIN.top} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line className="spectral-grid" x1={MARGIN.left} x2={plotRight} y1={y(t)} y2={y(t)} />
            <text className="spectral-tick" x={MARGIN.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {t}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x${t}`} className="spectral-tick" x={x(t)} y={plotBottom + 18} textAnchor="middle">
            {t}
          </text>
        ))}
        <line className="spectral-axis" x1={MARGIN.left} x2={plotRight} y1={plotBottom} y2={plotBottom} />
        <text className="spectral-axis-title" x={(MARGIN.left + plotRight) / 2} y={CHART_HEIGHT - 6} textAnchor="middle">
          Wavelength (µm)
        </text>
        <text
          className="spectral-axis-title"
          transform={`translate(14 ${(MARGIN.top + plotBottom) / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          Surface brightness ({unit})
        </text>

        <g className="spectral-series-data" clipPath={`url(#${chartId}-plot-clip)`}>
        {entries.map((e, entryIndex) => (
          <g key={e.key} stroke={SERIES_COLORS[e.slot]}>
            {lineSegments(e.data.points, x, y).map((d, i) => (
              <path key={i} d={d} className="spectral-line" />
            ))}
            {interpolatedLineSegments(plottedSeries[entryIndex], x, y).map((d, i) => (
              <path key={`estimated-${i}`} d={d} className="spectral-estimated-line" />
            ))}
            {plottedSeries[entryIndex]
              .filter((p) => p.interpolated && p.value !== null && Number.isFinite(y(p.value)))
              .map((p) => (
                <circle
                  key={`estimated-${p.channel}`}
                  cx={x(p.wavelength_um)}
                  cy={y(p.value as number)}
                  r={4.5}
                  className="spectral-estimated-marker"
                />
              ))}
          </g>
        ))}
        </g>

        {hovered && (
          <g clipPath={`url(#${chartId}-plot-clip)`}>
            <line className="spectral-crosshair" x1={tooltipLeft} x2={tooltipLeft} y1={MARGIN.top} y2={plotBottom} />
            {entries.map((e, entryIndex) => {
              const p = plottedSeries[entryIndex][hoverChannel as number];
              return p && p.value !== null && Number.isFinite(y(p.value)) ? (
                <circle
                  key={e.key}
                  cx={x(p.wavelength_um)}
                  cy={y(p.value)}
                  r={4}
                  fill={SERIES_COLORS[e.slot]}
                  className="spectral-marker"
                />
              ) : null;
            })}
          </g>
        )}

        {labels.map((l) => (
          <text key={l.key} className="spectral-direct-label" x={plotRight + 8} y={l.y} dominantBaseline="middle">
            {l.text.length > 14 ? `${l.text.slice(0, 13)}…` : l.text}
          </text>
        ))}
      </svg>
      <div className="spectral-estimate-legend" aria-label="Flux data legend">
        <span><i className="spectral-observed-key" aria-hidden="true" />Observed</span>
        {showEstimates && (
          <span><i className="spectral-interpolated-key" aria-hidden="true" />Interpolated (estimated)</span>
        )}
      </div>
      {plottedSeries.some((points) => points.some((p) => p.interpolated)) && (
        <p className="spectral-chart-note" role="note">
          Interpolated (estimated) values are chart-only estimates; the original measurements are unchanged.
        </p>
      )}
      {mode === 'log' && plottedSeries.some((points) => points.some((p) => p.interpolated && p.value !== null && p.value <= 0)) && (
        <p className="spectral-chart-note" role="note">
          Interpolated estimate at or below zero cannot be shown on a log axis; its estimated value remains in the data table.
        </p>
      )}
      {hiddenInLog > 0 && (
        <p className="spectral-chart-note" role="note">
          {hiddenInLog} value{hiddenInLog === 1 ? '' : 's'} ≤ 0 {hiddenInLog === 1 ? 'is' : 'are'} not
          drawn on the log axis (shown as gaps); see the data table.
        </p>
      )}

      {hovered && (
        <div
          className="spectral-tooltip"
          style={{
            left: Math.min(tooltipLeft + 12, width - 220),
            top: MARGIN.top,
          }}
          role="status"
        >
          <strong>
            {hovered.wavelength_um.toFixed(3)} µm · D{hovered.detector} ch {hovered.subchannel}
          </strong>
          {entries.map((e, entryIndex) => {
            const p = plottedSeries[entryIndex][hoverChannel as number];
            return (
              <div key={e.key} className="spectral-tooltip-row">
                <span className="spectral-swatch" style={{ background: SERIES_COLORS[e.slot] }} />
                <span>{e.label}</span>
                <span className="spectral-tooltip-value">
                  {formatValue(p?.value ?? null)}
                  {p?.interpolated ? ' (estimated)' : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SpectrumTable({ entries, showEstimates }: { entries: PlottedEntry[]; showEstimates: boolean }) {
  const channels = entries[0].data.points;
  const plottedSeries = useMemo(
    () => entries.map((entry) => interpolateMissingFlux(entry.data.points, estimateGap(showEstimates))),
    [entries, showEstimates],
  );
  return (
    <details className="spectral-table">
      <summary>Data table ({channels.length} channels)</summary>
      <div className="spectral-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Ch</th>
              <th scope="col">Detector</th>
              <th scope="col">λ (µm)</th>
              {entries.map((e) => (
                <th key={e.key} scope="col">
                  {e.label} ({e.data.unit})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {channels.map((c, i) => (
              <tr key={c.channel}>
                <td>{c.channel}</td>
                <td>D{c.detector}</td>
                <td>{c.wavelength_um.toFixed(3)}</td>
                {entries.map((e, entryIndex) => {
                  const p = plottedSeries[entryIndex][i];
                  return (
                    <td key={e.key}>
                      {formatValue(p?.value ?? null)}{p?.interpolated ? ' (estimated)' : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
