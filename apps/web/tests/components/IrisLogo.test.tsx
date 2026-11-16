// @vitest-environment jsdom
/// <reference types="vite/client" />
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IRIS_LOGO_ARM, IrisLogo } from '../../src/components/IrisLogo';
import { Landing } from '../../src/components/landing/Landing';
import favicon from '../../public/favicon.svg?raw';
import indexHtml from '../../index.html?raw';

describe('IrisLogo', () => {
  afterEach(() => cleanup());

  it('draws two spiral arms around a core', () => {
    const { container } = render(<IrisLogo />);
    const arms = container.querySelectorAll('path');
    expect(arms).toHaveLength(2);
    expect([...arms].map((p) => p.getAttribute('d'))).toEqual([IRIS_LOGO_ARM, IRIS_LOGO_ARM]);
    expect(arms[1].getAttribute('transform')).toBe('rotate(180 12 12)');
    expect(container.querySelector('circle')).toBeTruthy();
  });

  it('is the mark shown in the landing header', () => {
    const { container } = render(<Landing onExplore={vi.fn()} onTour={vi.fn()} />);
    expect(container.querySelector('.landing-brand .iris-logo path')?.getAttribute('d')).toBe(IRIS_LOGO_ARM);
  });

  it('matches the browser tab icon', () => {
    expect(favicon.split(IRIS_LOGO_ARM).length - 1).toBe(2);
    expect(indexHtml).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  });
});
