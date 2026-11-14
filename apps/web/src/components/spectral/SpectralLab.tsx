import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { api, ApiError, CURATED_CATALOG_FALLBACK } from '../../api';
import {
  MAX_SPECTRA,
  SERIES_COLORS,
  computeDomain,
  lineSegments,
  linearScale,
  nearestChannel,
  nextColorSlot,
  niceTicks,
  parseCoordinates,
  spectrumKey,
} from '../../spectrum';
import type { CatalogObject, CubeSpectrumResponse } from '../../types';

interface SpectrumEntry {
  key: string;
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

function formatValue(value: number | null): string {
  if (value === null) return 'no data';
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export function SpectralLab() {
  const [catalog, setCatalog] = useState<CatalogObject[]>(CURATED_CATALOG_FALLBACK);
  const [entries, setEntries] = useState<SpectrumEntry[]>([]);
  const [raText, setRaText] = useState('');
  const [decText, setDecText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .getCatalog()
      .then((res) => {
        if (active && res.objects.length) setCatalog(res.objects);
      })
      .catch(() => {
        // Keep the curated fallback list.
      });
    return () => {
      active = false;
    };
  }, []);

  const addSpectrum = useCallback(
    (label: string, ra: number, dec: number) => {
      const key = spectrumKey(ra, dec);
      if (entries.some((e) => e.key === key)) {
        setFormError(`${label} is already in the comparison.`);
        return;
      }
      const slot = nextColorSlot(entries.map((e) => e.slot));
      if (slot === null) {
        setFormError(`Compare at most ${MAX_SPECTRA} spectra; remove one first.`);
        return;
      }
      setFormError(null);
      setEntries((prev) => [
        ...prev,
        { key, label, ra, dec, slot, visible: true, status: 'loading' },
      ]);
      api
        .getSpectrum(ra, dec)
        .then((data) => {
          setEntries((prev) =>
            prev.map((e) => (e.key === key ? { ...e, status: 'ready', data } : e)),
          );
        })
        .catch((err: unknown) => {
          const message =
            err instanceof ApiError ? (err.detail ?? err.message) : String(err);
          setEntries((prev) =>
            prev.map((e) => (e.key === key ? { ...e, status: 'error', error: message } : e)),
          );
        });
    },
    [entries],
  );

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
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, visible: !e.visible } : e)));
  const remove = (key: string) => setEntries((prev) => prev.filter((e) => e.key !== key));

  const plotted = entries.filter(
    (e): e is SpectrumEntry & { data: CubeSpectrumResponse } =>
      e.visible && e.status === 'ready' && !!e.data,
  );

  return (
    <div className="spectral-lab">
      <aside className="spectral-sidebar" aria-label="Spectra to compare">
        <section>
          <h2 className="spectral-heading">Add a spectrum</h2>
          <ul className="spectral-catalog">
            {catalog.map((obj) => {
              const taken = entries.some((e) => e.key === spectrumKey(obj.ra_deg, obj.dec_deg));
              return (
                <li key={obj.id}>
                  <button
                    type="button"
                    disabled={taken}
                    onClick={() => addSpectrum(obj.name, obj.ra_deg, obj.dec_deg)}
                    title={`RA ${obj.ra_deg.toFixed(3)}°, Dec ${obj.dec_deg.toFixed(3)}°`}
                  >
                    <span>{obj.name}</span>
                    <span className="spectral-catalog-type">{taken ? 'added' : obj.type}</span>
                  </button>
                </li>
              );
            })}
          </ul>
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

        <section>
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
                    {e.status === 'loading' && 'Reading cube tile…'}
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
        <SpectrumChart entries={plotted} />
        {plotted.length > 0 && <SpectrumTable entries={plotted} />}
      </main>
    </div>
  );
}

interface PlottedEntry extends SpectrumEntry {
  data: CubeSpectrumResponse;
}

function SpectrumChart({ entries }: { entries: PlottedEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hoverChannel, setHoverChannel] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(320, Math.floor(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const domain = useMemo(() => computeDomain(entries.map((e) => e.data.points)), [entries]);
  const unit = entries[0]?.data.unit ?? 'MJy/sr';

  if (!domain) {
    return (
      <div ref={containerRef} className="spectral-chart spectral-chart-empty">
        <p className="spectral-muted">No spectrum plotted yet.</p>
      </div>
    );
  }

  const plotRight = width - MARGIN.right;
  const plotBottom = CHART_HEIGHT - MARGIN.bottom;
  const x = linearScale(domain.x, [MARGIN.left, plotRight]);
  const y = linearScale(domain.y, [plotBottom, MARGIN.top]);
  const xTicks = niceTicks(domain.x[0], domain.x[1], Math.max(4, Math.floor(width / 110)));
  const yTicks = niceTicks(domain.y[0], domain.y[1], 5);
  const reference = entries[0].data.points;

  const handleMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    if (px < MARGIN.left || px > plotRight) {
      setHoverChannel(null);
      return;
    }
    const wavelength = domain.x[0] + ((px - MARGIN.left) / (plotRight - MARGIN.left)) * (domain.x[1] - domain.x[0]);
    setHoverChannel(nearestChannel(reference, wavelength));
  };

  // Direct labels at the last available point, nudged apart vertically.
  const labels = entries
    .map((e) => {
      const last = [...e.data.points].reverse().find((p) => p.value !== null);
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
    <div ref={containerRef} className="spectral-chart">
      <svg
        width={width}
        height={CHART_HEIGHT}
        role="img"
        aria-label={`Spectra of ${entries.map((e) => e.label).join(', ')}: wavelength in microns against surface brightness in ${unit}`}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverChannel(null)}
      >
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

        {entries.map((e) => (
          <g key={e.key} stroke={SERIES_COLORS[e.slot]}>
            {lineSegments(e.data.points, x, y).map((d, i) => (
              <path key={i} d={d} className="spectral-line" />
            ))}
          </g>
        ))}

        {hovered && (
          <g>
            <line className="spectral-crosshair" x1={tooltipLeft} x2={tooltipLeft} y1={MARGIN.top} y2={plotBottom} />
            {entries.map((e) => {
              const p = e.data.points[hoverChannel as number];
              return p && p.value !== null ? (
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
          {entries.map((e) => {
            const p = e.data.points[hoverChannel as number];
            return (
              <div key={e.key} className="spectral-tooltip-row">
                <span className="spectral-swatch" style={{ background: SERIES_COLORS[e.slot] }} />
                <span>{e.label}</span>
                <span className="spectral-tooltip-value">
                  {formatValue(p?.value ?? null)}
                  {p && p.value !== null ? ` · ${p.nhits} hits` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SpectrumTable({ entries }: { entries: PlottedEntry[] }) {
  const channels = entries[0].data.points;
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
                {entries.map((e) => (
                  <td key={e.key}>{formatValue(e.data.points[i]?.value ?? null)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
