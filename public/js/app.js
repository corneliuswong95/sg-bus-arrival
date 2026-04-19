// ── State ───────────────────────────────────────────────────────────────────
let map, userMarker;
const stopMarkers = new Map(); // BusStopCode → L.Marker
let allStops = [];
const stopByCode = new Map();  // BusStopCode → stop object
let selectedCode = null;
let refreshTimer = null;

// ── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  setupSearch();
  setupLocate();
  setupSheet();
  await loadAllStops();
});

// ── Map ─────────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [1.3521, 103.8198],
    zoom: 13,
    zoomControl: false,
    tap: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 20,
    subdomains: 'abcd',
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  map.on('moveend zoomend', updateMarkersInView);
}

// ── Stops ───────────────────────────────────────────────────────────────────
async function loadAllStops() {
  showLoading('Loading bus stops…');

  try {
    const res = await fetch('/api/stops');
    const data = await res.json();

    if (!res.ok) {
      const isKeyMissing = res.status === 503;
      showError(data.error || 'Failed to load bus stops.', isKeyMissing);
      return;
    }

    allStops = data;
    allStops.forEach(s => stopByCode.set(s.BusStopCode, s));
    hideLoading();
    updateMarkersInView();
  } catch {
    showError('Cannot reach the server. Is it running?', false);
  }
}

// ── Markers ─────────────────────────────────────────────────────────────────
function updateMarkersInView() {
  const zoom = map.getZoom();
  const hint = document.getElementById('zoom-hint');

  if (zoom < 15) {
    stopMarkers.forEach(m => m.remove());
    stopMarkers.clear();
    hint.classList.remove('hidden');
    return;
  }

  hint.classList.add('hidden');

  const bounds = map.getBounds();

  // Remove markers that left the viewport
  stopMarkers.forEach((marker, code) => {
    const s = stopByCode.get(code);
    if (!s || !bounds.contains([+s.Latitude, +s.Longitude])) {
      marker.remove();
      stopMarkers.delete(code);
    }
  });

  // Add visible stops (cap at 120 to keep performance smooth)
  const visible = allStops
    .filter(s => {
      const lat = +s.Latitude, lng = +s.Longitude;
      return lat && lng && bounds.contains([lat, lng]);
    })
    .slice(0, 120);

  visible.forEach(stop => {
    if (!stopMarkers.has(stop.BusStopCode)) {
      addMarker(stop);
    }
  });
}

function addMarker(stop) {
  const lat = +stop.Latitude;
  const lng = +stop.Longitude;
  if (!lat || !lng) return;

  const isSelected = stop.BusStopCode === selectedCode;
  const icon = makeIcon(stop.BusStopCode, isSelected, stop.Description);

  const marker = L.marker([lat, lng], { icon, title: stop.Description })
    .addTo(map)
    .on('click', () => selectStop(stop.BusStopCode));

  stopMarkers.set(stop.BusStopCode, marker);
}

function makeIcon(code, selected, title) {
  return L.divIcon({
    className: '',
    html: `<div class="stop-marker${selected ? ' selected' : ''}" title="${escHtml(title)}"></div>`,
    iconSize: [13, 13],
    iconAnchor: [6, 6],
  });
}

function refreshMarkerStyle(code) {
  stopMarkers.forEach((marker, c) => {
    const dot = marker.getElement()?.querySelector('.stop-marker');
    if (!dot) return;
    dot.classList.toggle('selected', c === code);
  });
}

// ── Stop selection ───────────────────────────────────────────────────────────
async function selectStop(code) {
  selectedCode = code;
  refreshMarkerStyle(code);

  const stop = stopByCode.get(code);
  openSheet(stop);
  await loadArrivals(code);

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadArrivals(code), 30_000);
}

