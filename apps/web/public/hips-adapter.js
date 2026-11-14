const HIPS_ROOT = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const PREFIX = '/spherex-virtual-hips/channel/';
let propertiesText = '';
const TILE_CACHE = 'spherex-dr1-tiles-v1';
// The browser stops an idle service worker and restarts it on the next request,
// wiping in-memory state. The synced HiPS properties are therefore also kept in
// Cache Storage, so layers created after the restart (e.g. RGB) still load.
const META_CACHE = 'spherex-dr1-meta-v1';
const PROPERTIES_KEY = 'https://spherex-virtual-hips.invalid/properties';

async function persistProperties(text) {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(PROPERTIES_KEY, new Response(text, { headers: { 'Content-Type': 'text/plain' } }));
  } catch {
    // Persistence is best-effort; the in-memory copy still serves this worker's lifetime.
  }
}

async function loadProperties() {
  if (propertiesText || typeof caches === 'undefined') return propertiesText;
  try {
    const hit = await (await caches.open(META_CACHE)).match(PROPERTIES_KEY);
    if (hit) propertiesText = await hit.text();
  } catch {
    // Treat an unreadable cache like a never-synced worker (503 below).
  }
  return propertiesText;
}
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 128;
const observed = new Map();
let maintenance = Promise.resolve();
let warming = null;

async function cachedFetch(url, signal) {
  const cache = typeof caches === 'undefined' ? null : await caches.open(TILE_CACHE);
  const hit = await cache?.match(url);
  if (hit) return { response: hit, hit: true };
  const response = await fetch(url, { mode: 'cors', signal });
  if (cache && response.ok) {
    const bytes = await response.clone().arrayBuffer();
    if (bytes.byteLength <= MAX_BYTES) {
      const headers = new Headers(response.headers);
      headers.set('X-Cached-Bytes', String(bytes.byteLength));
      maintenance = maintenance.catch(() => {}).then(async () => {
        await cache.put(url, new Response(bytes, { headers }));
        const keys = await cache.keys();
        let total = 0;
        for (const key of keys) total += Number((await cache.match(key)).headers.get('X-Cached-Bytes'));
        while (keys.length > MAX_ENTRIES || total > MAX_BYTES) {
          const key = keys.shift();
          total -= Number((await cache.match(key)).headers.get('X-Cached-Bytes'));
          await cache.delete(key);
        }
      });
      // Cache quota failure must never prevent a real tile from being displayed.
      await maintenance.catch(() => {});
    }
  }
  return { response, hit: false };
}

async function warmNeighbours(channel, controller) {
  let budget = 8 * 1024 * 1024;
  let count = 0;
  const paths = [...observed.entries()].filter(([, value]) => value.channel === channel && Date.now() - value.at < 10000).slice(-8);
  for (const [path] of paths) {
    for (const direction of [-1, 1]) {
      let neighbour = channel + direction;
      while (neighbour >= 0 && neighbour <= 101 && !isValidChannel(neighbour)) neighbour += direction;
      if (!isValidChannel(neighbour) || controller.signal.aborted || budget <= 0 || count >= 16) continue;
      const url = `${HIPS_ROOT}/${path.replace('.png', `${neighbour === 0 ? '' : `_${neighbour}`}.png`)}`;
      try {
        const result = await cachedFetch(url, controller.signal);
        if (!result.hit) budget -= (await result.response.arrayBuffer()).byteLength;
        count++;
      } catch { if (controller.signal.aborted) return; }
    }
  }
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type === 'CANCEL_PREFETCH') { warming?.abort(); return; }
  if (message?.type === 'WARM_NEIGHBOURS' && isValidChannel(message.channel)) {
    warming?.abort();
    warming = new AbortController();
    event.waitUntil(warmNeighbours(message.channel, warming));
    return;
  }
  if (message?.type === 'SYNC_PROPERTIES' && typeof message.properties === 'string') {
    propertiesText = message.properties;
    // Ack immediately (memory already serves requests); persist in the background.
    event.ports[0]?.postMessage({ ok: true });
    const saved = persistProperties(message.properties);
    if (typeof event.waitUntil === 'function') event.waitUntil(saved);
    return;
  }
});

