/** What a name lookup triggered by Enter came back with. */
export type SubmitResult =
  | { kind: 'found'; target: { ra_deg: number; dec_deg: number; name: string } }
  | { kind: 'missed' }
  /** Overtaken by newer typing or another Enter: must not move the map. */
  | { kind: 'stale' };

interface FeaturedTarget {
  ra_deg: number;
  dec_deg: number;
  size_arcmin: number;
  name: string;
}

interface EnterLookupDeps {
  /** Search box text when Enter was pressed. */
  typed: string;
  submit: () => Promise<SubmitResult>;
  /** Search box text now (read after the lookup finishes). */
  currentQuery: () => string;
  /** Increments whenever the map is sent somewhere (click, region, lookup). */
  navigationSeq: () => number;
  firstFeatured: FeaturedTarget | null;
  goToResolved: (target: { ra_deg: number; dec_deg: number; name: string }) => void;
  goToFeatured: (featured: FeaturedTarget) => void;
}

/**
 * Enter in Search objects: take the first suggestion. The resolved object wins;
 * if the name is unknown, the first featured match is used. Nothing happens for
 * an empty box, and an answer is dropped if the user typed something else or
 * navigated elsewhere while it was resolving.
 */
export async function runEnterLookup(deps: EnterLookupDeps): Promise<void> {
  const typed = deps.typed.trim();
  if (!typed) return;
  const seqAtEnter = deps.navigationSeq();
  const result = await deps.submit();
  const stillCurrent =
    deps.currentQuery().trim() === typed && deps.navigationSeq() === seqAtEnter;
  if (!stillCurrent || result.kind === 'stale') return;
  if (result.kind === 'found') {
    deps.goToResolved(result.target);
  } else if (deps.firstFeatured) {
    deps.goToFeatured(deps.firstFeatured);
  }
}
