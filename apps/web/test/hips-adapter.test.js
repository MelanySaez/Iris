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
