# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Singapore bus-arrival web app: a Leaflet map of bus stops with live arrival times, route overlays, nearby-stop ranking, and postal-code search. Plain Express backend + vanilla-JS frontend — **no framework, no build step, no test suite, no linter.**

## Commands

```bash
npm start        # node server.js  (production-style)
npm run dev      # node --watch server.js  (auto-restart on change)
```

- Requires a `.env` file with `LTA_API_KEY` (copy `.env.example`, get a free key from LTA DataMall). Without it, `/api/*` returns HTTP 503 and the UI shows an error with a link to request a key.
- Frontend assets are served statically by Express and are **not** cache-busted — hard-refresh the browser after editing files in `public/` during dev.
- There is nothing to build, lint, or test. "Verifying a change" means running the server and exercising the flow in a browser (geolocation needs `https://` or `localhost`).

## Architecture

### Backend — `server.js` (single file)

The frontend never calls the external APIs directly; everything is proxied through Express because the LTA API requires a secret `AccountKey` header and the third-party services aren't CORS-friendly. Three upstreams:

- **LTA DataMall** (`datamall2.mytransport.sg`) — bus stops, routes, live arrivals. Needs `AccountKey`.
- **OneMap** (`onemap.gov.sg`) — postal code → lat/lng geocoding. Public, no key.
- **Valhalla** (`valhalla1.openstreetmap.de`, public FOSSGIS instance) — **primary** road-snapper: map-matches the stop sequence to roads with `bus` costing.
- **OSRM** (`router.project-osrm.org`) — **fallback** road-snapper when a Valhalla match looks broken.

Key patterns:
- **In-memory caches with TTLs**, keyed in module-level variables: stops (6h), routes (24h), road-path (7d), postal (30d). A single in-flight promise (`stopsPromise` / `routesPromise`) de-dupes concurrent cold-cache requests.
- **Cache pre-warm on boot** — stops + routes are fetched at startup so the first page load is instant.
- `fetchLta()` does **retry with backoff** and `runPool()` bounds concurrency to ~6 — LTA returns 500s under high parallelism, and its data is paginated 500 records/page (stops ~14 pages, routes ~60 pages).
- **Vercel compatibility**: the file exports `module.exports = app` and only calls `app.listen` when run directly (`require.main === module`). On Vercel it runs as a serverless function instead.
- **Road-path (`fetchRoadPath`)**: builds the road-snapped route line for the map overlay.
  - **Primary — Valhalla map-matching** (`fetchValhallaPath`, `bus` costing, `shape_match: map_snap`). Map-matching fits a road-following line to the stop sequence *without* forcing an exact visit to each stop, so it avoids detour "spurs" and follows only bus-accessible roads. Its length tracks the **authoritative LTA route distance** (`routeRows[last].Distance`, km) to within a few %.
  - **Validation (`isPlausiblePath`)**: a match is trusted only if its endpoints are near the first/last stop, its length ≥ ~85% of the straight-line stop chain, and (when LTA distance is known) within ~0.8–1.35× of it. This catches matches that silently drop a segment (Valhalla occasionally does, e.g. route 48 dir 1).
  - **Fallback — OSRM route + de-spur** (`fetchOsrmPath` → `deSpur`): OSRM forces the line through every stop, which can create out-and-back spurs. `deSpur` splices out a retrace (`overlapFraction`) only when it serves ≤ `MAX_STOPS` stops (`stopsServedBy`); loop routes use stricter `MAX_STOPS=0`/`MAX=800`, point-to-point `MAX_STOPS=1`/`MAX=1500`. A `hairpinCount` safety net discards the de-spur if it made the line kinkier. This whole path only runs when Valhalla fails, so it's rarely exercised.
  - History: the app used to be OSRM-only, and OSRM produced wildly wrong geometry on some routes (route 90 was 53.8km vs the real 16.4km) — the `deSpur`/`hairpinCount` machinery grew to paper over that. Valhalla fixed the root cause; the OSRM heuristics are now just the fallback.

Endpoints: `/api/stops`, `/api/route?service=`, `/api/road-path?service=&direction=`, `/api/arrivals?code=`, `/api/arrivals-batch?codes=A,B,C` (up to 8 stops at once, 20s per-stop cache; powers the "Bus stops" live list), `/api/postal?code=` (6-digit), `/api/log-search` (POST; logs query + client IP via `X-Forwarded-For` to stdout so Vercel captures it).

### Frontend — `public/js/app.js` (single file, vanilla)

One file organized into labeled `// ── Section ──` blocks (State, Favourites, Buski mascot, Boot, Map, Theme, Stops, Markers, Arrivals, Filters, Live vehicles, Bottom sheet, Route overview, Nearby sheet, Search, Geolocation, Postal, Toast, etc.). Follow the existing section structure when adding code.

