// ── State ───────────────────────────────────────────────────────────────────
let map, userMarker, tileLayer;
const stopMarkers = new Map(); // BusStopCode → L.Marker
let allStops = [];
const stopByCode = new Map();  // BusStopCode → stop object
let selectedCode = null;
let refreshTimer = null;
let arrivalsTickTimer = null;
let lastArrivalsData = null;
const ARRIVALS_REFRESH_MS = 30_000; // LTA data updates ~every 20-30s
const ARRIVALS_TICK_MS = 10_000;    // local re-render so "Xm" counts down
let openedFromNearby = false;
let nearbyShowCount = 10;
const NEARBY_INCREMENT = 10;
const NEARBY_MAX = 50;

let currentRouteLayer = null;
let routeServiceNo = null;

// ── Favourites (persisted in localStorage, kept indefinitely) ─────────────────
const favStops = new Set(loadFavs('favStops'));       // BusStopCode strings
const favServices = new Set(loadFavs('favServices')); // ServiceNo strings

function loadFavs(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
}
function saveFavs(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}
function toggleFav(set, key, id) {
  if (set.has(id)) set.delete(id); else set.add(id);
  saveFavs(key, set);
}
// Comparator fragment: favourited ids sort first (returns <0, 0, or >0).
function favFirst(set, a, b) {
  return (set.has(b) ? 1 : 0) - (set.has(a) ? 1 : 0);
}
function starSvg() {
  return `<svg class="star-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2.6l2.75 5.57 6.15.9-4.45 4.34 1.05 6.12L12 16.9l-5.5 2.89 1.05-6.12L3.1 9.07l6.15-.9z"/></svg>`;
}

// ── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  setupSearch();
  setupLocate();
  setupTheme();
  setupSheet();
  setupNearbySheet();
  await loadAllStops();
  updateNearbyList();
  maybePromptForLocation();
});

// ── Map ─────────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [1.3521, 103.8198],
    zoom: 13,
    zoomControl: false,
    tap: true,
  });

  setTiles(effectiveTheme());

  L.control.zoom({ position: 'topright' }).addTo(map);

  map.on('moveend zoomend', () => {
    updateMarkersInView();
    updateNearbyList();
  });
}

// ── Theme (dark mode) ─────────────────────────────────────────────────────────
// Resolves the active theme: an explicit user choice (data-theme) wins,
// otherwise fall back to the OS preference.
function effectiveTheme() {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'dark' || forced === 'light') return forced;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Basemap per theme. Light = CartoDB Voyager; dark = Stadia Alidade Smooth Dark.
const TILE_CONFIG = {
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 20,
      subdomains: 'abcd',
    },
  },
  dark: {
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    options: {
      attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      maxZoom: 20,
    },
  },
};

// (Re)build the tile layer for the given theme so both the URL and its
// attribution update together.
function setTiles(theme) {
  const cfg = TILE_CONFIG[theme] || TILE_CONFIG.light;
  if (tileLayer) tileLayer.remove();
  tileLayer = L.tileLayer(cfg.url, cfg.options).addTo(map);
}

// Swap the map tiles and browser chrome color to match the active theme.
function applyThemeSideEffects() {
  const theme = effectiveTheme();
  setTiles(theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#121212' : '#d32f2f');
}

function setupTheme() {
  applyThemeSideEffects();

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* ignore */ }
    applyThemeSideEffects();
  });

  // Follow OS changes only while the user hasn't made an explicit choice.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    let stored = null;
    try { stored = localStorage.getItem('theme'); } catch { /* ignore */ }
    if (!stored) applyThemeSideEffects();
  });
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
async function selectStop(code, opts = {}) {
  selectedCode = code;
  openedFromNearby = !!opts.fromNearby;

  const stop = stopByCode.get(code);
  if (!stop) return;

  refreshMarkerStyle(code);
  openSheet(stop);
  panMapToStop(stop);

  await loadArrivals(code);
  startArrivalsRefresh(code);
}

// Poll arrivals every 30s. Skip the fetch while the tab is hidden (locked
// phone / background tab) to avoid wasting API calls; the visibilitychange
// handler does an immediate refresh when the user returns.
// A faster local tick re-renders the times from the last fetched data so the
// "Xm" values count down smoothly between fetches — no extra API calls.
function startArrivalsRefresh(code) {
  stopArrivalsRefresh();
  refreshTimer = setInterval(() => {
    if (!document.hidden) loadArrivals(code);
  }, ARRIVALS_REFRESH_MS);
  arrivalsTickTimer = setInterval(() => {
    if (!document.hidden) tickArrivals();
  }, ARRIVALS_TICK_MS);
}

