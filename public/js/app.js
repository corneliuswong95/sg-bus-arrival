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
let currentFilter = 'all'; // arrivals filter: all | saved | arriving
let nearbyShowCount = 10;
const NEARBY_INCREMENT = 10;
const NEARBY_MAX = 50;
const nearbyArrivals = new Map();  // BusStopCode → Services[] (live ETAs)
let nearbyArrivalsDebounce = null;

let currentRouteLayer = null;
let routeServiceNo = null;
let routeStopHighlight = null; // marker for the stop tapped in the route list

let liveBusLayer = null;
const liveBusMarkers = new Map(); // "ServiceNo#idx" → { marker, raf }

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
  requestPersistentStorage();
}

// Ask the browser to keep our storage even under disk pressure. Called the
// first time the user favourites something (a natural moment for Firefox's
// permission prompt). No-op if already persisted or unsupported.
let persistRequested = false;
async function requestPersistentStorage() {
  if (persistRequested) return;
  persistRequested = true;
  try {
    if (navigator.storage?.persist && navigator.storage.persisted) {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    }
  } catch { /* ignore */ }
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
  setupFilters();
  setupKopi();
  await loadAllStops();
  updateNearbyList();
  maybePromptForLocation();

  // Keep the "Near you" ETAs fresh while the sheet is open and the tab visible.
  setInterval(() => {
    if (nearbyExpanded() && !document.hidden) refreshNearbyArrivals();
  }, ARRIVALS_REFRESH_MS);
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
  setupDoubleTapZoom();

  map.on('moveend zoomend', () => {
    updateMarkersInView();
    updateNearbyList();
  });
}

