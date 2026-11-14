import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Browsers drop every rule after a CSS syntax error without failing the build,
// so a bad merge silently unstyles whole workspaces. Guard the stylesheet here.
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
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
});