function stopArrivalsRefresh() {
  clearInterval(refreshTimer);
  clearInterval(arrivalsTickTimer);
}

// Recompute arrival times in place from the last fetched data (no network),
// updating each card's chips so minutes tick down without a full re-render.
function tickArrivals() {
  if (!lastArrivalsData) return;
  const byNo = new Map(
    (lastArrivalsData.Services || []).filter(s => s.ServiceNo).map(s => [s.ServiceNo, s])
  );
  document.querySelectorAll('#services-list .service-card').forEach(card => {
    const svc = byNo.get(card.dataset.service);
    const row = card.querySelector('.arrival-row');
    if (svc && row) row.innerHTML = arrivalRowHtml(svc);
  });
}

// Center the map on the selected stop. On mobile, offset upward so the marker
// stays visible in the area above the bottom sheet.
function panMapToStop(stop) {
  const lat = +stop.Latitude;
  const lng = +stop.Longitude;
  const zoom = Math.max(map.getZoom(), 17);

  const isMobile = window.innerWidth < 600;
  if (!isMobile) {
    map.flyTo([lat, lng], zoom, { duration: 0.5 });
    return;
  }

  const mapH = map.getSize().y;
  const targetPx = map.project([lat, lng], zoom);
  // Shift the projected center DOWN by 25% of viewport height so the marker
  // appears in the upper portion of the screen (clear of the bottom sheet).
  const newCenter = map.unproject(targetPx.add([0, mapH * 0.25]), zoom);
  map.flyTo(newCenter, zoom, { duration: 0.5 });
}

// Center a point in the visible map area *above* the expanded nearby sheet, so
// the user/location dot sits in the middle of what's actually on screen. On
// desktop the sheet is a side panel that doesn't cover the center, so we just
// center normally.
function centerInVisibleArea(lat, lng, zoom) {
  const sheet = document.getElementById('nearby-sheet');
  const isMobile = window.innerWidth < 600;

  if (!isMobile || !sheet.classList.contains('expanded')) {
    map.setView([lat, lng], zoom, { animate: true });
    return;
  }

  const mapH = map.getSize().y;
  // Sheet height is unaffected by its slide transform, so this is stable even
  // while the sheet is still animating up.
  const sheetTop = mapH - sheet.offsetHeight;
  const visibleCenter = sheetTop / 2;
  const targetPx = map.project([lat, lng], zoom);
  // Move the map center below the target so the target rises to the middle of
  // the visible (uncovered) region.
  const newCenter = map.unproject(targetPx.add([0, mapH / 2 - visibleCenter]), zoom);
  map.setView(newCenter, zoom, { animate: true });
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
    lastArrivalsData = data;
    renderArrivals(data);
    document.getElementById('updated-label').textContent =
      'Updated ' + new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    list.innerHTML = '<p class="state-msg error">Failed to load arrivals.<br>Check your connection and try again.</p>';
  }
}

function renderArrivals(data) {
  const list = document.getElementById('services-list');
  const services = (data.Services || [])
    .filter(s => s.ServiceNo)
    .sort((a, b) => favFirst(favServices, a.ServiceNo, b.ServiceNo)
                 || compareServiceNo(a.ServiceNo, b.ServiceNo));

  if (!services.length) {
    list.innerHTML = '<p class="state-msg">No bus services at this stop right now.</p>';
    return;
  }

  list.innerHTML = services.map(svc => {
    const dest = stopByCode.get(svc.NextBus?.DestinationCode)?.Description || '';
    const isActive = svc.ServiceNo === routeServiceNo;
    return `
      <div class="service-card${isActive ? ' route-active' : ''}" data-service="${escHtml(svc.ServiceNo)}">
        <div class="svc-header">
          <span class="svc-no">${escHtml(svc.ServiceNo)}</span>
          ${dest ? `<span class="svc-dest">${escHtml(dest.toUpperCase())}</span>` : ''}
          ${operatorBadge(svc.Operator)}
          <button class="star-btn${favServices.has(svc.ServiceNo) ? ' starred' : ''}" data-fav-service="${escHtml(svc.ServiceNo)}" aria-label="Favourite bus ${escHtml(svc.ServiceNo)}">${starSvg()}</button>
        </div>
        <div class="arrival-row">${arrivalRowHtml(svc)}</div>
      </div>`;
  }).join('');
}

// The three arrival chips for a service (recomputed each render so times tick).
function arrivalRowHtml(svc) {
  return busChip(svc.NextBus) + busChip(svc.NextBus2) + busChip(svc.NextBus3);
}