// Double-tap to zoom on touch. Leaflet's built-in doubleClickZoom keys off
// `dblclick`, which mobile browsers fire unreliably — so detect the double-tap
// by hand and zoom toward the tapped point. preventDefault on the second tap
// suppresses the synthetic mouse dblclick, so we never zoom twice.
function setupDoubleTapZoom() {
  const el = map.getContainer();
  let lastTime = 0, lastXY = null;

  el.addEventListener('touchend', e => {
    // Only single-finger taps (ignore pinch, multi-touch).
    if (e.touches.length || e.changedTouches.length !== 1) { lastTime = 0; return; }
    const t = e.changedTouches[0];
    const now = Date.now();
    const near = lastXY && Math.abs(t.clientX - lastXY.x) < 30 && Math.abs(t.clientY - lastXY.y) < 30;

    if (now - lastTime < 300 && near) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const pt = L.point(t.clientX - rect.left, t.clientY - rect.top);
      map.setZoomAround(map.containerPointToLatLng(pt), map.getZoom() + 1);
      lastTime = 0;   // reset so a third tap doesn't re-trigger
    } else {
      lastTime = now;
      lastXY = { x: t.clientX, y: t.clientY };
    }
  }, { passive: false });
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
  showLoading("Finding Singapore's bus stops…");

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
    const live = card.querySelector('.svc-live');
    if (svc && live) live.innerHTML = svcLiveHtml(svc);
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
    list.innerHTML = '<p class="state-msg">Finding your buses…</p>';
  }

  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.classList.add('spinning');
  try {
    const res = await fetch(`/api/arrivals?code=${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    lastArrivalsData = data;
    renderArrivals(data);
    updateLiveBuses(data);
    document.getElementById('updated-label').textContent =
      'Updated ' + new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    if (!list.children.length || list.querySelector('.state-msg')) {
      list.innerHTML = busyEmptyHtml("Couldn't load arrivals", 'Check your connection — Buski will try again shortly.');
    }
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

function renderArrivals(data) {
  const list = document.getElementById('services-list');
  const all = (data.Services || [])
    .filter(s => s.ServiceNo)
    .sort((a, b) => favFirst(favServices, a.ServiceNo, b.ServiceNo)
                 || compareServiceNo(a.ServiceNo, b.ServiceNo));

  const services = applyServiceFilter(all);
  updateFilterChips(all);

  if (!services.length) {
    list.innerHTML = emptyServicesHtml(all.length);
    return;
  }

  list.innerHTML = services.map(svc => {
    const isActive = svc.ServiceNo === routeServiceNo;
    return `
      <div class="service-card${isActive ? ' route-active' : ''}" data-service="${escHtml(svc.ServiceNo)}">
        <div class="svc-id">
          <span class="svc-no">${escHtml(svc.ServiceNo)}</span>
          ${operatorBadge(svc.Operator)}
        </div>
        <div class="svc-live">${svcLiveHtml(svc)}</div>
        <button class="star-btn${favServices.has(svc.ServiceNo) ? ' starred' : ''}" data-fav-service="${escHtml(svc.ServiceNo)}" aria-label="Favourite bus ${escHtml(svc.ServiceNo)}">${starSvg()}</button>
      </div>`;
  }).join('');
}

// Filter the sorted service list by the active chip.
function applyServiceFilter(services) {
  if (currentFilter === 'saved')    return services.filter(s => favServices.has(s.ServiceNo));
  if (currentFilter === 'arriving') return services.filter(s => { const m = busMins(s.NextBus); return m !== null && m <= 3; });
  return services;
}

function emptyServicesHtml(total) {
  if (total > 0 && currentFilter === 'saved')    return '<p class="state-msg">No starred buses at this stop yet.</p>';
  if (total > 0 && currentFilter === 'arriving') return '<p class="state-msg">Nothing arriving in the next few minutes.</p>';
  return busyEmptyHtml('No buses running here right now.', "Buski will keep watching — pull to refresh in a bit.");
}

// The live (time-sensitive) half of a service card: hero countdown, the "then"
// line, destination and crowding. Re-rendered every tick so minutes count down.
function svcLiveHtml(svc) {
  const nb = svc.NextBus;
  const dest = stopByCode.get(nb?.DestinationCode)?.Description || '';
  const mins = busMins(nb);
  const live = !!nb && Number(nb.Monitored) === 1;

  let hero;
  if (mins === null)     hero = '<span class="eta-none">—</span>';
  else if (mins <= 0)    hero = '<span class="eta-now">Arr</span>';
  else                   hero = `<span class="eta-num">${mins}</span><span class="eta-unit">min</span>`;
  const pulse = (mins !== null && mins > 0 && live) ? '<span class="pdot" title="Live tracking"></span>' : '';
  const typeIcon = busTypeIcon(nb?.Type);

  const rest = [busMins(svc.NextBus2), busMins(svc.NextBus3)]
    .filter(m => m !== null)
    .map(m => (m <= 0 ? 'Arr' : m));
  let subText = '';
  if (mins === null)      subText = 'no timing available';
  else if (rest.length)   subText = `then ${rest.join(' · ')} min`;
  const subHtml = subText ? `<div class="eta-sub">${subText}</div>` : '';

  return `
    <div class="svc-live-main">
      <div class="svc-eta${live ? '' : ' scheduled'}">
        <div class="eta-hero">${hero}${pulse}${typeIcon ? `<span class="type-icon">${typeIcon}</span>` : ''}</div>
        ${subHtml}
      </div>
      <div class="svc-side">${crowdHtml(nb?.Load)}</div>
    </div>
    ${dest ? `<div class="svc-dest-row"><span class="svc-dest">→ ${escHtml(dest)}</span></div>` : ''}`;
}

// Whole minutes until a bus arrives, or null when there's no live estimate.
function busMins(bus) {
  if (!bus?.EstimatedArrival) return null;
  return Math.round((new Date(bus.EstimatedArrival) - Date.now()) / 60_000);
}

// Crowding as a 3-segment bar + colour-coded word from the LTA Load field
// (SEA/SDA/LSD). Colour + text keeps it readable for colour-blind users.
function crowdHtml(load) {
  const map = {
    SEA: { n: 1, cls: 'seats',    word: 'Seats' },
    SDA: { n: 2, cls: 'standing', word: 'Standing' },
    LSD: { n: 3, cls: 'limited',  word: 'Full' },
  };
  const c = map[load];
  if (!c) return '';
  const segs = [1, 2, 3].map(i => `<span class="crowd-seg${i <= c.n ? ' on' : ''}"></span>`).join('');
  return `<div class="crowd ${c.cls}"><span class="crowd-bar" role="img" aria-label="Crowding: ${c.word}">${segs}</span><span class="crowd-word">${c.word}</span></div>`;
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
    // Head-on front view: a destination blind + two stacked windscreen rows read
    // as "two decks" far more clearly than a side silhouette at this small size.
    return `<svg class="type-icon" width="17.5" height="20" viewBox="0 0 21 24" xmlns="http://www.w3.org/2000/svg" aria-label="Double-decker">
      <!-- wheels (drawn first so they peek out below the body) -->
      <circle cx="6"  cy="20.6" r="2" fill="currentColor"/>
      <circle cx="15" cy="20.6" r="2" fill="currentColor"/>
      <!-- body -->
      <rect x="3" y="1.4" width="15" height="19" rx="2.8" fill="currentColor"/>
      <!-- destination blind -->
      <rect x="5" y="2.7" width="11" height="1.5" rx="0.5" fill="#fff" opacity="0.9"/>
      <!-- upper deck window -->
      <rect x="4.4" y="4.9"  width="12.2" height="4.5" rx="1.1" fill="#fff"/>
      <!-- lower deck windscreen -->
      <rect x="4.4" y="10.9" width="12.2" height="4.3" rx="1.1" fill="#fff"/>
      <!-- headlights -->
      <circle cx="6.2"  cy="17.8" r="1.15" fill="#fff"/>
      <circle cx="14.8" cy="17.8" r="1.15" fill="#fff"/>
    </svg>`;
  }
  if (type === 'BD') {
    // Side view — the only angle where the articulated "bendy" length reads.
    // Two rounded coaches joined by a ribbed bellows; ribbon-glass windows and
    // hubless wheels match the double-decker's style.
    return `<svg class="type-icon" width="30" height="16" viewBox="0 0 34 18" xmlns="http://www.w3.org/2000/svg" aria-label="Bendy bus">
      <!-- wheels (2 per coach, drawn first so they peek out below) -->
      <circle cx="5.5"  cy="14.6" r="1.9" fill="currentColor"/>
      <circle cx="12"   cy="14.6" r="1.9" fill="currentColor"/>
      <circle cx="22"   cy="14.6" r="1.9" fill="currentColor"/>
      <circle cx="28.5" cy="14.6" r="1.9" fill="currentColor"/>
      <!-- rear + front coach bodies -->
      <rect x="1"    y="2.6" width="14.5" height="11" rx="2.4" fill="currentColor"/>
      <rect x="18.5" y="2.6" width="14.5" height="11" rx="2.4" fill="currentColor"/>
      <!-- articulation bellows -->
      <rect x="15.5" y="3.4" width="3" height="9.4" fill="currentColor"/>
      <line x1="16.2" y1="3.8" x2="16.2" y2="12.4" stroke="#fff" stroke-width="0.5" opacity="0.6"/>
      <line x1="17"   y1="3.8" x2="17"   y2="12.4" stroke="#fff" stroke-width="0.5" opacity="0.6"/>
      <line x1="17.8" y1="3.8" x2="17.8" y2="12.4" stroke="#fff" stroke-width="0.5" opacity="0.6"/>
      <!-- ribbon-glass windows (one band per coach) -->
      <rect x="2.6" y="4.4" width="11"  height="3.9" rx="1.3" fill="#fff"/>
      <rect x="20"  y="4.4" width="9.6" height="3.9" rx="1.3" fill="#fff"/>
      <!-- headlight (front-right) -->
      <rect x="31.6" y="10.6" width="1.3" height="1.5" rx="0.3" fill="#fff"/>
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

// ── Filters (All / Saved / Arriving chips) ────────────────────────────────────
function setupFilters() {
  document.getElementById('filter-chips').addEventListener('click', e => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    currentFilter = chip.dataset.filter;
    syncFilterChips();
    if (lastArrivalsData) renderArrivals(lastArrivalsData);
  });
}

function syncFilterChips() {
  document.querySelectorAll('#filter-chips .filter-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === currentFilter);
  });
}

