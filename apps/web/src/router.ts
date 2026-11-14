import { useEffect, useState } from 'react';

export type AppRoute =
  | { type: 'sky' }
  | { type: 'records' }
  | { type: 'plate'; jobId: string }
  | { type: 'spectral' };

export function parseHash(hash: string): AppRoute {
  const clean = hash.replace(/^#\/?/, '');
  if (clean === 'spectral') {
    return { type: 'spectral' };
  }
  if (clean === 'records') {
    return { type: 'records' };
  }
  if (clean.startsWith('plate/')) {
    const jobId = clean.slice('plate/'.length).trim();
    if (jobId) {
      return { type: 'plate', jobId: decodeURIComponent(jobId) };
    }
  }
  return { type: 'sky' };
}

export function routeToHash(route: AppRoute): string {
  if (route.type === 'plate') {
    return `#/plate/${encodeURIComponent(route.jobId)}`;
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

    // Ensure initial hash is set to #/sky if blank
    if (!window.location.hash || window.location.hash === '#/' || window.location.hash === '#') {
      window.location.hash = '#/sky';
    }

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      window.removeEventListener('popstate', handleHashChange);
    };
  }, []);

  return { route, navigate: navigateTo };
}