// Natural sort for bus service numbers: numeric part first (10 before 97),
// then any letter suffix (10 before 10e), then fully alphabetic ones (NR7).
function compareServiceNo(a, b) {
  const parse = s => {
    const m = String(s).match(/^(\d*)(.*)$/);
    return { num: m[1] === '' ? Infinity : parseInt(m[1], 10), suffix: m[2] };
  };
  const pa = parse(a), pb = parse(b);
  if (pa.num !== pb.num) return pa.num - pb.num;
  return pa.suffix.localeCompare(pb.suffix);
}

function busChip(bus) {
  if (!bus?.EstimatedArrival) {
    return `<div class="bus-chip"><span class="chip-time">—</span></div>`;
  }

  const mins = Math.round((new Date(bus.EstimatedArrival) - Date.now()) / 60_000);
  const timeText = mins <= 0 ? 'Arr' : `${mins}m`;
  const loadCls = { SEA: 'sea', SDA: 'sda', LSD: 'lsd' }[bus.Load] || '';
  const typeIcon = busTypeIcon(bus.Type);

  return `
    <div class="bus-chip ${loadCls}">
      <span class="chip-time ${mins <= 0 ? 'arr' : ''}">${timeText}</span>
      ${typeIcon ? `<div class="chip-meta">${typeIcon}</div>` : ''}
    </div>`;
}

// SVG icon for bus body type (double-decker / bendy). Single-deck = no icon.
function busTypeIcon(type) {
  if (type === 'DD') {
    return `<svg class="type-icon" width="22" height="20" viewBox="0 0 24 22" xmlns="http://www.w3.org/2000/svg" aria-label="Double-decker">
      <!-- bus body -->
      <rect x="2" y="2" width="20" height="16" rx="2.4" fill="currentColor"/>
      <!-- upper deck windows -->
      <rect x="3.6"  y="4"   width="3.2" height="3" rx="0.5" fill="#fff"/>
      <rect x="7.6"  y="4"   width="3.2" height="3" rx="0.5" fill="#fff"/>
      <rect x="11.6" y="4"   width="3.2" height="3" rx="0.5" fill="#fff"/>
      <rect x="15.6" y="4"   width="3.2" height="3" rx="0.5" fill="#fff"/>
      <!-- lower deck windows -->
      <rect x="3.6"  y="9"   width="3.2" height="3" rx="0.5" fill="#fff"/>
      <rect x="7.6"  y="9"   width="3.2" height="3" rx="0.5" fill="#fff"/>
      <rect x="11.6" y="9"   width="3.2" height="3" rx="0.5" fill="#fff"/>
      <!-- door -->
      <rect x="15.6" y="9"   width="3.2" height="6.5" rx="0.5" fill="#fff"/>
      <!-- headlight -->
      <rect x="20"   y="14"  width="1.4" height="1.4" rx="0.3" fill="#fff"/>
      <!-- wheels -->
      <circle cx="6"  cy="19" r="2"  fill="currentColor"/>
      <circle cx="18" cy="19" r="2"  fill="currentColor"/>
      <circle cx="6"  cy="19" r="0.8" fill="#fff"/>
      <circle cx="18" cy="19" r="0.8" fill="#fff"/>
    </svg>`;
  }
  if (type === 'BD') {
    return `<svg class="type-icon" width="34" height="16" viewBox="0 0 36 18" xmlns="http://www.w3.org/2000/svg" aria-label="Bendy bus">
      <!-- front coach body -->
      <rect x="2" y="3" width="14" height="11" rx="2" fill="currentColor"/>
      <!-- rear coach body -->
      <rect x="20" y="3" width="14" height="11" rx="2" fill="currentColor"/>
      <!-- articulation bellows -->
      <rect x="16" y="4.5" width="4" height="8" fill="currentColor"/>
      <line x1="17" y1="4.5" x2="17" y2="12.5" stroke="#fff" stroke-width="0.5" opacity="0.65"/>
      <line x1="18" y1="4.5" x2="18" y2="12.5" stroke="#fff" stroke-width="0.5" opacity="0.65"/>
      <line x1="19" y1="4.5" x2="19" y2="12.5" stroke="#fff" stroke-width="0.5" opacity="0.65"/>
      <!-- front coach windows (single deck) -->
      <rect x="3.6"  y="5" width="3.2" height="3.4" rx="0.5" fill="#fff"/>
      <rect x="7.6"  y="5" width="3.2" height="3.4" rx="0.5" fill="#fff"/>
      <rect x="11.4" y="5" width="3.2" height="3.4" rx="0.5" fill="#fff"/>
      <!-- rear coach windows (single deck) -->
      <rect x="21.4" y="5" width="3.2" height="3.4" rx="0.5" fill="#fff"/>
      <rect x="25.4" y="5" width="3.2" height="3.4" rx="0.5" fill="#fff"/>
      <rect x="29.4" y="5" width="3.2" height="3.4" rx="0.5" fill="#fff"/>
      <!-- headlight -->
      <rect x="2" y="10.5" width="1.4" height="1.4" rx="0.3" fill="#fff"/>
      <!-- wheels: 2 per coach -->
      <circle cx="5.5"  cy="15" r="1.7" fill="currentColor"/>
      <circle cx="12.5" cy="15" r="1.7" fill="currentColor"/>
      <circle cx="23.5" cy="15" r="1.7" fill="currentColor"/>
      <circle cx="30.5" cy="15" r="1.7" fill="currentColor"/>
      <circle cx="5.5"  cy="15" r="0.7" fill="#fff"/>
      <circle cx="12.5" cy="15" r="0.7" fill="#fff"/>
      <circle cx="23.5" cy="15" r="0.7" fill="#fff"/>
      <circle cx="30.5" cy="15" r="0.7" fill="#fff"/>
    </svg>`;
  }
  return '';
}

