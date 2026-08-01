/* SG Bus Arrival — service worker.
 *
 * Bump CACHE_VERSION whenever the precached shell (index.html / css / js /
 * icons) changes so clients pick up the new assets. Old caches are deleted on
 * activate.
 *
 * Strategy per request type:
 *   • app shell (html/css/js/icons/manifest) ....... precache + stale-while-revalidate
 *   • Leaflet CDN (unpkg) .......................... stale-while-revalidate
 *   • map tiles (CartoDB / Stadia) ................. cache-first, capped
 *   • /api/stops · /api/route · /api/road-path ..... network-first, cache fallback
 *   • /api/arrivals* · /api/postal · /api/log-search  network-only (never cached —
 *                                                    live data must stay fresh)
 *   • navigations .................................. network-first, offline → cached shell
 */

const CACHE_VERSION = 'v4';
const CORE_CACHE    = `core-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;
const TILE_CACHE    = `tiles-${CACHE_VERSION}`;
const DATA_CACHE    = `data-${CACHE_VERSION}`;

const TILE_CACHE_MAX = 300; // rough cap so the tile cache can't grow unbounded

// Same-origin shell that must be available offline. Kept small and must all
// fetch successfully or install fails (so we don't ship a half-cached shell).
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

// Best-effort extras (cross-origin CDN): cached if reachable, but a failure
// here must not abort the install.
const OPTIONAL_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll(CORE_ASSETS);
    // Tolerant: fetch optional assets individually, ignore failures.
    await Promise.allSettled(
      OPTIONAL_ASSETS.map(async url => {
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) await cache.put(url, res);
        } catch { /* offline or blocked — skip */ }
      })
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, RUNTIME_CACHE, TILE_CACHE, DATA_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Let the page trigger an immediate update (see app.js registration).
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ── Routing ────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache POST (e.g. /api/log-search)

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Live data must never be served stale — let it hit the network untouched.
  if (sameOrigin && isLiveApi(url.pathname)) return;

  // Static-ish API datasets: fresh when online, cached copy when offline.
  if (sameOrigin && isCacheableApi(url.pathname)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Page navigations: network-first, fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Map tiles: cache-first with a size cap.
  if (isTile(url)) {
    event.respondWith(cacheFirstCapped(request, TILE_CACHE, TILE_CACHE_MAX));
    return;
  }

  // Everything else (same-origin static + Leaflet CDN): stale-while-revalidate.
  if (sameOrigin || isCdnAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
  }
});

// ── Matchers ─────────────────────────────────────────────────────────────
function isLiveApi(pathname) {
  return pathname.startsWith('/api/arrivals')
    || pathname.startsWith('/api/postal')
    || pathname.startsWith('/api/log-search');
}

function isCacheableApi(pathname) {
  return pathname === '/api/stops'
    || pathname === '/api/route'
    || pathname === '/api/road-path';
}

function isTile(url) {
  return /(?:basemaps\.cartocdn\.com|cartocdn|stadiamaps\.com|tile\.openstreetmap)/.test(url.hostname);
}

function isCdnAsset(url) {
  return url.hostname === 'unpkg.com';
}

// ── Strategies ───────────────────────────────────────────────────────────
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function navigationHandler(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CORE_CACHE);
    return (await cache.match(request))
      || (await cache.match('/index.html'))
      || (await cache.match('/'))
      || Response.error();
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(res => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function cacheFirstCapped(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(request, res.clone());
      trimCache(cacheName, max);
    }
    return res;
  } catch (err) {
    return cached || Response.error();
  }
}

// FIFO-ish trim: drop the oldest entries once the cache exceeds `max`.
async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