// Called each render; keeps the chip highlight in sync with the active filter.
function updateFilterChips() {
  syncFilterChips();
}

// ── Live vehicles ─────────────────────────────────────────────────────────────
// The LTA arrivals payload carries each incoming bus's live lat/lng. When a
// route is shown, drop a marker for that service's monitored buses and glide
// them toward the stop between 30s refreshes. Scoped to the active route so the
// map stays readable (all services at once would be dozens of markers).
function updateLiveBuses(data) {
  if (!map) return;
  if (!routeServiceNo) { clearLiveBuses(); return; }
  if (!liveBusLayer) liveBusLayer = L.layerGroup().addTo(map);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seen = new Set();

  (data?.Services || [])
    .filter(svc => svc.ServiceNo === routeServiceNo)
    .forEach(svc => {
      [svc.NextBus, svc.NextBus2, svc.NextBus3].forEach((bus, idx) => {
        const lat = parseFloat(bus?.Latitude), lng = parseFloat(bus?.Longitude);
        if (!bus || Number(bus.Monitored) !== 1) return;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return;
        const key = `${svc.ServiceNo}#${idx}`;
        seen.add(key);
        const loadCls = { SEA: 'seats', SDA: 'standing', LSD: 'limited' }[bus.Load] || '';
        let entry = liveBusMarkers.get(key);
        if (!entry) {
          const marker = L.marker([lat, lng], {
            icon: makeBusIcon(svc.ServiceNo, loadCls),
            zIndexOffset: 600,
            interactive: false,
            keyboard: false,
          }).addTo(liveBusLayer);
          liveBusMarkers.set(key, { marker });
        } else {
          entry.marker.setIcon(makeBusIcon(svc.ServiceNo, loadCls));
          if (reduce) entry.marker.setLatLng([lat, lng]);
          else animateMarkerTo(entry, [lat, lng]);
        }
      });
    });

  for (const [key, entry] of liveBusMarkers) {
    if (!seen.has(key)) {
      if (entry.raf) cancelAnimationFrame(entry.raf);
      liveBusLayer.removeLayer(entry.marker);
      liveBusMarkers.delete(key);
    }
  }
}

