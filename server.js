const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const LTA_API_KEY = process.env.LTA_API_KEY;
const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice';

app.use(express.static(path.join(__dirname, 'public')));

let stopsCache = null;
let stopsCachedAt = 0;
const STOPS_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function fetchAllBusStops() {
  if (stopsCache && Date.now() - stopsCachedAt < STOPS_TTL) {
    return stopsCache;
  }

  const stops = [];
  let skip = 0;

  while (true) {
    const res = await fetch(`${LTA_BASE}/BusStops?$skip=${skip}`, {
      headers: { AccountKey: LTA_API_KEY, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`LTA API error: ${res.status}`);
    const data = await res.json();
    const batch = data.value || [];
    stops.push(...batch);
    if (batch.length < 500) break;
    skip += 500;
  }

  stopsCache = stops;
  stopsCachedAt = Date.now();
  console.log(`Cached ${stops.length} bus stops`);
  return stops;
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

app.listen(PORT, () =>
  console.log(`SG Bus Arrival running → http://localhost:${PORT}`)
);
