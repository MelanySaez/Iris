import { describe, expect, it } from 'vitest';
import {
  ensureServiceWorkerControl,
  SW_CONTROL_RELOAD_KEY,
  type ControlEnvironment,
} from '../../src/core/serviceWorkerControl';

interface FakeWorld {
  env: ControlEnvironment;
  listenerCount: () => number;
  posted: unknown[];
  reloads: number;
  store: Map<string, string>;
  worker: { postMessage: (message: unknown) => void };
}

function makeWorld(options: { controlled?: boolean; claimWorks?: boolean; storage?: 'ok' | 'blocked' } = {}): FakeWorld {
  const listeners = new Set<() => void>();
  const store = new Map<string, string>();
  const world: FakeWorld = {
    listenerCount: () => listeners.size,
    posted: [],
    reloads: 0,
    store,
    worker: {
      postMessage: (message) => {
        world.posted.push(message);
        if (options.claimWorks && (message as { type?: string })?.type === 'CLAIM') {
          container.controller = {} as ServiceWorker;
          // Synchronous dispatch: a listener attached after postMessage would miss it.
          for (const listener of [...listeners]) listener();
        }
      },
    },
    env: undefined as unknown as ControlEnvironment,
  };
  const container = {
    controller: (options.controlled ? {} : null) as ServiceWorker | null,
    addEventListener: (_type: 'controllerchange', listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: 'controllerchange', listener: () => void) => listeners.delete(listener),
  };
  const storage = options.storage === 'blocked'
    ? {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
        removeItem: () => { throw new Error('blocked'); },
      }
    : {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
      };
  world.env = {
    serviceWorker: container,
    storage,
    reload: () => { world.reloads += 1; },
  };
  return world;
}

describe('ensureServiceWorkerControl', () => {
  it('keeps a page that is already controlled as it is', async () => {
    const world = makeWorld({ controlled: true });
    world.store.set(SW_CONTROL_RELOAD_KEY, '1');

    await expect(ensureServiceWorkerControl(world.worker, world.env, 20)).resolves.toBe('controlled');
    expect(world.posted).toEqual([]);
    expect(world.reloads).toBe(0);
    expect(world.store.has(SW_CONTROL_RELOAD_KEY)).toBe(false);
  });

  it('asks the active worker to claim a hard-reloaded page and waits for controllerchange', async () => {
    const world = makeWorld({ controlled: false, claimWorks: true });
    world.store.set(SW_CONTROL_RELOAD_KEY, '1');

    // A long timeout makes the test hang if the listener is attached after posting CLAIM.
    await expect(ensureServiceWorkerControl(world.worker, world.env, 60_000)).resolves.toBe('controlled');
    expect(world.posted).toEqual([{ type: 'CLAIM' }]);
    expect(world.reloads).toBe(0);
    expect(world.store.has(SW_CONTROL_RELOAD_KEY)).toBe(false);
    expect(world.listenerCount()).toBe(0);
  });

  it('reloads once when the claim does not take control', async () => {
    const world = makeWorld({ controlled: false, claimWorks: false });

    await expect(ensureServiceWorkerControl(world.worker, world.env, 20)).resolves.toBe('reloading');
    expect(world.posted).toEqual([{ type: 'CLAIM' }]);
    expect(world.reloads).toBe(1);
    expect(world.store.get(SW_CONTROL_RELOAD_KEY)).toBe('1');
    expect(world.listenerCount()).toBe(0);
  });

  it('does not reload again right after its own reload, so it can never loop', async () => {
    const world = makeWorld({ controlled: false, claimWorks: false });
    world.store.set(SW_CONTROL_RELOAD_KEY, '1');

    await expect(ensureServiceWorkerControl(world.worker, world.env, 20)).resolves.toBe('uncontrolled');
    expect(world.reloads).toBe(0);
    expect(world.store.has(SW_CONTROL_RELOAD_KEY)).toBe(false);
  });

  it('does not reload when sessionStorage is unavailable', async () => {
    const world = makeWorld({ controlled: false, claimWorks: false, storage: 'blocked' });

    await expect(ensureServiceWorkerControl(world.worker, world.env, 20)).resolves.toBe('uncontrolled');
    expect(world.reloads).toBe(0);
  });
});
