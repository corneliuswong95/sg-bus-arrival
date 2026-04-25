const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const LTA_API_KEY = process.env.LTA_API_KEY;
const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice';

app.use(express.static(path.join(__dirname, 'public')));

// Fetch with retry/backoff — LTA returns 500 under high concurrency.
async function fetchLta(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { AccountKey: LTA_API_KEY, accept: 'application/json' },
      });
      if (res.ok) return res.json();
      lastErr = new Error(`LTA ${res.status}`);
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 200 * (i + 1) + Math.random() * 200));
  }
  throw lastErr;
}

// Run async tasks with bounded concurrency.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

let stopsCache = null;
let stopsCachedAt = 0;
const STOPS_TTL = 6 * 60 * 60 * 1000; // 6 hours

let stopsPromise = null;

async function fetchAllBusStops() {
  if (stopsCache && Date.now() - stopsCachedAt < STOPS_TTL) return stopsCache;
  if (stopsPromise) return stopsPromise;

  stopsPromise = (async () => {
    const t0 = Date.now();
    // SG has ~5,400 bus stops. Fetch 14 pages (skip 0..6500) — 6 in parallel.
    const skips = Array.from({ length: 14 }, (_, i) => i * 500);

    const pages = await runPool(skips, 6, async skip => {
      const data = await fetchLta(`${LTA_BASE}/BusStops?$skip=${skip}`);
      return data.value || [];
    });

    const stops = pages.flat();
    stopsCache = stops;
    stopsCachedAt = Date.now();
    console.log(`Cached ${stops.length} bus stops in ${Date.now() - t0} ms`);
    return stops;
  })();

  try {
    return await stopsPromise;
  } finally {
    stopsPromise = null;
  }
}

app.get('/api/stops', async (req, res) => {
  if (!LTA_API_KEY || LTA_API_KEY === 'your_api_key_here') {
    return res.status(503).json({ error: 'LTA_API_KEY not configured. See .env.example.' });
  }
  try {
    const stops = await fetchAllBusStops();
    res.json(stops);
  } catch (err) {
    console.error('Failed to fetch stops:', err.message);
    res.status(500).json({ error: 'Failed to fetch bus stops from LTA API.' });
  }
});

// ── Bus routes (per-service stop sequences) ─────────────────────────────────
let routesCache = null;
let routesCachedAt = 0;
let routesPromise = null;
const ROUTES_TTL = 24 * 60 * 60 * 1000; // 24 h

async function fetchAllBusRoutes() {
  if (routesCache && Date.now() - routesCachedAt < ROUTES_TTL) return routesCache;
  if (routesPromise) return routesPromise;

  routesPromise = (async () => {
    const t0 = Date.now();
    // SG bus routes: ~26,700 records, 500/page = ~54 pages. Fetch 6 in parallel
    // (LTA rate-limits and returns 500 above ~20 concurrent calls).
    const skips = Array.from({ length: 60 }, (_, i) => i * 500);
    const pages = await runPool(skips, 6, async skip => {
      const data = await fetchLta(`${LTA_BASE}/BusRoutes?$skip=${skip}`);
      return data.value || [];
    });
    const routes = pages.flat();

    // Index by service for O(1) lookup
    const byService = new Map();
    for (const r of routes) {
      if (!byService.has(r.ServiceNo)) byService.set(r.ServiceNo, []);
      byService.get(r.ServiceNo).push(r);
    }

    routesCache = byService;
    routesCachedAt = Date.now();
    console.log(`Cached ${routes.length} route stops in ${Date.now() - t0} ms`);
    return byService;
  })();

  try { return await routesPromise; }
  finally { routesPromise = null; }
}

