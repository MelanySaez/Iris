/**
 * Cookie consent for saved selections (Records).
 *
 * There is no login: the backend keeps each browser's records under an
 * HttpOnly owner cookie it issues when cookies are accepted. The choice itself
 * lives in the readable `iris_consent` cookie (also set by the backend), which
 * tells the app whether to show the cookie bar.
 */

export type ConsentLevel = 'necessary' | 'all' | 'none';

export const CONSENT_COOKIE = 'iris_consent';

/** Most job ids sent in one recovery request (the backend's limit). */
export const MAX_CLAIMED_JOBS = 100;

const LEVELS: readonly ConsentLevel[] = ['necessary', 'all', 'none'];

/** The stored choice, or null when the visitor has not chosen yet. */
export function readConsent(cookies: string = typeof document === 'undefined' ? '' : document.cookie): ConsentLevel | null {
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== CONSENT_COOKIE) continue;
    const value = rest.join('=') as ConsentLevel;
    return LEVELS.includes(value) ? value : null;
  }
  return null;
}

/** The records cookie counts as necessary: both acceptances save records. */
export function recordsEnabled(level: ConsentLevel | null): boolean {
  return level === 'necessary' || level === 'all';
}
