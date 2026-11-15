// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('aladin-lite', () => ({ default: {} }));
import { SkyWorkspace } from './SkyWorkspace';

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
});
