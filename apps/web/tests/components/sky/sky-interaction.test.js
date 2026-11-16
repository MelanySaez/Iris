import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../../src/components/sky/SkyWorkspace.tsx', import.meta.url),
  'utf8',
);
const css = readFileSync(new URL('../../../src/styles/style.css', import.meta.url), 'utf8');

describe('Sky region interactions', () => {
  it('disables the Aladin context menu', () => {
    expect(source).toMatch(/showContextMenu:\s*false/);
    expect(source).toMatch(/onMouseDownCapture=\{\(event\) => \{[\s\S]*?event\.button !== 2[\s\S]*?event\.stopPropagation\(\)/);
    expect(source).toMatch(/onContextMenuCapture=/);
  });

  it('keeps the region interior available for map navigation', () => {
    expect(source).toMatch(/className="region-move-handle"/);
    expect(css).toMatch(/\.persistent-region \.region-body\s*\{[^}]*pointer-events:\s*none/s);
    expect(css).toMatch(/\.persistent-region \.region-move-handle\s*\{[^}]*pointer-events:\s*all/s);
  });
});
