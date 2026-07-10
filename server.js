const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const LTA_API_KEY = process.env.LTA_API_KEY;
const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice';

// Trust the proxy (Vercel / any reverse proxy) so req.ip reflects the real
// client IP from the X-Forwarded-For header instead of the proxy's address.
app.set('trust proxy', true);

app.use(express.json());
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
  // Loop / there-and-back services (first stop == last stop, e.g. 90/62/23)
  // legitimately travel out along a road and back, serving stops on both passes —
  // geometry that looks like a spur. So for loops we only strip *stop-free* short
  // retraces (clear artifacts) and never touch stop-serving legs; point-to-point
  // routes may also drop retraces that serve a single mis-snapped stop.
  const first = routeRows[0].BusStopCode;
  const last = routeRows[routeRows.length - 1].BusStopCode;
  const isLoop = first === last
    || haversineMetres(coords[0], coords[coords.length - 1]) < 400;
  const opts = isLoop ? { MAX_STOPS: 0, MAX: 800 } : { MAX_STOPS: 1, MAX: 1500 };

  const candidate = deSpur(allLine, coords, opts);
  // Safety net: de-spurring should only ever make the line smoother. If it added
  // hairpins, it spliced out something it shouldn't have (e.g. a stop-sparse leg
  // of a real there-and-back), so discard it and keep the faithful OSRM line.
  const cleaned = hairpinCount(candidate) > hairpinCount(allLine) ? allLine : candidate;
  roadPathCache.set(key, { at: Date.now(), coords: cleaned });
  return cleaned;
}

// Count sharp (~U-turn) direction reversals in a polyline, using bearings
// measured over ~15 m either side of each vertex so short zig-zags don't
// register. Used only as the de-spur safety net above.
function hairpinCount(line) {
  let count = 0;
  for (let i = 1; i < line.length - 1; i++) {
    let j = i, back = 0;
    while (j > 0 && back < 15) { back += haversineMetres(line[j - 1], line[j]); j--; }
    let k = i, fwd = 0;
    while (k < line.length - 1 && fwd < 15) { fwd += haversineMetres(line[k], line[k + 1]); k++; }
    const A = line[j], B = line[i], C = line[k];
    const v1 = [B[0] - A[0], B[1] - A[1]], v2 = [C[0] - B[0], C[1] - B[1]];
    const m1 = Math.hypot(v1[0], v1[1]), m2 = Math.hypot(v2[0], v2[1]);
    if (m1 < 1e-9 || m2 < 1e-9) continue;
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (m1 * m2);
    if (Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI > 140) count++;
  }
  return count;
}