app.get('/api/route', async (req, res) => {
  if (!LTA_API_KEY || LTA_API_KEY === 'your_api_key_here') {
    return res.status(503).json({ error: 'LTA_API_KEY not configured.' });
  }
  const service = req.query.service;
  if (!service) return res.status(400).json({ error: 'service param required' });

  try {
    const byService = await fetchAllBusRoutes();
    res.json(byService.get(service) || []);
  } catch (err) {
    console.error('Failed to fetch route:', err.message);
    res.status(500).json({ error: 'Failed to fetch bus route.' });
  }
});

// ── Road-snapped route geometry (via OSRM public demo server) ──────────────
// Cache by `${service}:${direction}` → GeoJSON [lng,lat] coord array.
const roadPathCache = new Map();
const ROAD_PATH_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

async function fetchRoadPath(service, direction) {
  const key = `${service}:${direction}`;
  const hit = roadPathCache.get(key);
  if (hit && Date.now() - hit.at < ROAD_PATH_TTL) return hit.coords;

  // Need stops + their coords
  const [stopsList, byService] = await Promise.all([fetchAllBusStops(), fetchAllBusRoutes()]);
  const stopByCode = new Map(stopsList.map(s => [s.BusStopCode, s]));
  const routeRows = (byService.get(service) || [])
    .filter(r => r.Direction === direction)
    .sort((a, b) => a.StopSequence - b.StopSequence);

  if (routeRows.length < 2) return null;

  const coords = routeRows
    .map(r => stopByCode.get(r.BusStopCode))
    .filter(Boolean)
    .map(s => [+s.Longitude, +s.Latitude])
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));

  if (coords.length < 2) return null;

  // OSRM accepts up to ~100 waypoints; chunk into overlapping windows.
  const CHUNK = 95;
  const allLine = [];
  for (let i = 0; i < coords.length; i += CHUNK - 1) {
    const slice = coords.slice(i, i + CHUNK);
    if (slice.length < 2) break;
    const path = slice.map(c => `${c[0]},${c[1]}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${path}?overview=full&geometries=geojson`;
    const r = await fetch(url, { headers: { 'User-Agent': 'sg-bus-arrival/1.0' } });
    if (!r.ok) throw new Error(`OSRM ${r.status}`);
    const data = await r.json();
    const seg = data.routes?.[0]?.geometry?.coordinates;
    if (!seg?.length) throw new Error('OSRM empty geometry');
    if (allLine.length) seg.shift(); // avoid duplicate join point
    allLine.push(...seg);
  }
  roadPathCache.set(key, { at: Date.now(), coords: allLine });
  return allLine;
}

app.get('/api/road-path', async (req, res) => {
  const service = req.query.service;
  const direction = Number(req.query.direction) || 1;
  if (!service) return res.status(400).json({ error: 'service param required' });
  try {
    const coords = await fetchRoadPath(service, direction);
    if (!coords) return res.status(404).json({ error: 'No route data' });
    res.json({ coordinates: coords }); // [[lng,lat], ...]
  } catch (err) {
    console.error('road-path failed:', err.message);
    res.status(502).json({ error: 'Routing failed', detail: err.message });
  }
});

app.get('/api/arrivals', async (req, res) => {
  if (!LTA_API_KEY || LTA_API_KEY === 'your_api_key_here') {
    return res.status(503).json({ error: 'LTA_API_KEY not configured.' });
  }
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Bus stop code required.' });

  try {
    const r = await fetch(`${LTA_BASE}/v3/BusArrival?BusStopCode=${encodeURIComponent(code)}`, {
      headers: { AccountKey: LTA_API_KEY, accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`LTA API error: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('Failed to fetch arrivals:', err.message);
    res.status(500).json({ error: 'Failed to fetch bus arrivals.' });
  }
});

app.listen(PORT, () => {
  console.log(`SG Bus Arrival running → http://localhost:${PORT}`);
  // Pre-warm the bus stops cache so the first page load is instant
  if (LTA_API_KEY && LTA_API_KEY !== 'your_api_key_here') {
    fetchAllBusStops()
      .then(() => fetchAllBusRoutes())
      .catch(err => console.error('Pre-warm failed:', err.message));
  }
});