// ── Arrivals ─────────────────────────────────────────────────────────────────
async function loadArrivals(code) {
  const list = document.getElementById('services-list');
  if (!list.children.length) {
    list.innerHTML = '<p class="state-msg">Fetching arrivals…</p>';
  }

  try {
    const res = await fetch(`/api/arrivals?code=${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderArrivals(data);
    document.getElementById('updated-label').textContent =
      'Updated ' + new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    list.innerHTML = '<p class="state-msg error">Failed to load arrivals.<br>Check your connection and try again.</p>';
  }
}

function renderArrivals(data) {
  const list = document.getElementById('services-list');
  const services = (data.Services || []).filter(s => s.ServiceNo);

  if (!services.length) {
    list.innerHTML = '<p class="state-msg">No bus services at this stop right now.</p>';
    return;
  }

  list.innerHTML = services.map(svc => {
    const dest = stopByCode.get(svc.NextBus?.DestinationCode)?.Description || '';
    const [b1, b2, b3] = [svc.NextBus, svc.NextBus2, svc.NextBus3];
    return `
      <div class="service-card">
        <div class="svc-header">
          <span class="svc-no">${escHtml(svc.ServiceNo)}</span>
          ${dest ? `<span class="svc-dest">→ ${escHtml(dest)}</span>` : ''}
          <span class="svc-operator">${escHtml(svc.Operator)}</span>
        </div>
        <div class="arrival-row">
          ${busChip(b1)}${busChip(b2)}${busChip(b3)}
        </div>
      </div>`;
  }).join('');
}

function busChip(bus) {
  if (!bus?.EstimatedArrival) {
    return `<div class="bus-chip"><span class="chip-time">—</span></div>`;
  }

  const mins = Math.round((new Date(bus.EstimatedArrival) - Date.now()) / 60_000);
  const timeText = mins <= 0 ? 'Arr' : `${mins}m`;
  const loadCls = { SEA: 'sea', SDA: 'sda', LSD: 'lsd' }[bus.Load] || '';
  const typeLabel = bus.Type === 'DD' ? 'Dbl' : bus.Type === 'BD' ? 'Bndy' : '';
  const wab = bus.Feature === 'WAB' ? '<span class="chip-wab">♿</span>' : '';

  return `
    <div class="bus-chip ${loadCls}">
      <span class="chip-time ${mins <= 0 ? 'arr' : ''}">${timeText}</span>
      <div class="chip-meta">
        ${typeLabel ? `<span>${typeLabel}</span>` : ''}
        ${wab}
      </div>
    </div>`;
}

// ── Bottom sheet ─────────────────────────────────────────────────────────────
function openSheet(stop) {
  document.getElementById('stop-code-badge').textContent = stop.BusStopCode;
  document.getElementById('stop-name').textContent = stop.Description;
  document.getElementById('stop-road').textContent = stop.RoadName;
  document.getElementById('services-list').innerHTML = '';
  document.getElementById('updated-label').textContent = '—';
  document.getElementById('bottom-sheet').classList.add('open');
}

function closeSheet() {
  document.getElementById('bottom-sheet').classList.remove('open');
  clearInterval(refreshTimer);
  selectedCode = null;
  refreshMarkerStyle(null);
}

function setupSheet() {
  document.getElementById('close-btn').addEventListener('click', closeSheet);
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (selectedCode) loadArrivals(selectedCode);
  });
}

// ── Search ───────────────────────────────────────────────────────────────────
function setupSearch() {
  const input   = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  const clearBtn = document.getElementById('clear-btn');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.classList.toggle('hidden', !q);

    if (!q) { results.classList.add('hidden'); return; }

    const hits = searchStops(q).slice(0, 8);
    if (!hits.length) { results.classList.add('hidden'); return; }

    results.innerHTML = hits.map(s => `
      <div class="result-item" data-code="${s.BusStopCode}">
        <span class="result-code">${s.BusStopCode}</span>
        <span class="result-name">${escHtml(s.Description)}</span>
        <span class="result-road">${escHtml(s.RoadName)}</span>
      </div>`).join('');

    results.classList.remove('hidden');
  });

  results.addEventListener('click', e => {
    const item = e.target.closest('.result-item');
    if (!item) return;
    const stop = stopByCode.get(item.dataset.code);
    if (!stop) return;

    input.value = '';
    clearBtn.classList.add('hidden');
    results.classList.add('hidden');
    input.blur();

    map.setView([+stop.Latitude, +stop.Longitude], 17, { animate: true });
    // Give the map time to render the marker before selecting
    setTimeout(() => selectStop(stop.BusStopCode), 400);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.add('hidden');
    results.classList.add('hidden');
    input.focus();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#search-bar')) results.classList.add('hidden');
  });
}

function searchStops(q) {
  const lower = q.toLowerCase();
  const codeExact = allStops.filter(s => s.BusStopCode === q);
  const rest = allStops.filter(s =>
    s.BusStopCode !== q && (
      s.Description.toLowerCase().includes(lower) ||
      s.RoadName.toLowerCase().includes(lower) ||
      s.BusStopCode.startsWith(q)
    )
  );
  return [...codeExact, ...rest];
}

// ── Geolocation ──────────────────────────────────────────────────────────────
function setupLocate() {
  document.getElementById('locate-btn').addEventListener('click', () => {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude: lat, longitude: lng } }) => {
        map.setView([lat, lng], 17, { animate: true });

        if (userMarker) userMarker.remove();
        userMarker = L.circleMarker([lat, lng], {
          radius: 8,
          fillColor: '#1565c0',
          color: 'white',
          weight: 2.5,
          fillOpacity: 1,
        }).addTo(map).bindPopup('You are here');
      },
      () => alert('Unable to access your location.')
    );
  });
}

// ── Loading UI ───────────────────────────────────────────────────────────────
function showLoading(msg) {
  const el = document.getElementById('loading-overlay');
  el.classList.remove('hidden');
  document.getElementById('loading-text').textContent = msg;
  document.getElementById('loading-text').style.color = '';
  document.getElementById('loading-link').classList.add('hidden');
  el.querySelector('.spinner').style.display = '';
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function showError(msg, showApiLink) {
  const el = document.getElementById('loading-overlay');
  el.classList.remove('hidden');
  el.querySelector('.spinner').style.display = 'none';
  const txt = document.getElementById('loading-text');
  txt.textContent = msg;
  txt.style.color = '#d32f2f';
  document.getElementById('loading-link').classList.toggle('hidden', !showApiLink);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