- **All stops loaded once** into `allStops` and indexed in the `stopByCode` Map; nearby ranking, search, and route lists all read from this in-memory data.
- **Marker rendering is viewport- and zoom-gated**: nothing renders below zoom 15, and only stops within the current bounds are drawn (capped at 120) for performance. Markers are added/removed on `moveend`/`zoomend`.
- **Two bottom sheets**: `#bottom-sheet` (selected stop → arrivals, and the route stop-list view toggled by `.route-mode`) and `#nearby-sheet` ("Bus stops" — a drag-up list with a **Favourites** section then a **Nearby stops** section; `favStops` sort first via `favFirst`). Both are drag/snap interactions implemented by hand (touch + mouse).
- **Arrival cards** (`renderArrivals` → `svcLiveHtml`) lead with a **hero countdown** for `NextBus` + a "then A · B min" line; a **pulsing dot** (`.pdot`) marks live buses (`Monitored === 1`) and scheduled buses are dimmed; a **3-segment crowding bar + word** comes from `Load` (SEA/SDA/LSD). The static half (`.svc-id`: number + operator badge) and the live half (`.svc-live` — countdown, bus-type icon beside the timing, crowding, and a full-width destination row; re-rendered each tick) are split so `tickArrivals` only rewrites `.svc-live`.
- **Filter chips** (`#filter-chips`: All / Saved / Arriving) filter the rendered list client-side via `currentFilter` (no refetch); reset to All on each stop open.
- Tapping a service card calls `showRoute()` — draws a road-snapped polyline + stop dots and the ordered stop list, **and** `updateLiveBuses()` drops rAF-animated bus markers (from each `NextBus` lat/lng) for that service. Live markers are scoped to the active route to keep the map readable; cleared on `clearRoute`/`closeSheet`.
- **"Bus stops" live ETAs**: `#nearby-list` items show inline ETA pills (`nearbyEtaHtml`) fetched in bulk from `/api/arrivals-batch` (`refreshNearbyArrivals`, debounced + 30s interval, paused while collapsed or the tab is hidden).
- **Arrivals auto-refresh** while a stop is open: a 30s server fetch (`ARRIVALS_REFRESH_MS`) plus a 10s local re-render tick (`ARRIVALS_TICK_MS`) that recomputes the "Xm" countdown from the last fetched data (`lastArrivalsData`) without hitting the API. Both pause while the tab is hidden; a `visibilitychange` handler refetches on return.
- **Favourites** (`favStops`, `favServices` Sets) persist in `localStorage` and sort starred items first in the arrivals list, nearby list, and search results. `requestPersistentStorage()` calls `navigator.storage.persist()` on first favourite to reduce eviction.
- **Personality**: a Buski bus mascot (`mascotSvg`) appears only in loading/empty/first-run states; recoverable errors use a `toast()` instead of `alert()`. All new animations sit behind `@media (prefers-reduced-motion: no-preference)`.
- **Glass controls**: the search pill and the top-right control stack (`#map-controls`: theme, custom zoom +/−, locate) use the `.glass` utility (`backdrop-filter`) over the map. Zoom is hand-rolled (`map.zoomIn/Out`), not Leaflet's default control.

### PWA (installable app)

The app is an installable Progressive Web App — "Add to Home Screen" on iOS/Android and installable on desktop Chrome/Edge. No framework or build step; the pieces are plain static files served by `express.static`.

- **`public/manifest.webmanifest`** — name, `theme_color` (`#d32f2f`, matches the `<meta name="theme-color">`), `background_color` (`#fff`), `display: standalone`, and three PNG icons (192/512 `any` + 512 `maskable`). Linked from `index.html`.
- **`public/sw.js`** — service worker, registered from an inline script at the bottom of `index.html`. Caching is strategy-per-route: app shell (html/css/js/icons) is precached + stale-while-revalidate; Leaflet CDN is SWR; map tiles are cache-first with a size cap (`TILE_CACHE_MAX`); `/api/stops`, `/api/route`, `/api/road-path` are network-first with a cache fallback (offline map data); and **live endpoints (`/api/arrivals*`, `/api/postal`, `/api/log-search`) are network-only and never cached** — stale arrival times would be misleading. Bump `CACHE_VERSION` when the precached shell changes.
- **Icons** — generated from the Buski bus mark by `scripts/generate-icons.js` (`npm run icons`, uses `sharp`, a devDependency). There's no build step, so the generated PNGs in `public/icons/` are **committed** and served statically. Re-run the script if the mark changes. `apple-touch-icon` points at the PNG (iOS ignores SVG apple-touch-icons).

### Theming (dark mode)

- All colors are CSS custom properties in `:root` (`public/css/style.css`). Dark values are defined **twice**: under `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` (auto/system) and under `:root[data-theme="dark"]` (forced). When adding a color, add a variable and its dark override rather than hardcoding — hardcoded light colors break dark mode.
- The toggle writes `data-theme` to `<html>` and persists to `localStorage`; an inline script in `<head>` applies it before first paint to avoid a flash.
- Map tiles swap with the theme in JS (`TILE_CONFIG` / `setTiles`): CartoDB Voyager (light) vs **Stadia Alidade Smooth Dark** (dark).

## Deployment (Vercel)

`vercel.json` routes all requests to `server.js` via `@vercel/node` and bundles `public/**` into the function. Set `LTA_API_KEY` in Vercel env vars.

⚠️ **Stadia dark tiles are access-controlled.** They work on `localhost` with no setup, but on a deployed domain they return 401/403 (blank tiles) until that domain is added to the Stadia Maps property allowlist (or an API key is appended to the tile URL).
