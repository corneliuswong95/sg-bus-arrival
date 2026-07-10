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
- **OSRM** (`router.project-osrm.org`) — snaps route polylines to actual roads.

Key patterns:
- **In-memory caches with TTLs**, keyed in module-level variables: stops (6h), routes (24h), road-path (7d), postal (30d). A single in-flight promise (`stopsPromise` / `routesPromise`) de-dupes concurrent cold-cache requests.
- **Cache pre-warm on boot** — stops + routes are fetched at startup so the first page load is instant.
- `fetchLta()` does **retry with backoff** and `runPool()` bounds concurrency to ~6 — LTA returns 500s under high parallelism, and its data is paginated 500 records/page (stops ~14 pages, routes ~60 pages).
- **Vercel compatibility**: the file exports `module.exports = app` and only calls `app.listen` when run directly (`require.main === module`). On Vercel it runs as a serverless function instead.
- **Road-path spur removal (`deSpur`)**: OSRM's `route` service forces the polyline through every stop coordinate, so a stop that snaps to a driveway/service road/opposite carriageway produces an out-and-back "spur" (two parallel lines with a hairpin). `deSpur` splices out an excursion only when it's a genuine retrace (`overlapFraction` — outbound and inbound legs overlap) **and** it serves ≤1 stop (`stopsServedBy`). The stop test distinguishes a one-stop artifact from a legitimate there-and-back that serves several stops. **Loop services** (first stop == last stop, e.g. 90/62) are there-and-back by design and geometrically indistinguishable from spurs, so `fetchRoadPath` skips de-spurring for them and serves the faithful OSRM line — meaning loop routes may still show minor spurs. This is deliberate: better a faithful-but-spurred loop than a corrupted one.

Endpoints: `/api/stops`, `/api/route?service=`, `/api/road-path?service=&direction=`, `/api/arrivals?code=`, `/api/postal?code=` (6-digit), `/api/log-search` (POST; logs query + client IP via `X-Forwarded-For` to stdout so Vercel captures it).

### Frontend — `public/js/app.js` (single file, vanilla)

One file organized into labeled `// ── Section ──` blocks (State, Boot, Map, Theme, Stops, Markers, Arrivals, Bottom sheet, Route overview, Nearby sheet, Search, Geolocation, Postal, etc.). Follow the existing section structure when adding code.

- **All stops loaded once** into `allStops` and indexed in the `stopByCode` Map; nearby ranking, search, and route lists all read from this in-memory data.
- **Marker rendering is viewport- and zoom-gated**: nothing renders below zoom 15, and only stops within the current bounds are drawn (capped at 120) for performance. Markers are added/removed on `moveend`/`zoomend`.
- **Two bottom sheets**: `#bottom-sheet` (selected stop → arrivals, and the route stop-list view toggled by `.route-mode`) and `#nearby-sheet` (drag-up list of nearest stops). Both are drag/snap interactions implemented by hand (touch + mouse).
- Tapping a service card calls `showRoute()` — draws a road-snapped polyline + stop dots on the map and renders the full ordered stop list (passed / current / upcoming) in the sheet.
- **Arrivals auto-refresh** while a stop is open: a 30s server fetch (`ARRIVALS_REFRESH_MS`) plus a 10s local re-render tick (`ARRIVALS_TICK_MS`) that recomputes the "Xm" countdown from the last fetched data (`lastArrivalsData`) without hitting the API. Both pause while the tab is hidden; a `visibilitychange` handler refetches on return.
- **Favourites** (`favStops`, `favServices` Sets) persist in `localStorage` and sort starred items first in the arrivals list, nearby list, and search results. `requestPersistentStorage()` calls `navigator.storage.persist()` on first favourite to reduce eviction.

### Theming (dark mode)

- All colors are CSS custom properties in `:root` (`public/css/style.css`). Dark values are defined **twice**: under `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` (auto/system) and under `:root[data-theme="dark"]` (forced). When adding a color, add a variable and its dark override rather than hardcoding — hardcoded light colors break dark mode.
- The toggle writes `data-theme` to `<html>` and persists to `localStorage`; an inline script in `<head>` applies it before first paint to avoid a flash.
- Map tiles swap with the theme in JS (`TILE_CONFIG` / `setTiles`): CartoDB Voyager (light) vs **Stadia Alidade Smooth Dark** (dark).

## Deployment (Vercel)

`vercel.json` routes all requests to `server.js` via `@vercel/node` and bundles `public/**` into the function. Set `LTA_API_KEY` in Vercel env vars.

⚠️ **Stadia dark tiles are access-controlled.** They work on `localhost` with no setup, but on a deployed domain they return 401/403 (blank tiles) until that domain is added to the Stadia Maps property allowlist (or an API key is appended to the tile URL).