function makeBusIcon(serviceNo, loadCls) {
  return L.divIcon({
    className: '',
    html: `<div class="live-bus ${loadCls}"><span class="live-bus-no">${escHtml(serviceNo)}</span></div>`,
    iconSize: [30, 22],
    iconAnchor: [15, 11],
  });
}

// Smoothly interpolate a marker from its current position to `to` with rAF.
function animateMarkerTo(entry, to) {
  const from = entry.marker.getLatLng();
  const start = performance.now();
  const dur = 900;
  if (entry.raf) cancelAnimationFrame(entry.raf);
  const step = now => {
    const t = Math.min(1, (now - start) / dur);
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
    entry.marker.setLatLng([
      from.lat + (to[0] - from.lat) * e,
      from.lng + (to[1] - from.lng) * e,
    ]);
    if (t < 1) entry.raf = requestAnimationFrame(step);
  };
  entry.raf = requestAnimationFrame(step);
}

function clearLiveBuses() {
  for (const [, entry] of liveBusMarkers) {
    if (entry.raf) cancelAnimationFrame(entry.raf);
    if (liveBusLayer) liveBusLayer.removeLayer(entry.marker);
  }
  liveBusMarkers.clear();
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

// FLIP-animate the map controls as they reflow between the vertical stack (no
// stop selected) and the horizontal search-bar-level row (stop selected). The
// layout switch itself is CSS (:has(#bottom-sheet.open)); `apply` performs the
// DOM change that triggers it, and we animate each button from its old position
// to its new one so it visibly flows to the top and back. Desktop only.
let controlsFlipTimer = null;
function animateControlsReflow(apply) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (window.innerWidth < 600 || reduce) { apply(); return; }

  // Animate each pill as a unit. The zoom group reshapes (tall↔wide) rather
  // than just moving, so translate by centre delta to keep it anchored.
  const els = [
    document.getElementById('theme-toggle'),
    document.querySelector('.zoom-group'),
    document.getElementById('locate-btn'),
  ].filter(Boolean);
  const centre = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const first = els.map(el => centre(el.getBoundingClientRect()));

  apply();

  const last = els.map(el => centre(el.getBoundingClientRect()));
  els.forEach((el, i) => {
    const dx = first[i].x - last[i].x;
    const dy = first[i].y - last[i].y;
    el.style.transition = 'none';
    el.style.transform = (dx || dy) ? `translate(${dx}px, ${dy}px)` : '';
  });

  // Force a reflow so the inverted (start) position is committed before we
  // animate back to identity — otherwise the browser may skip the transition.
  void document.getElementById('map-controls').offsetWidth;

  els.forEach(el => {
    el.style.transition = 'transform .42s cubic-bezier(.32,.72,0,1)';
    el.style.transform = '';
  });

  // Drop the inline styles once settled so they don't fight :active / spinner.
  clearTimeout(controlsFlipTimer);
  controlsFlipTimer = setTimeout(() => {
    els.forEach(el => { el.style.transition = ''; el.style.transform = ''; });
  }, 500);
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
  currentFilter = 'all';
  syncFilterChips();
  const sheet = document.getElementById('bottom-sheet');
  animateControlsReflow(() => sheet.classList.add('open'));
  // Default to mid snap on open (only on mobile-style stack layout)
  if (window.innerWidth < 600) {
    requestAnimationFrame(() => setSheetOffset(getSheetSnaps().mid));
  } else {
    sheet.style.transform = '';
  }
}

