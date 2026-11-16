import { useEffect, useState } from 'react';

export type AppRoute =
  | { type: 'landing' }
  | { type: 'sky' }
  | { type: 'records' }
  /** jobId null: Plate without a job, where the user can open their own FITS. */
  | { type: 'plate'; jobId: string | null }
  | { type: 'spectral' };

export function parseHash(hash: string): AppRoute {
  const clean = hash.replace(/^#\/?/, '');
  if (clean === '') {
    return { type: 'landing' };
  }
  if (clean === 'spectral') {
    return { type: 'spectral' };
  }
  if (clean === 'records') {
    return { type: 'records' };
  }
  if (clean === 'plate' || clean.startsWith('plate/')) {
    const jobId = clean.slice('plate'.length).replace(/^\//, '').trim();
    return { type: 'plate', jobId: jobId ? decodeURIComponent(jobId) : null };
  }
  return { type: 'sky' };
}

export function routeToHash(route: AppRoute): string {
  if (route.type === 'landing') {
    return '#/';
  }
  if (route.type === 'plate') {
    return route.jobId ? `#/plate/${encodeURIComponent(route.jobId)}` : '#/plate';
  }
  if (route.type === 'spectral') {
    return '#/spectral';
  }
  if (route.type === 'records') {
    return '#/records';
  }
  return '#/sky';
}

export function navigateTo(route: AppRoute | string): void {
  const targetHash = typeof route === 'string' ? route : routeToHash(route);
  if (window.location.hash !== targetHash) {
    window.location.hash = targetHash;
  }
}

export function useRoute(): {
  route: AppRoute;
  navigate: (route: AppRoute | string) => void;
} {
  const [route, setRoute] = useState<AppRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseHash(window.location.hash));
    };

    window.addEventListener('hashchange', handleHashChange);
    window.addEventListener('popstate', handleHashChange);

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      window.removeEventListener('popstate', handleHashChange);
    };
  }, []);

  return { route, navigate: navigateTo };
}
