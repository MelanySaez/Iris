/**
 * Makes sure the HiPS adapter service worker controls the page before the sky
 * viewer starts requesting virtual tiles.
 *
 * A hard reload (Ctrl+Shift+R) loads the page without its service worker, and an
 * already active worker never re-runs its activate-time `clients.claim()`. The
 * page therefore asks the worker to claim it. If that still fails, it reloads
 * once; a sessionStorage marker guarantees it never reloads in a loop.
 */

export const SW_CONTROL_RELOAD_KEY = 'planetx_sw_control_reload';

export type ControlOutcome = 'controlled' | 'reloading' | 'uncontrolled';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ControlEnvironment {
  serviceWorker: {
    readonly controller: ServiceWorker | null;
    addEventListener(type: 'controllerchange', listener: () => void): void;
    removeEventListener(type: 'controllerchange', listener: () => void): void;
  };
  storage: StorageLike | null;
  reload: () => void;
}

function browserEnvironment(): ControlEnvironment {
  let storage: StorageLike | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    // Storage access can throw when blocked by browser settings.
  }
  return {
    serviceWorker: navigator.serviceWorker,
    storage,
    reload: () => window.location.reload(),
  };
}

function waitForControllerChange(env: ControlEnvironment, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      env.serviceWorker.removeEventListener('controllerchange', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    env.serviceWorker.addEventListener('controllerchange', done);
  });
}

function clearReloadMarker(env: ControlEnvironment): void {
  try {
    env.storage?.removeItem(SW_CONTROL_RELOAD_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/** Returns true only when this is the first reload attempt and it was recorded. */
function markReloadAttempt(env: ControlEnvironment): boolean {
  try {
    if (!env.storage || env.storage.getItem(SW_CONTROL_RELOAD_KEY)) return false;
    env.storage.setItem(SW_CONTROL_RELOAD_KEY, '1');
    return true;
  } catch {
    // Without storage the reload cannot be guarded, so it is never attempted.
    return false;
  }
}

export async function ensureServiceWorkerControl(
  worker: Pick<ServiceWorker, 'postMessage'> | null,
  env: ControlEnvironment = browserEnvironment(),
  timeoutMs = 2500,
): Promise<ControlOutcome> {
  if (env.serviceWorker.controller) {
    clearReloadMarker(env);
    return 'controlled';
  }

  // Listen before asking, so a fast controllerchange cannot be missed.
  const changed = waitForControllerChange(env, timeoutMs);
  worker?.postMessage({ type: 'CLAIM' });
  await changed;

  if (env.serviceWorker.controller) {
    clearReloadMarker(env);
    return 'controlled';
  }
  if (markReloadAttempt(env)) {
    env.reload();
    return 'reloading';
  }
  clearReloadMarker(env);
  return 'uncontrolled';
}