// Great-circle distance between two [lng,lat] points, in metres.
function haversineMetres(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Fraction of an excursion's outbound leg that overlaps its inbound leg.
// A retracing spur (out and back along the *same* road) scores ~1; a genuine
// loop that returns via *different* roads scores low. We split the segment
// line[a..b] at its farthest point (the tip) and, for each outbound point,
// check whether some inbound point lies within OVER metres.
function overlapFraction(line, a, b, OVER = 28) {
  let tip = a, maxD = 0;
  for (let t = a; t <= b; t++) {
    const d = haversineMetres(line[a], line[t]);
    if (d > maxD) { maxD = d; tip = t; }
  }
  if (tip === a || tip === b) return 0;
  let hit = 0, total = 0;
  for (let p = a; p <= tip; p++) {
    total++;
    let min = Infinity;
    for (let q = tip; q <= b; q++) {
      const d = haversineMetres(line[p], line[q]);
      if (d < min) min = d;
      if (min < OVER) break;
    }
    if (min < OVER) hit++;
  }
  return total ? hit / total : 0;
}

// How many of the route's stops lie within THRESH metres of the segment
// line[a..b]. Used to tell an artifact spur (a detour to reach *one* set-back
// stop) from a legitimate there-and-back (which serves *several* stops).
function stopsServedBy(line, a, b, stopPts, THRESH = 55) {
  let n = 0;
  for (const sp of stopPts) {
    let min = Infinity;
    for (let t = a; t <= b; t++) {
      const d = haversineMetres(sp, line[t]);
      if (d < min) min = d;
      if (min < THRESH) break;
    }
    if (min < THRESH) n++;
  }
  return n;
}

// OSRM's `route` service forces the line to pass exactly through every bus-stop
// coordinate. When a stop snaps to a driveway, service road, or the opposite
// carriageway of a divided road, this produces an out-and-back "spur" — the
// path darts off and doubles back on itself along the same road (drawn as two
// parallel lines with a hairpin at the tip).
//
// A spur is spliced out only when it is BOTH a genuine retrace (outbound and
// inbound legs overlap — see overlapFraction) AND serves at most MAX_STOPS bus
// stops. The stop test protects legitimate there-and-back travel, which serves
// several stops; an artifact only exists to reach one (or zero) mis-snapped
// stops. Callers pass MAX_STOPS=0 for loop routes (stricter) and 1 for
// point-to-point; fetchRoadPath also guards the result with hairpinCount.
function deSpur(line, stopPts = [], { NEAR = 35, MIN = 40, MAX = 1500, LOOK = 1500, OVERLAP = 0.8, MAX_STOPS = 1 } = {}) {
  if (!Array.isArray(line) || line.length < 3) return line;
  const out = [line[0]];
  let i = 0;
  while (i < line.length - 1) {
    let best = -1, run = 0;
    for (let j = i + 1; j < Math.min(i + LOOK, line.length); j++) {
      run += haversineMetres(line[j - 1], line[j]);
      if (run > MAX) break;
      if (run > MIN && haversineMetres(line[i], line[j]) < NEAR) best = j;
    }
    if (best !== -1
      && overlapFraction(line, i, best) >= OVERLAP
      && stopsServedBy(line, i, best, stopPts) <= MAX_STOPS) {
      i = best; // artifact retrace: skip the excursion; line[i] (base) already in `out`
    } else {
      out.push(line[i + 1]);
      i++;
    }
  }
  return out;
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

// ── Postal code → lat/lng (via OneMap public search) ────────────────────────
const postalCache = new Map(); // postal → { at, result }
const POSTAL_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days — postal codes rarely move

app.get('/api/postal', async (req, res) => {
  const postal = String(req.query.code || '').trim();
  if (!/^\d{6}$/.test(postal)) {
    return res.status(400).json({ error: 'A 6-digit postal code is required.' });
  }

  const hit = postalCache.get(postal);
  if (hit && Date.now() - hit.at < POSTAL_TTL) return res.json(hit.result);

  try {
    const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${postal}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`OneMap ${r.status}`);
    const data = await r.json();

    const match = (data.results || []).find(x => x.POSTAL === postal) || data.results?.[0];
    if (!match || !match.LATITUDE) {
      return res.status(404).json({ error: 'Postal code not found.' });
    }

    const result = {
      postal,
      lat: +match.LATITUDE,
      lng: +match.LONGITUDE,
      address: match.ADDRESS || match.SEARCHVAL || '',
    };
    postalCache.set(postal, { at: Date.now(), result });
    res.json(result);
  } catch (err) {
    console.error('Postal lookup failed:', err.message);
    res.status(502).json({ error: 'Postal code lookup failed.' });
  }
});

// ── Search logging ──────────────────────────────────────────────────────────
// Records what users search for + their IP. Uses console.log so the output is
// captured by the host's runtime logs (e.g. Vercel → Project → Logs).
app.post('/api/log-search', (req, res) => {
  const query = String(req.body?.query || '').slice(0, 200);
  // Prefer the left-most X-Forwarded-For entry (the original client) when present.
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || req.ip || '';

  console.log(`[SEARCH] ${JSON.stringify({
    ts: new Date().toISOString(),
    ip,
    query,
    action: req.body?.action || 'search',
    ua: req.headers['user-agent'] || '',
  })}`);

  res.status(204).end();
});

// Only start a long-running listener when run directly (local dev). On Vercel
// the exported app is invoked as a serverless function instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SG Bus Arrival running → http://localhost:${PORT}`);
    // Pre-warm the bus stops cache so the first page load is instant
    if (LTA_API_KEY && LTA_API_KEY !== 'your_api_key_here') {
      fetchAllBusStops()
        .then(() => fetchAllBusRoutes())
        .catch(err => console.error('Pre-warm failed:', err.message));
    }
  });
}

module.exports = app;
