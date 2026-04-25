// ── State ───────────────────────────────────────────────────────────────────
let map, userMarker;
const stopMarkers = new Map(); // BusStopCode → L.Marker
let allStops = [];
const stopByCode = new Map();  // BusStopCode → stop object
let selectedCode = null;
let refreshTimer = null;
let openedFromNearby = false;
let nearbyShowCount = 10;
const NEARBY_INCREMENT = 10;
const NEARBY_MAX = 50;

let currentRouteLayer = null;
let routeServiceNo = null;

// ── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  setupSearch();
  setupLocate();
  setupSheet();
  setupNearbySheet();
  await loadAllStops();
  updateNearbyList();
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

  map.on('moveend zoomend', () => {
    updateMarkersInView();
    updateNearbyList();
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

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadArrivals(code), 30_000);
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
    const isActive = svc.ServiceNo === routeServiceNo;
    return `
      <div class="service-card${isActive ? ' route-active' : ''}" data-service="${escHtml(svc.ServiceNo)}">
        <div class="svc-header">
          <span class="svc-no">${escHtml(svc.ServiceNo)}</span>
          ${dest ? `<span class="svc-dest">${escHtml(dest.toUpperCase())}</span>` : ''}
          ${operatorBadge(svc.Operator)}
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
  document.getElementById('nearby-sheet').classList.remove('expanded');
  document.getElementById('back-btn').classList.toggle('hidden', !openedFromNearby);
  document.getElementById('stop-code-badge').textContent = stop.BusStopCode;
  document.getElementById('stop-name').textContent = stop.Description;
  document.getElementById('stop-road').textContent = stop.RoadName;
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
  clearInterval(refreshTimer);
  selectedCode = null;
  refreshMarkerStyle(null);
  clearRoute();
}

function setupSheet() {
  document.getElementById('close-btn').addEventListener('click', closeSheet);
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (selectedCode) loadArrivals(selectedCode);
  });
  document.getElementById('back-btn').addEventListener('click', () => {
    closeSheet();
    document.getElementById('nearby-sheet').classList.add('expanded');
  });

  // Click a service card → show its route on the map
  document.getElementById('services-list').addEventListener('click', e => {
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
  refreshActiveCard();
}

function refreshActiveCard() {
  document.querySelectorAll('#services-list .service-card').forEach(card => {
    card.classList.toggle('route-active', card.dataset.service === routeServiceNo);
  });
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
    .sort((a, b) => a.d - b.d);

  if (!ranked.length) {
    list.innerHTML = '<div class="nearby-empty">No nearby stops found.</div>';
    return;
  }

  const visible = ranked.slice(0, nearbyShowCount);
  const hasMore = nearbyShowCount < Math.min(ranked.length, NEARBY_MAX);

  list.innerHTML = visible.map(({ s, d }) => `
    <div class="nearby-item" data-code="${s.BusStopCode}">
      <span class="nearby-code">${s.BusStopCode}</span>
      <span class="nearby-name">${escHtml(s.Description)}</span>
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
        updateNearbyList();
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
