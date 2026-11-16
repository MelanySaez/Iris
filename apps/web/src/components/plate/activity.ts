import type { JobActivity } from '../../types/types';

export interface ActivityView {
  title: string;
  detail: string;
  /** 0..1 share of the step's budget, or null when it cannot be measured. */
  fraction: number | null;
  /** The step ran past its budget. */
  overdue: boolean;
}

const seconds = (value: number) => `${Math.round(value)} s`;

/**
 * Human description of the worker's current step.
 *
 * ``secondsSinceSnapshot`` advances the server-measured elapsed time between
 * polls, so the UI keeps moving without trusting the client clock.
 */
export function describeActivity(
  activity: JobActivity | null | undefined,
  secondsSinceSnapshot: number,
): ActivityView | null {
  if (!activity) return null;
  const elapsed = Math.max(0, (activity.elapsed_seconds ?? 0) + secondsSinceSnapshot);
  const budget = activity.budget_seconds ?? null;
  const provider = activity.provider ?? 'Provider';

  switch (activity.kind) {
    case 'discovery_attempt': {
      const overdue = budget !== null && elapsed > budget;
      return {
        title: `${provider} · attempt ${activity.attempt} of ${activity.max_attempts}`,
        detail: budget === null
          ? `${seconds(elapsed)} elapsed`
          : overdue
            ? `${seconds(elapsed)} · over the ${seconds(budget)} limit, stopping this attempt`
            : `${seconds(elapsed)} of ${seconds(budget)} max`,
        fraction: budget ? Math.min(1, elapsed / budget) : null,
        overdue,
      };
    }
    case 'retry_wait': {
      const wait = budget ?? 0;
      return {
        title: `Retrying ${provider} · attempt ${(activity.attempt ?? 0) + 1} of ${activity.max_attempts}`,
        detail: `next attempt in ${seconds(Math.max(0, Math.ceil(wait - elapsed)))}`,
        fraction: wait > 0 ? Math.min(1, elapsed / wait) : null,
        overdue: false,
      };
    }
    case 'fallback':
      return { title: `${provider} · checking`, detail: `${seconds(elapsed)} elapsed`, fraction: null, overdue: false };
    case 'cube_read': {
      const total = activity.tiles_total ?? null;
      return {
        title: `Sky tiles for channel ${activity.channel}`,
        detail: `${total ? `${activity.tiles_done ?? 0} of ${total} sky tiles` : 'locating sky tiles'} · ${seconds(elapsed)}`,
        fraction: total ? Math.min(1, (activity.tiles_done ?? 0) / total) : null,
        overdue: false,
      };
    }
    default:
      return null;
  }
}
