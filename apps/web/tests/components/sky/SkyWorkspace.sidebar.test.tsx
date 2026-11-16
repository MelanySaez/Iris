// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('aladin-lite', () => ({ default: {} }));
import { SkyWorkspace } from '../../../src/components/sky/SkyWorkspace';
import { TopBar } from '../../../src/components/TopBar';
import { AllSkyIcon } from '../../../src/components/SkyIcons';
import { HIPS_CATALOG_PROVIDERS, LOCAL_CATALOG_STYLE } from '../../../src/services/catalogs';
import { TOCATS_CATALOGS } from '../../../src/api/tocats';

describe('Sky workspace sidebar', () => {
  it('presents position, object discovery, then map layers', () => {
    sessionStorage.setItem('planetx_recent_selections', JSON.stringify([{
      id: 'recent-field', name: 'Recent field', ra_deg: 12, dec_deg: 3,
      size_arcmin: 6, timestamp: 1,
    }]));
    document.body.innerHTML = renderToStaticMarkup(
      <SkyWorkspace
        activeJob={null}
        onStartJob={async () => {}}
        onOpenPlate={() => {}}
        onViewSpectrum={() => {}}
        onRetryJob={() => {}}
      />,
    );

    const rail = document.querySelector('.sky-rail');
    expect(rail).not.toBeNull();
    const sections = Array.from(rail!.querySelectorAll(':scope > section'));
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([
      'Choose a region',
      'Find objects',
      'Map layers',
    ]);

    expect(sections[0].querySelectorAll('.coord-grid input')).toHaveLength(3);
    expect(sections[0].textContent).toContain('Recent field');
    expect(sections[1].textContent).toContain('featured objects available offline');
    expect(sections[2].querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
    expect(Array.from(sections[2].querySelectorAll('.catalog-group-label'), (node) => node.textContent)).toEqual([
      'Enabled layers', 'Available layers',
    ]);
    expect(sections[2].querySelector('.catalog-layer-entry')?.textContent).toContain('Featured objects');
    sessionStorage.clear();
  });

  it('uses icons and places zoom out before zoom in', () => {
    document.body.innerHTML = renderToStaticMarkup(
      <SkyWorkspace
        activeJob={null}
        onStartJob={async () => {}}
        onOpenPlate={() => {}}
        onViewSpectrum={() => {}}
        onRetryJob={() => {}}
      />,
    );

    const controls = document.querySelector('[aria-label="Map controls"]');
    expect(controls?.querySelector('[title="Pan map"] svg')).not.toBeNull();
    expect(controls?.querySelector('[title="Zoom out to the full sky"] svg')).not.toBeNull();
    expect(Array.from(controls?.querySelectorAll('[aria-label="Zoom controls"] button') ?? [],
      (button) => [button.getAttribute('title'), button.getAttribute('aria-label')])).toEqual([
      ['Zoom out', 'Zoom out'], ['Zoom in', 'Zoom in'], ['Zoom out to the full sky', 'Zoom out to the full sky'],
    ]);
  });

  it('draws the full-sky button as four outward arrows, not a globe', () => {
    document.body.innerHTML = renderToStaticMarkup(<AllSkyIcon />);
    const svg = document.querySelector('svg') as SVGElement;
    expect(svg.querySelector('circle')).toBeNull();
    const arrows = Array.from(svg.querySelectorAll('path'), (p) => p.getAttribute('d')).join(' ');
    for (const corner of ['M4 4', 'M20 4', 'M4 20', 'M20 20']) expect(arrows).toContain(corner);
  });

  it('shows a vector planet rather than an emoji in the brand', () => {
    document.body.innerHTML = renderToStaticMarkup(
      <TopBar currentRoute={{ type: 'sky' }} activeJobId={null} onNavigate={() => {}} />,
    );
    expect(document.querySelector('.brand-logo svg')).not.toBeNull();
  });

  it('uses readable marker sizes for the sky catalogs', () => {
    expect(LOCAL_CATALOG_STYLE.sourceSize).toBeGreaterThanOrEqual(16);
    expect(HIPS_CATALOG_PROVIDERS.simbad.sourceSize).toBeGreaterThanOrEqual(8);
    expect(TOCATS_CATALOGS.gaia.sourceSize).toBeGreaterThanOrEqual(12);
    expect(TOCATS_CATALOGS.catwise.sourceSize).toBeGreaterThanOrEqual(12);
    expect(TOCATS_CATALOGS.catwise.shape).toBe('rhomb');
  });
  it('carries the anchors the guided tour points at', () => {
    document.body.innerHTML = renderToStaticMarkup(
      <SkyWorkspace
        activeJob={null}
        onStartJob={async () => {}}
        onOpenPlate={() => {}}
        onViewSpectrum={() => {}}
        onRetryJob={() => {}}
      />,
    );
    for (const anchor of ['search', 'map', 'channels', 'region-tool']) {
      expect(document.querySelectorAll(`[data-tour="${anchor}"]`)).toHaveLength(1);
    }
    for (const target of ['map', 'channel', 'color-mode']) {
      expect(document.querySelectorAll(`[data-assistant-target="${target}"]`)).toHaveLength(1);
    }
  });
});
