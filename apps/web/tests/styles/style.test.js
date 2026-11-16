import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Browsers drop every rule after a CSS syntax error without failing the build,
// so a bad merge silently unstyles whole workspaces. Guard the stylesheet here.
const css = readFileSync(new URL('../../src/styles/style.css', import.meta.url), 'utf8');
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('style.css', () => {
  it('has no leftover merge conflict markers', () => {
    expect(css).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
  });

  it('closes every block it opens', () => {
    let depth = 0;
    for (const ch of code) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('keeps the Records workspace styles', () => {
    expect(code).toMatch(/\.records-workspace\s*\{/);
  });

  it('shades the Spectral Lab featured objects panel and eases its disclosure', () => {
    const rule = (selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return code.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    };
    expect(rule('.spectral-featured')).toMatch(/background:/);
    expect(rule('.spectral-featured')).toMatch(/box-shadow:/);
    expect(rule('.spectral-featured::details-content')).toMatch(/transition:[^;]*block-size/);
    expect(rule('.spectral-featured[open]::details-content')).toMatch(/block-size:\s*auto/);
    // The list also fades in on open, which works even where ::details-content does not.
    expect(rule('.spectral-featured[open] .spectral-catalog')).toMatch(/animation:\s*spectral-featured-reveal/);
    expect(code).toMatch(/@keyframes spectral-featured-reveal\s*\{/);
    expect(code).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.spectral-featured::details-content[^}]*transition:\s*none/,
    );
    expect(code).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.spectral-featured\[open\] \.spectral-catalog\s*\{\s*animation:\s*none/,
    );
  });

  it('gives the plate Provenance disclosure the same rules as Spectral Lab featured objects', () => {
    // Shared selector lists, so both disclosures always look and animate alike.
    expect(code).toMatch(/\.plate-disclosure,\s*\.spectral-featured\s*\{[^}]*background:[^}]*box-shadow:/);
    expect(code).toMatch(/\.plate-disclosure::details-content,\s*\.spectral-featured::details-content\s*\{[^}]*transition:[^;]*block-size/);
    expect(code).toMatch(/\.plate-disclosure\[open\] \.provenance-content,\s*\.spectral-featured\[open\] \.spectral-catalog\s*\{\s*animation:\s*spectral-featured-reveal/);
    expect(code).toMatch(/\.plate-disclosure\[open\] \.plate-disclosure-toggle,\s*\.spectral-featured\[open\] \.spectral-featured-toggle\s*\{\s*transform:\s*rotate\(180deg\)/);
  });
});
