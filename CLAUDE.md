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
- **"Your buses" board** (`#next-board` / `renderNextBoard`): the stop's **favourited services** (`favServices`), soonest first (≤4), as amber LED rows (route bullet + destination blind + big Doto countdown). Shown **only** when the stop has ≥1 favourited service — hidden entirely otherwise (and in `route-mode`). Re-run by `renderArrivals`/`tickArrivals`, so it appears/updates the instant you star a service.
- **Arrival cards** (`renderArrivals` → `svcLiveHtml`): a static half (`.svc-id` = `.svc-no` + neutral `operatorBadge`) and a live half (`.svc-live`, re-rendered each tick by `tickArrivals`, which also refreshes the hero board). The live half is `.svc-mid` (condensed destination blind + `busTypeIcon` double-decker/bendy glyph + 3-segment crowding bar from `Load` SEA/SDA/LSD → `seats`/`standing`/`limited`) beside `.svc-r` (a **pulsing dot** `.pdot` for live `Monitored===1`, an amber **LED time chip** `.led-chip` with `.now`/`.sched`/`.none` variants, and a `then A · B min` line).
- **Filter chips** (`#filter-chips`: All / Saved / Arriving) filter the rendered list client-side via `currentFilter` (no refetch); reset to All on each stop open.
- Tapping a service card calls `showRoute()` — draws a road-snapped polyline + stop dots and the ordered stop list, **and** `updateLiveBuses()` drops rAF-animated bus markers (from each `NextBus` lat/lng) for that service. Live markers are scoped to the active route to keep the map readable; cleared on `clearRoute`/`closeSheet`.
- **Route journey-time estimate**: `renderRouteStops` shows a running `~Xm` beside each downstream stop (cumulative from the current stop, `.rs-eta`) plus `~N min left` in the header. LTA publishes no travel time, so it's derived from the cumulative per-stop `Distance` via `busEtaMins(km)` ÷ `AVG_BUS_SPEED_KMH` (~20 km/h, tunable) — always shown with a `~`. Passed/current stops show none (non-positive distance delta → `busEtaMins` returns 0).
- **"Bus stops" live ETAs**: `#nearby-list` items show inline ETA pills (`nearbyEtaHtml`) fetched in bulk from `/api/arrivals-batch` (`refreshNearbyArrivals`, debounced + 30s interval, paused while collapsed or the tab is hidden). All of a stop's services render in a horizontal, swipeable scroller (`.nearby-eta`, no wrap); favourited services (`favServices`) sort first via `favFirst`, then by soonest arrival, and get a yellow-rim + star `.fav` marker. The **Favourites** section renders inside one glowing `.fav-group` tray (so any number of saved stops stays crisp — per-card glows bled together).
- **Arrivals auto-refresh** while a stop is open: a 30s server fetch (`ARRIVALS_REFRESH_MS`) plus a 10s local re-render tick (`ARRIVALS_TICK_MS`) that recomputes the "Xm" countdown from the last fetched data (`lastArrivalsData`) without hitting the API. Both pause while the tab is hidden; a `visibilitychange` handler refetches on return.
- **Favourites** (`favStops`, `favServices` Sets) persist in `localStorage` and sort starred items first in the arrivals list, nearby list, and search results. `requestPersistentStorage()` calls `navigator.storage.persist()` on first favourite to reduce eviction.
- **Personality**: the Buski **blind-bus** mark — a bus front with an amber dot-matrix destination blind, themed via the `--ic-*` vars — appears in loading/empty/first-run states and as the top-left brand chip; recoverable errors use a `toast()` instead of `alert()`. All animations sit behind `@media (prefers-reduced-motion: no-preference)`.
- **Glass controls**: the search pill, the top-left **brand chip** (`#brand` — blind-bus mark + dot-matrix `buski` wordmark), and the top-right control stack (`#map-controls`: theme, hand-rolled zoom +/−, locate, and the Buy-me-a-coffee `#kopi-btn`) use the `.glass` utility (`backdrop-filter`) with an orange-tinted rim over the map. Note: `.map-btn.glass` re-asserts that border because plain `.map-btn` sets `border:none`.

### PWA (installable app)

The app is an installable Progressive Web App — "Add to Home Screen" on iOS/Android and installable on desktop Chrome/Edge. No framework or build step; the pieces are plain static files served by `express.static`.