// Operator "logo" — colored pill with the brand short-name
function operatorBadge(op) {
  const map = {
    SBST: { label: 'SBS',   bg: '#6a1b9a' },
    SMRT: { label: 'SMRT',  bg: '#d71921' },
    TTS:  { label: 'Tower', bg: '#2e7d32' },
    GAS:  { label: 'Go',    bg: '#f57c00' },
  };
  const style = map[op] || { label: op || '', bg: '#757575' };
  return `<span class="svc-operator" style="background:${style.bg}">${escHtml(style.label)}</span>`;
}

// ── Bottom sheet ─────────────────────────────────────────────────────────────
function getSheetSnaps() {
  // Sheet is 92vh tall. translateY(0) = fully open. Larger px = more hidden.
  const sheet = document.getElementById('bottom-sheet');
  const h = sheet.getBoundingClientRect().height || window.innerHeight * 0.92;
  return {
    full: 0,                       // entire 92vh visible
    mid: Math.round(h * 0.28),     // ~66vh visible (default)
    peek: Math.max(0, Math.round(h - 64)), // just handle + header strip
    max: Math.max(0, Math.round(h - 64)),  // clamp lower bound
  };
}

function setSheetOffset(px) {
  const sheet = document.getElementById('bottom-sheet');
  const { max } = getSheetSnaps();
  const clamped = Math.max(0, Math.min(max, px));
  sheet.style.transform = `translateY(${clamped}px)`;
}

function openSheet(stop) {
  exitRouteMode();
  document.getElementById('nearby-sheet').classList.remove('expanded');
  document.getElementById('back-btn').classList.toggle('hidden', !openedFromNearby);
  document.getElementById('stop-code-badge').textContent = stop.BusStopCode;
  document.getElementById('stop-name').textContent = stop.Description;
  document.getElementById('stop-road').textContent = stop.RoadName;
  document.getElementById('fav-stop-btn').classList.toggle('starred', favStops.has(stop.BusStopCode));
  document.getElementById('services-list').innerHTML = '';
  document.getElementById('updated-label').textContent = '—';
  const sheet = document.getElementById('bottom-sheet');
  sheet.classList.add('open');
  // Default to mid snap on open (only on mobile-style stack layout)
  if (window.innerWidth < 600) {
    requestAnimationFrame(() => setSheetOffset(getSheetSnaps().mid));
  } else {
    sheet.style.transform = '';
  }
}

function closeSheet() {
  const sheet = document.getElementById('bottom-sheet');
  sheet.classList.remove('open');
  sheet.style.transform = '';
  stopArrivalsRefresh();
  lastArrivalsData = null;
  selectedCode = null;
  refreshMarkerStyle(null);
  clearRoute();
}

