import { useEffect, useRef, useState } from 'react';
import { PlanetIcon } from '../SkyIcons';
import { prefersReducedMotion, Starfield, type StarfieldHandle } from './Starfield';

/** Upper bound for the jump, so the button always leads into the viewer. */
const WARP_TIMEOUT_MS = 1400;
/** Cross-fade from the black landing to the viewer underneath (matches the CSS). */
const FADE_OUT_MS = 650;

interface LandingProps {
  /** Opens the sky viewer. */
  onExplore: () => void;
  /** The viewer is already showing underneath: fade the landing away. */
  leaving?: boolean;
  /** Called once the fade has finished, so the landing can unmount. */
  onExited?: () => void;
}

const CONTEXT = [
  {
    question: 'What is SPHEREx?',
    answer:
      'A NASA space telescope that maps the entire sky in infrared light, splitting it into 102 spectral channels between 0.75 and 5 µm.',
    link: { label: 'About the mission', href: 'https://science.nasa.gov/mission/spherex/' },
  },
  {
    question: 'Where does the data come from?',
    answer:
      'SPHEREx data products are publicly archived and distributed by NASA/IPAC’s Infrared Science Archive (IRSA). Iris reads them from there.',
    link: { label: 'SPHEREx at IRSA', href: 'https://irsa.ipac.caltech.edu/Missions/spherex.html' },
  },
  {
    question: 'What can I explore?',
    answer:
      'Search an object by name, move across the whole sky, switch between infrared channels, select a region and compare quick-look spectra.',
    link: null,
  },
  {
    question: 'What are astronomical catalogs?',
    answer:
      'Lists of known celestial sources with their positions and measured properties. Iris can overlay several of them on the map.',
    link: {
      label: 'SPHEREx data documentation',
      href: 'https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/overview.html',
    },
  },
] as const;

const RESOURCES = [
  { label: 'SPHEREx mission', note: 'NASA', href: 'https://science.nasa.gov/mission/spherex/' },
  { label: 'SPHEREx at IRSA', note: 'Data and tools', href: 'https://irsa.ipac.caltech.edu/Missions/spherex.html' },
  {
    label: 'Data documentation',
    note: 'How to read the products',
    href: 'https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/overview.html',
  },
  { label: 'SPHEREx at Caltech', note: 'Science team', href: 'https://spherex.caltech.edu/' },
] as const;

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

/**
 * Entry page: one full-screen sky with the two ways in, then a short block of
 * context and the official sources. Scrolling fades the hero and drifts the
 * stars, written to a CSS variable so React does not re-render on scroll.
 */
export function Landing({ onExplore, leaving = false, onExited }: LandingProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const starsRef = useRef<StarfieldHandle>(null);
  const [warping, setWarping] = useState(false);

  useEffect(() => {
    if (!leaving) return undefined;
    const timer = setTimeout(() => onExited?.(), prefersReducedMotion() ? 0 : FADE_OUT_MS);
    return () => clearTimeout(timer);
  }, [leaving, onExited]);

  // Focal moment: the stars jump towards the viewer, then the viewer opens.
  const enterSky = () => {
    if (warping) return;
    setWarping(true);
    const jump = starsRef.current?.warp() ?? Promise.resolve();
    const limit = new Promise<void>((resolve) => setTimeout(resolve, WARP_TIMEOUT_MS));
    void Promise.race([jump, limit]).then(onExplore);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const progress = Math.min(1, root.scrollTop / Math.max(1, root.clientHeight));
        root.style.setProperty('--landing-scroll', progress.toFixed(3));
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('scroll', onScroll);
    };
  }, []);

  const scrollTo = (id: string) => {
    rootRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div
      className={`landing${warping ? ' landing-warping' : ''}${leaving ? ' landing-leaving' : ''}`}
      ref={rootRef}
      aria-hidden={leaving || undefined}
    >
      <Starfield ref={starsRef} />

      <header className="landing-nav">
        <span className="landing-brand">
          <span className="brand-logo">
            <PlanetIcon />
          </span>
          <strong>Iris</strong>
        </span>
        <nav aria-label="Landing">
          <button type="button" onClick={() => scrollTo('landing-context')}>
            About
          </button>
          <button type="button" onClick={() => scrollTo('landing-resources')}>
            Resources
          </button>
        </nav>
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="landing-eyebrow">Built on public NASA SPHEREx data</p>
        <h1 id="landing-title">Explore the invisible universe.</h1>
        <p className="landing-lede">
          See the whole sky through infrared light. Find an object, move across 102 spectral
          channels and look at the sky the way SPHEREx sees it.
        </p>
        <div className="landing-actions">
          <button type="button" className="landing-cta" onClick={enterSky}>
            Explore the Sky
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 12 12 4M6 4h6v6" />
            </svg>
          </button>
          <button type="button" className="landing-secondary" disabled>
            Guided Tour <span className="landing-soon">Coming soon</span>
          </button>
        </div>
        <div className="landing-hero-foot">
          <span>SPHEREx · 102 spectral channels · 0.75–5 µm</span>
          <button type="button" onClick={() => scrollTo('landing-context')}>
            Scroll to discover
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M4 9l4 4 4-4" />
            </svg>
          </button>
        </div>
      </section>

      <section id="landing-context" className="landing-context" aria-labelledby="landing-context-title">
        <h2 id="landing-context-title">A little context before you explore</h2>
        <div className="landing-context-grid">
          {CONTEXT.map((item, index) => (
            <article key={item.question}>
              <span className="landing-index">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <h3>{item.question}</h3>
                <p>{item.answer}</p>
                {item.link && (
                  <a className="landing-link" href={item.link.href} {...external}>
                    {item.link.label}
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 12 12 4M6 4h6v6" />
                    </svg>
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
        <button type="button" className="landing-cta landing-cta-end" onClick={enterSky}>
          Open the viewer
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 12 12 4M6 4h6v6" />
          </svg>
        </button>
      </section>

      <footer id="landing-resources" className="landing-footer">
        <h2>Official resources</h2>
        <ul>
          {RESOURCES.map((resource) => (
            <li key={resource.href}>
              <a href={resource.href} {...external}>
                {resource.label}
              </a>
              <span>{resource.note}</span>
            </li>
          ))}
        </ul>
        <p className="landing-disclaimer">
          Iris is an independent exploration interface built on publicly available astronomical data
          for NASA Space Apps 2026. Not an official NASA application.
        </p>
      </footer>
    </div>
  );
}
