import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const adapterSource = readFileSync(new URL('../public/hips-adapter.js', import.meta.url), 'utf8');

function makeWorker(fetchImpl = fetch) {
  const listeners = new Map();
  const telemetry = [];
  const worker = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: (message) => telemetry.push(message) }],
    },
    location: { origin: 'https://app.example.test' },
  };
  runInNewContext(adapterSource, { self: worker, URL, Response, Headers, fetch: fetchImpl });
  return { listeners, telemetry };
}

function syncProperties(listener) {
  const messages = [];
  listener({
    data: { type: 'SYNC_PROPERTIES', properties: 'dataproduct_type=image\nhips_service_url=https://app.example.test/spherex-virtual-hips/channel/0\n' },
    ports: [{ postMessage: (message) => messages.push(message) }],
  });
  return messages;
}

async function request(listener, channel, path) {
  let responsePromise;
  listener({
    request: {
      url: `https://app.example.test/spherex-virtual-hips/channel/${channel}/${path}`,
      signal: undefined,
    },
    respondWith: (response) => { responsePromise = response; },
  });
  return responsePromise;
}

describe('SPHEREx HiPS service worker adapter', () => {
  it('acknowledges metadata setup and serves channel-specific properties', async () => {
    const { listeners } = makeWorker();
    expect(syncProperties(listeners.get('message'))).toEqual([{ ok: true }]);

    const channel0 = await request(listeners.get('fetch'), 0, 'properties');
    const channel62 = await request(listeners.get('fetch'), 62, 'properties');
    expect((await channel0.text())).toContain('hips_service_url=https://app.example.test/spherex-virtual-hips/channel/0');
    expect((await channel62.text())).toContain('hips_service_url=https://app.example.test/spherex-virtual-hips/channel/62');
  });

  it('maps a channel-62 virtual tile to the authentic suffixed IRSA path after channel 0', async () => {
    const remoteUrls = [];
    const fetchImpl = async (url) => {
      remoteUrls.push(url);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' },
      });
    };
    const { listeners, telemetry } = makeWorker(fetchImpl);
    syncProperties(listeners.get('message'));

    const channel0 = await request(listeners.get('fetch'), 0, 'Norder0/Dir0/Npix0.png');
    await channel0.arrayBuffer();
    const channel62 = await request(listeners.get('fetch'), 62, 'Norder0/Dir0/Npix0.png');
    await channel62.arrayBuffer();

    expect(remoteUrls).toEqual([
      'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/Norder0/Dir0/Npix0.png',
      'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/Norder0/Dir0/Npix0_62.png',
    ]);
    expect(telemetry.map(({ channel }) => channel)).toEqual([0, 62]);
  });
});

it('reuses cached tiles and warms only valid adjacent channels', async () => {
  const entries = new Map();
  const urls = [];
  const listeners = new Map();
  const cache = {
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, response) => entries.set(key, response.clone()),
    keys: async () => [...entries.keys()],
    delete: async (key) => entries.delete(key),
  };
  const worker = { addEventListener: (type, cb) => listeners.set(type, cb), location: { origin: 'https://app.example.test' }, clients: { matchAll: async () => [] } };
  runInNewContext(adapterSource, { self: worker, URL, Response, Headers, AbortController, caches: { open: async () => cache }, fetch: async (url) => {
    urls.push(url); return new Response('tile', { headers: { 'content-type': 'image/png' } });
  } });
  await request(listeners.get('fetch'), 49, 'Norder3/Dir0/Npix7.png');
  await request(listeners.get('fetch'), 49, 'Norder3/Dir0/Npix7.png');
  expect(urls).toHaveLength(1);
  let warming;
  listeners.get('message')({ data: { type: 'WARM_NEIGHBOURS', channel: 49 }, waitUntil: (promise) => { warming = promise; } });
  await warming;
  expect(urls.slice(1)).toEqual([
    'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/Norder3/Dir0/Npix7_48.png',
    'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/Norder3/Dir0/Npix7_52.png',
  ]);
  await request(listeners.get('fetch'), 52, 'Norder3/Dir0/Npix7.png');
  expect(urls).toHaveLength(3);
});