function setupSheet() {
  document.getElementById('close-btn').addEventListener('click', closeSheet);

  // Refresh immediately when the tab becomes visible again (data may be stale
  // after the phone was locked or the tab was backgrounded).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && selectedCode) loadArrivals(selectedCode);
  });
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (selectedCode) loadArrivals(selectedCode);
  });
  document.getElementById('fav-stop-btn').addEventListener('click', () => {
    if (!selectedCode) return;
    toggleFav(favStops, 'favStops', selectedCode);
    document.getElementById('fav-stop-btn').classList.toggle('starred', favStops.has(selectedCode));
    updateNearbyList();
  });
  document.getElementById('back-btn').addEventListener('click', () => {
    closeSheet();
    document.getElementById('nearby-sheet').classList.add('expanded');
  });

  // Click a service card → show its route on the map
  document.getElementById('services-list').addEventListener('click', e => {
    // Star button toggles the favourite and re-sorts (starred first)
    const starBtn = e.target.closest('.star-btn');
    if (starBtn) {
      toggleFav(favServices, 'favServices', starBtn.dataset.favService);
      if (lastArrivalsData) renderArrivals(lastArrivalsData);
      return;
    }
    const card = e.target.closest('.service-card');
    if (!card) return;
    const service = card.dataset.service;
    if (!service) return;
    if (service === routeServiceNo) {
      clearRoute();
    } else {
      showRoute(service);
    }
  });

  document.getElementById('clear-route-btn').addEventListener('click', clearRoute);

  // Route panel: back to arrivals, and tap a stop to pan the map to it
  document.getElementById('route-back-btn').addEventListener('click', exitRouteMode);
  document.getElementById('route-stops').addEventListener('click', e => {
    const row = e.target.closest('.route-stop');
    if (!row) return;
    const s = stopByCode.get(row.dataset.code);
    if (s) panMapToStop(s);
  });

  // ── Drag-to-resize bottom sheet ─────────────────────────────────────
  const sheet  = document.getElementById('bottom-sheet');
  const handle = document.getElementById('drag-handle');

  let startY = null;
  let startOffset = 0;

  function currentOffset() {
    const m = (sheet.style.transform || '').match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
    return m ? parseFloat(m[1]) : 0;
  }
  function dragStart(y) {
    if (window.innerWidth >= 600) return; // desktop: side panel, no drag
    startY = y;
    startOffset = currentOffset();
    sheet.classList.add('dragging');
  }
  function dragMove(y) {
    if (startY === null) return;
    setSheetOffset(startOffset + (y - startY));
  }
  function dragEnd(y) {
    if (startY === null) return;
    sheet.classList.remove('dragging');
    const cur = currentOffset();
    const velocity = y - startY; // + = swiped down, - = swiped up
    const { full, mid, peek } = getSheetSnaps();

    let target;
    if (Math.abs(velocity) > 60) {
      // Flick: pick next snap in flick direction
      const ordered = [full, mid, peek];
      const nearestIdx = ordered.reduce((best, v, i) =>
        Math.abs(v - cur) < Math.abs(ordered[best] - cur) ? i : best, 0);
      const dir = velocity > 0 ? 1 : -1;
      target = ordered[Math.max(0, Math.min(ordered.length - 1, nearestIdx + dir))];
    } else {
      // Settle: snap to nearest
      target = [full, mid, peek].reduce((best, v) =>
        Math.abs(v - cur) < Math.abs(best - cur) ? v : best, full);
    }
    setSheetOffset(target);
    startY = null;
  }

  handle.addEventListener('touchstart', e => dragStart(e.touches[0].clientY), { passive: true });
  handle.addEventListener('touchmove',  e => dragMove(e.touches[0].clientY),  { passive: true });
  handle.addEventListener('touchend',   e => dragEnd(e.changedTouches[0].clientY));

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    dragStart(e.clientY);
    const onMove = ev => dragMove(ev.clientY);
    const onUp = ev => {
      dragEnd(ev.clientY);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// ── Route overview ───────────────────────────────────────────────────────────
async function showRoute(serviceNo) {
  const btn = document.getElementById('clear-route-btn');
  const label = document.getElementById('clear-route-label');
  label.textContent = `Loading ${serviceNo}…`;
  btn.classList.remove('hidden');

  try {
    const res = await fetch(`/api/route?service=${encodeURIComponent(serviceNo)}`);
    if (!res.ok) throw new Error();
    const stops = await res.json();
    if (!stops.length) {
      label.textContent = `No route for ${serviceNo}`;
      setTimeout(() => { if (routeServiceNo == null) btn.classList.add('hidden'); }, 1500);
      return;
    }

    // Group by direction; pick the direction containing the selected stop
    // (fall back to direction 1).
    const byDir = new Map();
    for (const r of stops) {
      if (!byDir.has(r.Direction)) byDir.set(r.Direction, []);
      byDir.get(r.Direction).push(r);
    }
    let chosen = null;
    if (selectedCode) {
      for (const arr of byDir.values()) {
        if (arr.some(r => r.BusStopCode === selectedCode)) { chosen = arr; break; }
      }
    }
    if (!chosen) chosen = byDir.get(1) || [...byDir.values()][0];
    chosen.sort((a, b) => a.StopSequence - b.StopSequence);

    // Build polyline coords from cached stop locations
    const coords = chosen
      .map(r => stopByCode.get(r.BusStopCode))
      .filter(Boolean)
      .map(s => [+s.Latitude, +s.Longitude])
      .filter(([la, ln]) => Number.isFinite(la) && Number.isFinite(ln));

    if (coords.length < 2) {
      label.textContent = `Route data unavailable`;
      return;
    }

    if (currentRouteLayer) currentRouteLayer.remove();

    // Try road-snapped geometry first; fall back to straight stop-to-stop line.
    let lineCoords = coords;
    try {
      const direction = chosen[0]?.Direction || 1;
      const r = await fetch(`/api/road-path?service=${encodeURIComponent(serviceNo)}&direction=${direction}`);
      if (r.ok) {
        const data = await r.json();
        if (data.coordinates?.length) {
          lineCoords = data.coordinates.map(([lng, lat]) => [lat, lng]);
        }
      }
    } catch { /* fall back to straight line */ }

    const line = L.polyline(lineCoords, {
      color: '#d32f2f',
      weight: 5,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round',
    });

    const dots = chosen.map(r => {
      const s = stopByCode.get(r.BusStopCode);
      if (!s) return null;
      const lat = +s.Latitude, lng = +s.Longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return L.circleMarker([lat, lng], {
        radius: 4,
        fillColor: '#fff',
        color: '#d32f2f',
        weight: 2,
        fillOpacity: 1,
      }).bindTooltip(`${s.BusStopCode} · ${s.Description}`, { direction: 'top' });
    }).filter(Boolean);

    currentRouteLayer = L.layerGroup([line, ...dots]).addTo(map);
    routeServiceNo = serviceNo;

    // Re-render arrivals to highlight the active card
    refreshActiveCard();

    // Show the ordered stop list for this service in the sheet
    renderRouteStops(chosen, serviceNo);

    // Fit map to route bounds with padding for the bottom sheet
    const bounds = line.getBounds();
    const isMobile = window.innerWidth < 600;
    map.fitBounds(bounds, {
      paddingTopLeft: [20, 80],
      paddingBottomRight: [20, isMobile ? 360 : 60],
    });

    label.textContent = `Clear route ${serviceNo}`;
  } catch {
    label.textContent = 'Failed to load route';
    setTimeout(() => { if (routeServiceNo == null) btn.classList.add('hidden'); }, 1500);
  }
}

function clearRoute() {
  if (currentRouteLayer) {
    currentRouteLayer.remove();
    currentRouteLayer = null;
  }
  routeServiceNo = null;
  document.getElementById('clear-route-btn').classList.add('hidden');
  exitRouteMode();
  refreshActiveCard();
}

function refreshActiveCard() {
  document.querySelectorAll('#services-list .service-card').forEach(card => {
    card.classList.toggle('route-active', card.dataset.service === routeServiceNo);
  });
}

// Populate the route panel with the full ordered stop list for a service,
// marking stops relative to the currently selected stop.
function renderRouteStops(chosen, serviceNo) {
  const destCode = chosen[chosen.length - 1]?.BusStopCode;
  const dest = stopByCode.get(destCode)?.Description || '';
  document.getElementById('route-panel-title').textContent = `Bus ${serviceNo}`;
  document.getElementById('route-panel-sub').textContent =
    `${chosen.length} stops` + (dest ? ` · towards ${dest}` : '');

  const curIdx = chosen.findIndex(r => r.BusStopCode === selectedCode);

  document.getElementById('route-stops').innerHTML = chosen.map((r, i) => {
    const s = stopByCode.get(r.BusStopCode);
    const name = s?.Description || r.BusStopCode;
    const road = s?.RoadName || '';
    let cls = 'upcoming';
    if (curIdx >= 0 && i < curIdx) cls = 'passed';
    else if (i === curIdx) cls = 'current';
    const hereBadge = i === curIdx ? '<span class="rs-here">You are here</span>' : '';
    return `
      <div class="route-stop ${cls}" data-code="${escHtml(r.BusStopCode)}">
        <span class="rs-track"><span class="rs-dot"></span></span>
        <span class="rs-info">
          <span class="rs-name">${escHtml(name)}${hereBadge}</span>
          <span class="rs-road">${escHtml(road)}</span>
        </span>
        <span class="rs-code">${escHtml(r.BusStopCode)}</span>
      </div>`;
  }).join('');

  document.getElementById('bottom-sheet').classList.add('route-mode');
  // Scroll the current stop into view within the list
  requestAnimationFrame(() => {
    document.querySelector('#route-stops .route-stop.current')
      ?.scrollIntoView({ block: 'center' });
  });
}

function exitRouteMode() {
  document.getElementById('bottom-sheet').classList.remove('route-mode');
}

// ── Nearby sheet (drag-up) ──────────────────────────────────────────────────
function setupNearbySheet() {
  const sheet  = document.getElementById('nearby-sheet');
  const handle = document.getElementById('nearby-handle');
  const list   = document.getElementById('nearby-list');

  // Tap on handle = toggle
  let didDrag = false;
  handle.addEventListener('click', () => {
    if (didDrag) { didDrag = false; return; }
    sheet.classList.toggle('expanded');
  });

  // Tap a stop in the list = open arrivals; tap "Load more" = grow the list
  list.addEventListener('click', e => {
    if (e.target.closest('#load-more-btn')) {
      nearbyShowCount = Math.min(nearbyShowCount + NEARBY_INCREMENT, NEARBY_MAX);
      updateNearbyList();
      return;
    }
    const item = e.target.closest('.nearby-item');
    if (!item) return;
    const stop = stopByCode.get(item.dataset.code);
    if (!stop) return;
    selectStop(stop.BusStopCode, { fromNearby: true });
  });

  // Drag handling (touch + mouse)
  let startY = null;
  let startExpanded = false;
  let peekOffset = 0;

  function dragStart(y) {
    startY = y;
    startExpanded = sheet.classList.contains('expanded');
    peekOffset = sheet.getBoundingClientRect().height - 56;
    sheet.classList.add('dragging');
    didDrag = false;
  }

  function dragMove(y) {
    if (startY === null) return;
    const delta = y - startY;
    if (Math.abs(delta) > 4) didDrag = true;
    const base = startExpanded ? 0 : peekOffset;
    const offset = Math.max(0, Math.min(peekOffset, base + delta));
    sheet.style.transform = `translateY(${offset}px)`;
  }

  function dragEnd(y) {
    if (startY === null) return;
    const delta = y - startY;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';

    if (startExpanded && delta > 60) {
      sheet.classList.remove('expanded');
    } else if (!startExpanded && delta < -60) {
      sheet.classList.add('expanded');
    } else {
      sheet.classList.toggle('expanded', startExpanded);
    }
    startY = null;
  }

  handle.addEventListener('touchstart', e => dragStart(e.touches[0].clientY), { passive: true });
  handle.addEventListener('touchmove',  e => dragMove(e.touches[0].clientY),  { passive: true });
  handle.addEventListener('touchend',   e => dragEnd(e.changedTouches[0].clientY));

  handle.addEventListener('mousedown', e => {
    dragStart(e.clientY);
    const onMove = ev => dragMove(ev.clientY);
    const onUp = ev => {
      dragEnd(ev.clientY);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function updateNearbyList() {
  if (!allStops.length) return;
  const list = document.getElementById('nearby-list');

  const center = userMarker?.getLatLng?.() || map.getCenter();
  const cLat = center.lat, cLng = center.lng;

  const ranked = allStops
    .map(s => ({ s, d: haversineKm(cLat, cLng, +s.Latitude, +s.Longitude) }))
    .filter(x => Number.isFinite(x.d))
    .sort((a, b) => favFirst(favStops, a.s.BusStopCode, b.s.BusStopCode) || (a.d - b.d));

  if (!ranked.length) {
    list.innerHTML = '<div class="nearby-empty">No nearby stops found.</div>';
    return;
  }

  const visible = ranked.slice(0, nearbyShowCount);
  const hasMore = nearbyShowCount < Math.min(ranked.length, NEARBY_MAX);

  list.innerHTML = visible.map(({ s, d }) => `
    <div class="nearby-item" data-code="${s.BusStopCode}">
      <span class="nearby-code">${s.BusStopCode}</span>
      <span class="nearby-name">${favStops.has(s.BusStopCode) ? '<span class="fav-mark">★</span> ' : ''}${escHtml(s.Description)}</span>
      <span class="nearby-road">${escHtml(s.RoadName)}</span>
      <span class="nearby-distance">${formatDistance(d)}</span>
    </div>`).join('') + (hasMore
      ? `<button id="load-more-btn" type="button">Load more</button>`
      : '');
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(km) {
  if (km < 1) return Math.round(km * 1000) + ' m away';
  return km.toFixed(1) + ' km away';
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

    // A 6-digit query is a Singapore postal code — offer a "find nearby" option.
    const postalRow = /^\d{6}$/.test(q)
      ? `<div class="result-item result-postal" data-postal="${q}">
           <span class="result-code">📍</span>
           <span class="result-name">Find stops near postal code ${q}</span>
           <span class="result-road">Tap to locate</span>
         </div>`
      : '';

    const hits = searchStops(q)
      .sort((a, b) => favFirst(favStops, a.BusStopCode, b.BusStopCode))
      .slice(0, 8);
    if (!hits.length && !postalRow) { results.classList.add('hidden'); return; }

    results.innerHTML = postalRow + hits.map(s => `
      <div class="result-item" data-code="${s.BusStopCode}">
        <span class="result-code">${s.BusStopCode}</span>
        <span class="result-name">${favStops.has(s.BusStopCode) ? '<span class="fav-mark">★</span> ' : ''}${escHtml(s.Description)}</span>
        <span class="result-road">${escHtml(s.RoadName)}</span>
      </div>`).join('');

    results.classList.remove('hidden');
  });

  function dismissResults() {
    input.value = '';
    clearBtn.classList.add('hidden');
    results.classList.add('hidden');
    input.blur();
  }

  results.addEventListener('click', e => {
    const postalItem = e.target.closest('.result-postal');
    if (postalItem) {
      const postal = postalItem.dataset.postal;
      logSearch(input.value.trim(), 'postal');
      dismissResults();
      goToPostalCode(postal);
      return;
    }

    const item = e.target.closest('.result-item');
    if (!item) return;
    const stop = stopByCode.get(item.dataset.code);
    if (!stop) return;

    logSearch(input.value.trim(), 'stop');
    dismissResults();
    selectStop(stop.BusStopCode);
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

// Send the search query to the server for logging (IP is captured server-side).
// Fire-and-forget: never block or break the search flow if logging fails.
function logSearch(query, action) {
  if (!query) return;
  fetch('/api/log-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, action }),
    keepalive: true,
  }).catch(() => { /* ignore logging failures */ });
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
    goToUserLocation({ onError: () => alert('Unable to access your location.') });
  });
}

// Center the map on the user's current position and drop a marker.
function goToUserLocation({ onError } = {}) {
  if (!navigator.geolocation) { onError?.(); return; }

  navigator.geolocation.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      if (userMarker) userMarker.remove();
      userMarker = L.circleMarker([lat, lng], {
        radius: 8,
        fillColor: '#1565c0',
        color: 'white',
        weight: 2.5,
        fillOpacity: 1,
      }).addTo(map).bindPopup('You are here');
      updateNearbyList();
      document.getElementById('nearby-sheet').classList.add('expanded');
      centerInVisibleArea(lat, lng, 17);
    },
    () => onError?.()
  );
}

// ── Postal code lookup ────────────────────────────────────────────────────────
async function goToPostalCode(postal) {
  showLoading(`Finding postal code ${postal}…`);
  try {
    const res = await fetch(`/api/postal?code=${encodeURIComponent(postal)}`);
    const data = await res.json();
    hideLoading();
    if (!res.ok) { alert(data.error || 'Postal code not found.'); return; }

    if (userMarker) userMarker.remove();
    userMarker = L.circleMarker([data.lat, data.lng], {
      radius: 8,
      fillColor: '#1565c0',
      color: 'white',
      weight: 2.5,
      fillOpacity: 1,
    }).addTo(map).bindPopup(data.address || `Postal code ${postal}`);

    updateNearbyList();
    document.getElementById('nearby-sheet').classList.add('expanded');
    centerInVisibleArea(data.lat, data.lng, 17);
  } catch {
    hideLoading();
    alert('Postal code lookup failed. Check your connection.');
  }
}

// ── First-load location prompt ────────────────────────────────────────────────
const LOCATION_PROMPT_KEY = 'locationPromptDismissed';

async function maybePromptForLocation() {
  if (!navigator.geolocation) return;

  // If the browser already granted permission, locate silently — no popup.
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    if (status?.state === 'granted') { goToUserLocation(); return; }
    if (status?.state === 'denied') return;
  } catch { /* Permissions API unsupported — fall through to the popup */ }

  // Don't nag: skip if the user already dismissed the prompt before.
  if (localStorage.getItem(LOCATION_PROMPT_KEY)) return;

  showLocationPrompt();
}

function showLocationPrompt() {
  const prompt = document.getElementById('location-prompt');
  prompt.classList.remove('hidden');

  const close = () => {
    prompt.classList.add('hidden');
    try { localStorage.setItem(LOCATION_PROMPT_KEY, '1'); } catch { /* ignore */ }
  };

  document.getElementById('location-enable').onclick = () => {
    close();
    goToUserLocation();
  };
  document.getElementById('location-skip').onclick = close;
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