function closeSheet() {
  const sheet = document.getElementById('bottom-sheet');
  animateControlsReflow(() => sheet.classList.remove('open'));
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
    if (document.hidden) return;
    if (selectedCode) loadArrivals(selectedCode);
    if (nearbyExpanded()) refreshNearbyArrivals();
  });
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (selectedCode) loadArrivals(selectedCode);
  });
  document.getElementById('fav-stop-btn').addEventListener('click', () => {
    if (!selectedCode) return;
    toggleFav(favStops, 'favStops', selectedCode);
    const starred = favStops.has(selectedCode);
    document.getElementById('fav-stop-btn').classList.toggle('starred', starred);
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
    if (!s) return;
    // Highlight the tapped row and drop a marker so it's clear which stop it is
    document.querySelectorAll('#route-stops .route-stop.sel').forEach(el => el.classList.remove('sel'));
    row.classList.add('sel');
    highlightRouteStop(s);
    panMapToStop(s);
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
    removeRouteStopHighlight();

    // Draw the straight stop-to-stop line immediately so the route shows up
    // instantly, then upgrade it to the road-snapped geometry once that fetch
    // returns (can take ~1s on a cold cache). Avoids a blank "Loading" wait.
    const line = L.polyline(coords, {
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

    // Drop live vehicle markers for this service right away.
    updateLiveBuses(lastArrivalsData);

    // Re-render arrivals to highlight the active card
    refreshActiveCard();

    // Show the ordered stop list for this service in the sheet
    renderRouteStops(chosen, serviceNo);

    // Fit map to route bounds with padding for the bottom sheet
    const isMobile = window.innerWidth < 600;
    map.fitBounds(line.getBounds(), {
      paddingTopLeft: [20, 80],
      paddingBottomRight: [20, isMobile ? 360 : 60],
    });

    label.textContent = `Clear route ${serviceNo}`;

    // Upgrade the straight line to road-snapped geometry when it arrives. Bail
    // if the user switched to another route (or cleared) while it was loading.
    try {
      const direction = chosen[0]?.Direction || 1;
      const r = await fetch(`/api/road-path?service=${encodeURIComponent(serviceNo)}&direction=${direction}`);
      if (r.ok && routeServiceNo === serviceNo) {
        const data = await r.json();
        if (data.coordinates?.length) {
          line.setLatLngs(data.coordinates.map(([lng, lat]) => [lat, lng]));
        }
      }
    } catch { /* keep the straight line */ }
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
  removeRouteStopHighlight();
  clearLiveBuses();
  routeServiceNo = null;
  document.getElementById('clear-route-btn').classList.add('hidden');
  exitRouteMode();
  refreshActiveCard();
}

// Drop/move a prominent marker on the stop tapped in the route list, with an
// open label so it's obvious which stop was selected.
function highlightRouteStop(stop) {
  const lat = +stop.Latitude, lng = +stop.Longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  removeRouteStopHighlight();
  routeStopHighlight = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: '<div class="route-stop-pin"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
    zIndexOffset: 1000,
  })
    .addTo(map)
    .bindTooltip(`${stop.BusStopCode} · ${stop.Description}`, { direction: 'top', offset: [0, -9] })
    .openTooltip();
}

function removeRouteStopHighlight() {
  if (routeStopHighlight) {
    routeStopHighlight.remove();
    routeStopHighlight = null;
  }
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
    const isHere = i === curIdx;
    return `
      <div class="route-stop ${cls}" data-code="${escHtml(r.BusStopCode)}">
        <span class="rs-track"><span class="rs-dot"></span></span>
        <span class="rs-info">
          <span class="rs-name">${escHtml(name)}</span>
          <span class="rs-road">${isHere ? '<span class="rs-here">You are here</span>' : escHtml(road)}</span>
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
    if (nearbyExpanded()) scheduleNearbyArrivals();
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
    if (nearbyExpanded()) scheduleNearbyArrivals();
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

  const favItems  = visible.filter(({ s }) => favStops.has(s.BusStopCode));
  const restItems = visible.filter(({ s }) => !favStops.has(s.BusStopCode));

  const itemHtml = ({ s, d }) => `
    <div class="nearby-item" data-code="${s.BusStopCode}">
      <div class="ni-top">
        <span class="nearby-code">${s.BusStopCode}</span>
        <div class="ni-main">
          <span class="nearby-name">${favStops.has(s.BusStopCode) ? '<span class="fav-mark">★</span> ' : ''}${escHtml(s.Description)}</span>
          <span class="nearby-road">${escHtml(s.RoadName)}</span>
        </div>
        <span class="nearby-distance">${formatDistance(d)}</span>
      </div>
      <div class="nearby-eta">${nearbyEtaHtml(nearbyArrivals.get(s.BusStopCode))}</div>
    </div>`;

  let html = '';
  if (favItems.length) {
    html += `<div class="nearby-section-label">Favourites</div>`;
    html += favItems.map(itemHtml).join('');
  }
  if (restItems.length) {
    if (favItems.length) html += `<div class="nearby-section-label">Nearby stops</div>`;
    html += restItems.map(itemHtml).join('');
  }
  if (hasMore) html += `<button id="load-more-btn" type="button">Load more</button>`;

  list.innerHTML = html;

  if (nearbyExpanded()) scheduleNearbyArrivals();
}

// ── Near you: live ETAs in the nearby list ────────────────────────────────────
function nearbyExpanded() {
  return document.getElementById('nearby-sheet').classList.contains('expanded');
}

// Compact ETA pills for a stop: up to 3 soonest services (number + minutes).
function nearbyEtaHtml(services) {
  if (!services) return '';
  const rows = services
    .filter(s => s.ServiceNo && s.NextBus?.EstimatedArrival)
    .map(s => ({ no: s.ServiceNo, mins: busMins(s.NextBus), load: s.NextBus.Load }))
    .filter(r => r.mins !== null)
    .sort((a, b) => a.mins - b.mins)
    .slice(0, 3);
  if (!rows.length) return '<span class="ne-none">No buses right now</span>';
  return rows.map(r => {
    const loadCls = { SEA: 'seats', SDA: 'standing', LSD: 'limited' }[r.load] || '';
    const t = r.mins <= 0 ? 'Arr' : `${r.mins}m`;
    return `<span class="ne-pill ${loadCls}"><span class="ne-no">${escHtml(r.no)}</span><span class="ne-min">${t}</span></span>`;
  }).join('');
}

function scheduleNearbyArrivals() {
  clearTimeout(nearbyArrivalsDebounce);
  nearbyArrivalsDebounce = setTimeout(refreshNearbyArrivals, 350);
}

// Fetch live arrivals for the visible nearby stops (batched) and inject the ETA
// pills in place — no full re-render, so the list doesn't jump. Paused while the
// sheet is closed or the tab is hidden.
async function refreshNearbyArrivals() {
  if (!nearbyExpanded() || document.hidden) return;
  const items = [...document.querySelectorAll('#nearby-list .nearby-item')].slice(0, 8);
  const codes = items.map(el => el.dataset.code).filter(Boolean);
  if (!codes.length) return;

  try {
    const res = await fetch(`/api/arrivals-batch?codes=${encodeURIComponent(codes.join(','))}`);
    if (!res.ok) return;
    const data = await res.json();
    for (const [code, services] of Object.entries(data)) nearbyArrivals.set(code, services);
    document.querySelectorAll('#nearby-list .nearby-item').forEach(el => {
      const eta = el.querySelector('.nearby-eta');
      if (eta && nearbyArrivals.has(el.dataset.code)) {
        eta.innerHTML = nearbyEtaHtml(nearbyArrivals.get(el.dataset.code));
      }
    });
  } catch { /* keep whatever ETAs we already have */ }
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
    goToUserLocation({ onError: () => toast("Couldn't get your location. Check location access and try again.") });
  });

  // Drop the "active" (filled) state once the user drags away from their dot.
  // dragstart only fires on manual pans, not our programmatic recenter.
  map.on('dragstart', () => document.getElementById('locate-btn').classList.remove('located'));

  // Custom zoom buttons (replaces Leaflet's default control so they live in
  // the same glass stack as the theme/locate buttons).
  document.getElementById('zoom-in').addEventListener('click', () => map.zoomIn());
  document.getElementById('zoom-out').addEventListener('click', () => map.zoomOut());
}

// A pulsing "you are here" dot. Shared so locate always renders the same marker.
function setUserMarker(lat, lng, popupText) {
  if (userMarker) userMarker.remove();
  userMarker = L.marker([lat, lng], {
    keyboard: false,
    icon: L.divIcon({
      className: 'user-loc',
      html: '<span class="user-loc-pulse"></span><span class="user-loc-dot"></span>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
  }).addTo(map).bindPopup(popupText);
}

// Center the map on the user's current position and drop a marker.
function goToUserLocation({ onError } = {}) {
  const btn = document.getElementById('locate-btn');
  if (!navigator.geolocation) { onError?.(); return; }
  if (btn.classList.contains('locating')) return;   // ignore taps while acquiring

  btn.classList.add('locating');
  btn.setAttribute('aria-busy', 'true');
  const done = () => { btn.classList.remove('locating'); btn.removeAttribute('aria-busy'); };

  navigator.geolocation.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      // Remember the grant so returning users can be located silently even on
      // browsers that don't expose the permission state (e.g. iOS Safari).
      try { localStorage.setItem(LOCATION_GRANTED_KEY, '1'); } catch { /* ignore */ }
      done();
      btn.classList.add('located');
      setUserMarker(lat, lng, 'You are here');
      updateNearbyList();
      document.getElementById('nearby-sheet').classList.add('expanded');
      centerInVisibleArea(lat, lng, 17);
    },
    () => {
      // Permission revoked/denied — forget the grant so we stop auto-locating.
      try { localStorage.removeItem(LOCATION_GRANTED_KEY); } catch { /* ignore */ }
      done();
      onError?.();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

// ── Postal code lookup ────────────────────────────────────────────────────────
async function goToPostalCode(postal) {
  showLoading(`Finding postal code ${postal}…`);
  try {
    const res = await fetch(`/api/postal?code=${encodeURIComponent(postal)}`);
    const data = await res.json();
    hideLoading();
    if (!res.ok) { toast(data.error || "Couldn't find that postal code."); return; }

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
    toast('Postal lookup failed — check your connection.');
  }
}

// ── First-load location prompt ────────────────────────────────────────────────
const LOCATION_PROMPT_KEY = 'locationPromptDismissed';
const LOCATION_GRANTED_KEY = 'locationGranted';

async function maybePromptForLocation() {
  if (!navigator.geolocation) return;

  // Query the permission state where we can. iOS Safari (and some others) don't
  // support querying 'geolocation', so this throws — permState stays null.
  let permState = null;
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    permState = status?.state ?? null;
  } catch { /* Permissions API unsupported for geolocation */ }

  // If the browser already granted permission, locate silently — no popup.
  if (permState === 'granted') { goToUserLocation(); return; }
  if (permState === 'denied') return;

  // permState is null (can't query) or 'prompt'. When we can't query but the
  // user granted location in a past session, the grant persists across reloads —
  // locate silently instead of re-showing the prompt.
  if (permState === null && localStorage.getItem(LOCATION_GRANTED_KEY)) {
    goToUserLocation();
    return;
  }

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

// ── Toast ────────────────────────────────────────────────────────────────────
// Small non-blocking status pill (replaces alert() for recoverable errors).
let toastTimer = null;
function toast(msg, ms = 3400) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 260);
  }, ms);
}

// ── Buy Buski a kopi (support) ───────────────────────────────────────────────
// To enable: fill in KOPI below, then export your PayNow QR from your banking
// app (e.g. DBS/PayLah, OCBC, UOB → "PayNow QR" / "Save QR") and save it to
// public/img/paynow-qr.png. A bank-made image is guaranteed valid and shows your
// verified name to donors. The id below is shown as a tap-to-copy fallback.
const KOPI = {
  name:      'Cornelius',          // whose PayNow — shown as "Paying to …"
  payNowId:  '+65 8830 5396',      // your PayNow mobile no. or UEN (display; copied digits-only)
  qrImage:   '/img/paynow-qr.png', // exported PayNow QR image
  coffeeUrl: '',                   // optional Buy Me a Coffee / Ko-fi URL ('' hides the link)
};

function setupKopi() {
  const modal = document.getElementById('kopi-modal');
  const btn = document.getElementById('kopi-btn');
  if (!modal || !btn) return;

  // Fill the static bits from config.
  document.getElementById('kopi-mascot').innerHTML = mascotSvg(74);
  document.getElementById('kopi-id-val').textContent = KOPI.payNowId;
  document.getElementById('kopi-name').textContent = KOPI.name;

  const qr = document.getElementById('kopi-qr');
  qr.src = KOPI.qrImage;
  // No QR image yet → show the "add it here" hint instead of a broken image.
  qr.onerror = () => {
    qr.classList.add('hidden');
    document.getElementById('kopi-qr-fallback').classList.remove('hidden');
  };

  if (KOPI.coffeeUrl) {
    const coffee = document.getElementById('kopi-coffee');
    coffee.href = KOPI.coffeeUrl;
    coffee.classList.remove('hidden');
  }

  const open = () => modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  btn.addEventListener('click', open);
  document.getElementById('kopi-close').addEventListener('click', close);
  // Tap the dimmed backdrop (outside the card) to dismiss.
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  // Tap the PayNow id to copy it — handy on desktop where you can't scan.
  document.getElementById('kopi-id').addEventListener('click', async () => {
    const clean = KOPI.payNowId.replace(/\s+/g, '');  // digits paste cleanly into bank apps
    try {
      await navigator.clipboard.writeText(clean);
      toast('PayNow copied — thank you! ☕');
    } catch {
      toast(`PayNow: ${clean}`);
    }
  });
}

// ── Buski mascot ─────────────────────────────────────────────────────────────
// A friendly red bus, shown only in loading / empty / first-run states — never
// in the arrival glance.
function mascotSvg(size = 96) {
  return `<svg class="buski-mascot" width="${size}" height="${size}" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="48" cy="87" rx="25" ry="4" fill="rgba(0,0,0,.08)"/>
    <rect x="16" y="40" width="4" height="11" rx="2" fill="var(--red)"/>
    <rect x="76" y="40" width="4" height="11" rx="2" fill="var(--red)"/>
    <rect x="18" y="20" width="60" height="50" rx="13" fill="var(--red)"/>
    <rect x="24" y="29" width="21" height="17" rx="4.5" fill="#fff"/>
    <rect x="51" y="29" width="21" height="17" rx="4.5" fill="#fff"/>
    <circle cx="35" cy="38" r="3.4" fill="var(--red)"/>
    <circle cx="62" cy="38" r="3.4" fill="var(--red)"/>
    <path d="M40 56 q8 6.5 16 0" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/>
    <rect x="27" y="67" width="11" height="8" rx="3" fill="#3a3a3a"/>
    <rect x="58" y="67" width="11" height="8" rx="3" fill="#3a3a3a"/>
  </svg>`;
}

// Friendly empty/error block with the mascot.
function busyEmptyHtml(title, sub) {
  return `<div class="empty-state">${mascotSvg(84)}<p class="empty-title">${escHtml(title)}</p>${sub ? `<p class="empty-sub">${escHtml(sub)}</p>` : ''}</div>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
