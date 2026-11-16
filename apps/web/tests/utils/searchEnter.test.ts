import { describe, expect, it, vi } from 'vitest';
import { runEnterLookup } from '../../src/utils/searchEnter';

const target = { ra_deg: 10.68, dec_deg: 41.27, name: 'M 31' };
const featured = { ra_deg: 148.89, dec_deg: 69.07, size_arcmin: 6, name: 'M81 field' };

function deps(overrides: Partial<Parameters<typeof runEnterLookup>[0]> = {}) {
  return {
    typed: 'M31',
    submit: vi.fn().mockResolvedValue({ kind: 'found', target }),
    currentQuery: () => 'M31',
    navigationSeq: () => 0,
    firstFeatured: null as typeof featured | null,
    goToResolved: vi.fn(),
    goToFeatured: vi.fn(),
    ...overrides,
  };
}

describe('runEnterLookup', () => {
  it('does nothing for an empty search box', async () => {
    const d = deps({ typed: '   ', firstFeatured: featured });
    await runEnterLookup(d);
    expect(d.submit).not.toHaveBeenCalled();
    expect(d.goToFeatured).not.toHaveBeenCalled();
  });

  it('moves to the resolved object', async () => {
    const d = deps();
    await runEnterLookup(d);
    expect(d.goToResolved).toHaveBeenCalledWith(target);
  });

  it('falls back to the first featured match when the name is unknown', async () => {
    const d = deps({ submit: vi.fn().mockResolvedValue({ kind: 'missed' }), firstFeatured: featured });
    await runEnterLookup(d);
    expect(d.goToFeatured).toHaveBeenCalledWith(featured);
  });

  it('ignores a lookup overtaken by newer typing', async () => {
    const d = deps({ submit: vi.fn().mockResolvedValue({ kind: 'stale' }), firstFeatured: featured });
    await runEnterLookup(d);
    expect(d.goToResolved).not.toHaveBeenCalled();
    expect(d.goToFeatured).not.toHaveBeenCalled();
  });

  it('ignores the answer if the text changed while it was resolving', async () => {
    let query = 'M31';
    const d = deps({
      currentQuery: () => query,
      submit: vi.fn(async () => {
        query = 'M3';
        return { kind: 'found' as const, target };
      }),
    });
    await runEnterLookup(d);
    expect(d.goToResolved).not.toHaveBeenCalled();
  });

  it('ignores a late answer after the user navigated somewhere else', async () => {
    let seq = 0;
    const d = deps({
      navigationSeq: () => seq,
      submit: vi.fn(async () => {
        seq += 1; // e.g. the user clicked a featured object meanwhile
        return { kind: 'found' as const, target };
      }),
    });
    await runEnterLookup(d);
    expect(d.goToResolved).not.toHaveBeenCalled();
  });
});