async function report(event, details) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: 'TILE_TELEMETRY', ...details });
}

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || !requestUrl.pathname.startsWith('/spherex-virtual-hips/')) return;
  const match = requestUrl.pathname.match(/^\/spherex-virtual-hips\/channel\/(\d+)\/(.*)$/);
  const channel = match ? Number(match[1]) : NaN;
  if (!match || !isValidChannel(channel)) {
    event.respondWith(Promise.resolve(new Response('Unknown or unavailable SPHEREx virtual HiPS channel.', { status: 404 })));
    return;
  }
  event.respondWith(handleVirtualRequest(event, requestUrl, channel, match[2]));
});

async function proxyBinary(event, upstreamUrl, channel) {
  try {
    const { response: upstream, hit } = await cachedFetch(upstreamUrl, event.request.signal);
    const bytes = await upstream.arrayBuffer();
    const contentType = upstream.headers.get('content-type');
    const cors = upstream.headers.get('access-control-allow-origin');
    await report(event, {
      url: upstreamUrl,
      status: upstream.status,
      contentType,
      cors,
      bytes: hit ? 0 : bytes.byteLength,
      cacheHit: hit,
      channel,
    });
    const headers = new Headers();
    if (contentType) headers.set('Content-Type', contentType);
    if (cors) headers.set('Access-Control-Allow-Origin', cors);
    return new Response(bytes, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await report(event, { url: upstreamUrl, status: null, contentType: null, cors: null, bytes: null, error: message, channel });
    return new Response(`SPHEREx tile request failed: ${message}`, { status: 502 });
  }
}

async function handleVirtualRequest(event, requestUrl, channel, relativePath) {
  if (relativePath === 'properties') {
    const text = await loadProperties();
    if (!text) return new Response('Live SPHEREx properties have not been loaded.', { status: 503 });
    const serviceUrl = new URL(`${PREFIX}${channel}`, requestUrl.origin).href;
    const channelProperties = text.replace(/^hips_service_url=.*$/m, `hips_service_url=${serviceUrl}`);
    return new Response(channelProperties, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  }

  if (/^Norder\d+\/(Allsky|Dir\d+\/Npix\d+)\.png$/.test(relativePath)) {
    observed.delete(relativePath);
    observed.set(relativePath, { channel, at: Date.now() });
    if (observed.size > 32) observed.delete(observed.keys().next().value);
  }
  const suffix = channel === 0 ? '' : `_${channel}`;

  // Aladin Lite requests the satellite MOC and the wide-field Allsky tile; without
  // them the all-sky view stays black until the user zooms past the order-3 level.
  if (relativePath === 'Moc.fits') {
    return proxyBinary(event, `${HIPS_ROOT}/Moc.fits`, channel);
  }

  const allsky = relativePath.match(/^Norder(\d+)\/Allsky\.png$/);
  if (allsky) {
    return proxyBinary(event, `${HIPS_ROOT}/Norder${allsky[1]}/Allsky${suffix}.png`, channel);
  }

  const match = relativePath.match(/^Norder(\d+)\/Dir(\d+)\/Npix(\d+)\.png$/);
  if (!match) return new Response('Only PNG image HiPS tiles are supported.', { status: 404 });
  const [, order, directory, pixel] = match;
  const upstreamUrl = `${HIPS_ROOT}/Norder${order}/Dir${directory}/Npix${pixel}${suffix}.png`;
  return proxyBinary(event, upstreamUrl, channel);
}

function isValidChannel(channel) {
  return Number.isInteger(channel) && channel >= 0 && channel <= 101 && channel !== 50 && channel !== 51;
}
