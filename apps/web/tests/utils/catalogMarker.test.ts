// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogMarker } from '../../src/utils/catalogMarker';

afterEach(() => vi.restoreAllMocks());

describe('catalog marker contrast', () => {
  it('draws a dark backing, bright outline and filled center at the requested size', () => {
    const context = {
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
      fillStyle: '', strokeStyle: '', lineWidth: 0,
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const marker = createCatalogMarker('#b8e66e', 12, 'circle');

    expect(marker.width).toBe(12);
    expect(marker.height).toBe(12);
    expect(context.fill).toHaveBeenCalledTimes(2);
    expect(context.stroke).toHaveBeenCalledOnce();
    expect(context.strokeStyle).toBe('#b8e66e');
    expect(context.fillStyle).toBe('#b8e66e');
  });
});