it('keeps serving properties after the browser restarts an idle service worker', async () => {
  // Cache Storage outlives the worker; its in-memory variables do not.
  const stores = new Map();
  const caches = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        match: async (key) => entries.get(String(key))?.clone(),
        put: async (key, response) => { entries.set(String(key), response.clone()); },
        keys: async () => [...entries.keys()],
        delete: async (key) => entries.delete(String(key)),
      };
    },
  };
  const boot = () => {
    const listeners = new Map();
    const worker = { addEventListener: (type, cb) => listeners.set(type, cb), location: { origin: 'https://app.example.test' }, clients: { matchAll: async () => [] } };
    runInNewContext(adapterSource, { self: worker, URL, Response, Headers, AbortController, caches, fetch });
    return listeners;
  };

  const first = boot();
  let persisted;
  const acks = [];
  first.get('message')({
    data: { type: 'SYNC_PROPERTIES', properties: 'dataproduct_type=image\nhips_service_url=https://app.example.test/spherex-virtual-hips/channel/0\n' },
    ports: [{ postMessage: (message) => acks.push(message) }],
    waitUntil: (promise) => { persisted = promise; },
  });
  await persisted;
  expect(acks).toEqual([{ ok: true }]);

  const restarted = boot(); // idle stop + restart: propertiesText is empty again
  const response = await request(restarted.get('fetch'), 46, 'properties');
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('hips_service_url=https://app.example.test/spherex-virtual-hips/channel/46');
});

it('still reports 503 when properties were never synced', async () => {
  const listeners = new Map();
  const worker = { addEventListener: (type, cb) => listeners.set(type, cb), location: { origin: 'https://app.example.test' }, clients: { matchAll: async () => [] } };
  const empty = { open: async () => ({ match: async () => undefined, put: async () => {}, keys: async () => [], delete: async () => false }) };
  runInNewContext(adapterSource, { self: worker, URL, Response, Headers, AbortController, caches: empty, fetch });
  const response = await request(listeners.get('fetch'), 46, 'properties');
  expect(response.status).toBe(503);
});

function controllableCaches() {
  const entries = new Map();
  const gates = { match: null, put: [], onMatchWaiting: null };
  const cache = {
    match: async (key) => {
      const snapshot = entries.get(String(key))?.clone(); // value at request time
      if (gates.match) {
        gates.onMatchWaiting?.();
        await gates.match;
      }
      return snapshot;
    },
    put: async (key, response) => {
      const text = await response.clone().text();
      const gate = gates.put.shift();
      if (gate) await gate(text);
      entries.set(String(key), new Response(text));
    },
    keys: async () => [...entries.keys()],
    delete: async (key) => entries.delete(String(key)),
  };
  return { caches: { open: async () => cache }, entries, gates };
}

function bootWorker(caches) {
  const listeners = new Map();
  const worker = { addEventListener: (type, cb) => listeners.set(type, cb), location: { origin: 'https://app.example.test' }, clients: { matchAll: async () => [] } };
  runInNewContext(adapterSource, { self: worker, URL, Response, Headers, AbortController, caches, fetch });
  return listeners;
}

function sync(listeners, properties) {
  let persisted;
  listeners.get('message')({
    data: { type: 'SYNC_PROPERTIES', properties },
    ports: [],
    waitUntil: (promise) => { persisted = promise; },
  });
  if (!persisted) throw new Error('SYNC_PROPERTIES did not start persisting via waitUntil');
  return persisted;
}

const props = (release) => `dataproduct_type=image\nhips_release=${release}\nhips_service_url=x\n`;

it('a fresh sync is not overwritten by a slower read of the stored copy', async () => {
  const store = controllableCaches();
  await sync(bootWorker(store.caches), props('old'));

  const restarted = bootWorker(store.caches);
  let release;
  store.gates.match = new Promise((resolve) => { release = resolve; });
  const readWaiting = new Promise((resolve) => { store.gates.onMatchWaiting = resolve; });
  const pending = request(restarted.get('fetch'), 46, 'properties'); // starts reading the stored copy
  await readWaiting; // the stored-copy read is now blocked mid-flight
  await sync(restarted, props('fresh')); // the reloaded page syncs meanwhile
  store.gates.match = null;
  release();

  expect(await (await pending).text()).toContain('hips_release=fresh');
  const later = await request(restarted.get('fetch'), 46, 'properties');
  expect(await later.text()).toContain('hips_release=fresh');
});

it('stores the newest properties when two syncs persist out of order', async () => {
  const store = controllableCaches();
  let releaseOld;
  let oldHeld;
  const firstWriteHeld = new Promise((resolve) => { oldHeld = resolve; });
  // The first write stalls until released; the second would otherwise finish first.
  store.gates.put.push(() => new Promise((resolve) => {
    releaseOld = resolve;
    oldHeld();
  }));
  const worker = bootWorker(store.caches);
  const first = sync(worker, props('older'));
  const second = sync(worker, props('newer'));
  await firstWriteHeld; // the older write is now stalled inside put
  releaseOld();
  await Promise.all([first, second]);

  const restarted = bootWorker(store.caches);
  const response = await request(restarted.get('fetch'), 46, 'properties');
  expect(await response.text()).toContain('hips_release=newer');
});