- **`public/manifest.webmanifest`** — name, `theme_color`/`background_color` (`#0c0705`, the dark board), `display: standalone`, and three PNG icons (192/512 `any` + 512 `maskable`). `index.html` sets **two** media-based `<meta name="theme-color">` (paper `#fcf7ef` in light, board `#0c0705` in dark).
- **`public/sw.js`** — service worker, registered from an inline script at the bottom of `index.html`. Caching is strategy-per-route: app shell (html/css/js/icons) is precached + stale-while-revalidate; Leaflet CDN is SWR; map tiles are cache-first with a size cap (`TILE_CACHE_MAX`); `/api/stops`, `/api/route`, `/api/road-path` are network-first with a cache fallback (offline map data); and **live endpoints (`/api/arrivals*`, `/api/postal`, `/api/log-search`) are network-only and never cached** — stale arrival times would be misleading. Bump `CACHE_VERSION` when the precached shell changes.
- **Icons** — generated from the Buski **blind-bus** mark (dark tile, orange-framed bus, amber dot-matrix blind) by `scripts/generate-icons.js` (`npm run icons`, uses `sharp`, a devDependency). There's no build step, so the generated PNGs in `public/icons/` are **committed** and served statically. Re-run the script if the mark changes. `apple-touch-icon` points at the PNG (iOS ignores SVG apple-touch-icons).
- **Social card (`public/og.png`)** — the 1200×630 link-preview image (`og:image` / `twitter:image` in `index.html`) is drawn in the "Amber overdrive" board style: void + neon grid/scanlines/glow, Doto `Buski` wordmark, the blind-bus tile, and a glowing neon "NEXT BUSES" departure board. Generated by `scripts/generate-og.js` (`npm run og`), which renders the self-contained `scripts/og-template.html` (Doto + Archivo from Google Fonts) with **headless Google Chrome** at 2× and downscales to 1200×630 with `sharp`. Like the icons, the PNG is **committed** and served statically; re-run after editing the template. Requires Chrome/Chromium (set `CHROME_BIN` if it's not in a standard path). ⚠️ Social platforms cache the preview **by image URL**, and the filename never changes — so when you ship a new card, **bump the `?v=N` query** on all four `og.png?v=` references in `index.html` (og:image, twitter:image, JSON-LD image + screenshot). That makes it a new URL to every cache; then force a re-scrape (Telegram `@WebpageBot`, Facebook Sharing Debugger, X Card Validator) to pick it up.
- **iOS install coach-mark** (`#install-hint`) — iOS Safari has no `beforeinstallprompt`, so a bottom card (mascot + "Tap Share then Add to Home Screen" with the iOS glyphs + a down-arrow at Safari's share button) teaches the manual flow. In `app.js` under "iOS Add to Home Screen hint": `isIosSafari()` (excludes Chrome/Firefox-on-iOS via CriOS/FxiOS) + `isStandalonePwa()` gate it to iOS Safari sessions not already running as the installed app; shown ~15s after load (`INSTALL_HINT_DELAY_MS`) and re-offered 1 day after each dismissal (`INSTALL_HINT_SNOOZE_MS`; dismissal *timestamp* stored in `localStorage` as `installHintDismissedAt`). Note `isStandalonePwa()` only detects whether the current page is running standalone — Safari can't tell whether a home-screen copy exists, so we snooze rather than suppress forever. `scheduleInstallHint()` runs in boot; it defers behind the first-run location prompt and retries via `retryInstallHintAfterPrompt()` when that closes. The home-screen label comes from manifest `short_name` (Android) and `<meta name="apple-mobile-web-app-title">` (iOS) — both "Buski".

### Visual design & theming — "The Board" (cyberpunk)

The UI is styled after a Singapore bus **destination blind / interchange departure board**. Two web fonts (Google Fonts, linked in `index.html`): **Doto** (variable dot-matrix) for every numeric/LED readout — countdowns, stop codes, ETAs, wordmark — and **Archivo** (condensed grotesque, driven by `font-stretch`) for signage/UI. `-apple-system` is the fallback.

- **Palette** — all colors are CSS custom properties in `:root` (`public/css/style.css`). Warm cyberpunk system: `--neon` (orange) = live system / HUD frames / active; `--amber` + `--panel-num` = arrival data + stop codes (the LED); `--fav` (bright yellow) = favourites; `--seat`/`--stand`/`--full` = crowding (green/amber/red). Reusable token groups: `--panel-*` (the LED readout cell), `--code-*` (stop-code cell), `--ic-*` (the blind-bus logo). Old names (`--red`, `--blue`, `--green`, `--text`, …) are kept as **aliases** — mostly `var()`-based so they follow the theme — so pre-existing markup/inline SVGs still resolve.
- **Two themes**: light **"Amber HUD"** (warm near-white ground, orange-framed HUD cells, scanlines + faint grid) and dark **"Amber overdrive"** (warm near-black void, neon glow). Dark values are defined **twice** — under `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` (auto/system) and `:root[data-theme="dark"]` (forced); only literal overrides are repeated (alias vars resolve lazily). Add a variable + its dark override rather than hardcoding.
- The toggle writes `data-theme` to `<html>` and persists to `localStorage`; an inline `<head>` script applies it before first paint to avoid a flash.
- Map tiles swap with the theme in JS (`TILE_CONFIG` / `setTiles`): CartoDB Voyager (light) vs **Stadia Alidade Smooth Dark** (dark).

> Design history: the app was originally a Material-red, system-font UI; the "Board" cyberpunk redesign (originally branch `redesign/cyberpunk-board`) is now merged and live on `main`, with dark as the default theme. If a color/font looks "off", check it against the token system above, not the old Material palette.

## Deployment (Vercel)

`vercel.json` routes all requests to `server.js` via `@vercel/node` and bundles `public/**` into the function. Set `LTA_API_KEY` in Vercel env vars.

⚠️ **Stadia dark tiles are access-controlled.** They work on `localhost` with no setup, but on a deployed domain they return 401/403 (blank tiles) until that domain is added to the Stadia Maps property allowlist (or an API key is appended to the tile URL).
