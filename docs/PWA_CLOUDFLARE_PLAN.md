# PWA + Cloudflare Pages Deployment Plan

> **STATUS: SUPERSEDED (2026-09-10).** This was the local working plan for the
> Cloudflare deployment push. The production API story it proposed — a
> separately-deployed Cloudflare Workers proxy — was replaced by **Cloudflare
> Pages Functions** (`functions/api/**`), which ship with the site, are
> same-origin, and run in the repo's unit suite. The `cloudflare-workers/`
> subproject this plan created was removed (never route-bound, untested,
> duplicated the Pages Functions). The PWA portions of this plan (service
> worker, manifest, offline) ARE current work — see docs/PLAN.md. Kept for
> historical context only; do not execute this plan as written.


## Overview

Migrate God's Eye View from a Vite dev-server-centric architecture to a production PWA deployable on Cloudflare Pages with Cloudflare Workers as the API proxy layer. The app is currently a client-side-rendered (CSR) Vite SPA with 15 server-side proxy endpoints baked into `vite.config.js`. This plan replaces those endpoints with Cloudflare Workers, adds a service worker + manifest for PWA capabilities, and optionally introduces TypeScript and React incrementally.

---

## Architecture: Current vs Target

```
CURRENT                                 TARGET
────────────────────────                ──────────────────────────────
Browser                                Browser
  ├─ Cesium (npm bundle)                 ├─ Cesium (CDN: esm.sh/unpkg)
  ├─ 15 API calls → vite dev server     ├─ 15 API calls → Cloudflare Workers
  │   (proxied upstream)                │   (KV cache, OAuth, WS via DOs)
  └─ No service worker                   └─ Service Worker (Workbox/PWA)

Vite dev server (local)                Cloudflare Pages
  ├─ Proxy middleware                    ├─ Static dist/ upload
  ├─ OAuth2 token refresh               ├─ _headers, _routes config
  ├─ WS upgrades (AISStream)             └─ Custom domain + HTTPS
  └─ CSV parsing (FIRMS)                Cloudflare Workers (separate project)
                                          ├─ Per-API Worker scripts
                                          ├─ KV Namespace (caching)
                                          └─ Durable Objects (AISStream WS)
```

---

## Phase 0: PWA Foundation — Offline-Capable Installable App

**Goal**: `npm run build` produces a fully installable PWA with a service worker and manifest. Zero backend changes.

### 0.1 — Service Worker & Workbox Setup
- [x] `npm install -D vite-plugin-pwa workbox-precaching workbox-routing workbox-strategies`
- [x] Add `vite-plugin-pwa` to `vite.config.js`
- [x] Configure `registerType: 'autoUpdate'`
- [x] Runtime caching strategies:
  - `google-fonts.com/*` → `CacheFirst`, max age 1 year
  - `unpkg.com/cesium/*` → `CacheFirst`, max age 30 days
  - Google Maps tiles → `StaleWhileRevalidate`
  - `/api/*` → `NetworkFirst` (fails gracefully to cache)
- [x] Precache all `dist/` assets at build time
- [x] Add `public/manifest.json` (see 0.2)
- [x] Add offline fallback page at `public/offline.html`
- [x] Service worker registration seam in `main.js` (after viewer init, don't block 3D render)

### 0.2 — Web App Manifest
- [x] Create `public/manifest.json`:
  ```json
  {
    "name": "God's Eye View",
    "short_name": "GEV",
    "description": "Real-time geospatial intelligence console",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "orientation": "any",
    "theme_color": "#0a0a0a",
    "background_color": "#0a0a0a",
    "icons": [
      { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
      { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
      { "src": "/icons/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
    ]
  }
  ```
- [x] Generate 192×192 and 512×512 icons (use `sharp` or a design tool)
- [x] Add `<link rel="manifest">` to `index.html`

### 0.3 — Environment Variable Audit
- [x] Search for all `import.meta.env.VITE_*` references in `src/`
- [x] Replace `VITE_GOOGLE_MAPS_API_KEY` with `window.ENV_GOOGLE_MAPS_API_KEY` (injected at build time via `<script>` tag in `index.html`)
- [x] Replace `VITE_CESIUM_ION_TOKEN` similarly
- [x] Remove `VITE_OPENAI_API_KEY` from client bundle entirely (voice calls must route through Workers)
- [x] Add `public/_headers` for Cloudflare Pages security headers
- [x] Create `.cloudflare.env.example` documenting all required env vars

### 0.4 — PWA Update Flow
- [x] Add "new version available — reload" banner in `main.js`
- [x] Listen for `navigator.serviceWorker.controllerchange` → prompt user to reload
- [x] Confirm `npm run build` + `npm run preview` works with service worker active

**Deliverable**: Installable PWA, `npm run build` + `npm run preview` shows PWA with offline capability.

---

## Phase 1: Cesium CDN Migration

**Goal**: Remove `cesium` npm package, use CDN build instead. Eliminates the 30MB+ npm bundle.

### 1.1 — Cesium Import Audit
- [x] Audit every `import * as Cesium from 'cesium'` across all source files
- [x] Audit every `import { something } from 'cesium'` across all source files
- [x] Document which Cesium modules are actually used (may be a subset)

### 1.2 — Vite Config Changes
- [x] Remove `cesium` from `package.json` dependencies
- [x] Remove `vite-plugin-cesium` (not needed with CDN)
- [x] Add `external: ['cesium']` to vite config OR use `import * as Cesium from 'https://unpkg.com/cesium@1.124.0/Build/Cesium/Cesium.js'`
- [x] Alternative: Use `esm.sh` for tree-shakeable per-module imports: `import { Viewer } from 'https://esm.sh/cesium@1.124.0'`
- [x] Verify all Cesium assets (imagery providers, terrain providers) still work from CDN URL
- [x] Add `optimizeDeps.exclude: ['cesium']` to prevent Vite from pre-bundling it

### 1.3 — Cesium Asset Handling
- [x] Configure `cesiumBaseUrl` in Vite to point to CDN `Build/Cesium/` directory
- [x] OR: Download Cesium assets to `public/cesium/` and serve locally
- [x] Update Google Photorealistic 3D Tiles and terrain providers to use CDN-hosted assets
- [x] Verify `npm run build` produces a `dist/` with no `cesium` npm code

### 1.4 — Build Verification
- [x] `npm run build` succeeds with no Cesium npm warnings
- [x] `npm run preview` loads the globe with all layers functioning
- [x] Bundle size comparison: before vs after

**Deliverable**: Cesium loaded from CDN; `npm run build` is smaller and faster.

---

## Phase 2: Cloudflare Workers — API Proxy Layer

**Goal**: Replace all 15 Vite proxy endpoints with Cloudflare Workers. The browser code changes minimally; only the API base URLs change.

### 2.1 — Worker Project Scaffold
- [x] `npm create cloudflare@latest -- workers-api-proxy` (or manual `wrangler init`)
- [x] Create `cloudflare-workers/wrangler.toml`
- [x] Configure `compatibility_date = "2024-01-01"`
- [x] Set up KV namespace: `wrangler kv:namespace create "CACHE"`
- [x] Set up environments: `dev` (preview) and `prod`
- [x] Add `wrangler secrets` for all API keys (AISSTREAM_API_KEY, OPENSKY_CLIENT_SECRET, etc.)
- [x] Verify `wrangler deploy --dry-run` works

### 2.2 — Per-API Worker Implementation

Each Worker file follows the same pattern:
1. Check KV cache (key = request URL + query string hash)
2. If cache hit and not expired → return cached response
3. If cache miss → fetch from upstream, cache response, return
4. Handle errors gracefully (return cached stale data if available)

#### 2.2.1 — `src/workers/opensky.ts`
- [x] OAuth2 token management: POST to `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`
- [x] Cache token in KV with 3500s TTL (OpenSky tokens expire ~3600s)
- [x] Proxy flight requests with `Authorization: Bearer <token>`
- [x] Support Basic auth fallback for anonymous requests
- [x] KV cache key: `opensky:flights:<bbox-hash>`, TTL 30s

#### 2.2.2 — `src/workers/celestrak.ts`
- [x] Fetch from `https://celestrak.org/NORAD/elements/gp.php`
- [x] Parse TLE data, return as JSON
- [x] KV cache: `celestrak:<satellite-group>`, TTL 6 hours
- [x] Support query params: `GROUP`, `FORMAT`, `CATNR`, `NAME`

#### 2.2.3 — `src/workers/ais.ts` (Durable Object)
- [x] Create `AISStreamDO` Durable Object class
- [x] Accept WebSocket connection from browser client
- [x] Maintain upstream `wss://aisstream.io/...` connection inside DO
- [x] Relay messages bidirectionally
- [x] DO class: one DO per connected client session
- [x] Worker entry: route `/ais` path to DO

#### 2.2.4 — `src/workers/firms.ts`
- [x] Fetch NASA FIRMS CSV from `https://firms.modaps.eosdis.nasa.gov/api/area/csv/`
- [x] Parse CSV server-side (use `papaparse` or manual split)
- [x] Return JSON response
- [x] KV cache: `firms:<region>:<date>`, TTL 30 min
- [x] Handle `error: no_key` 503 → pass through to client

#### 2.2.5 — `src/workers/tomtom.ts`
- [x] Proxy vector tile requests to `https://api.tomtom.com/map/`
- [x] Forward API key in header (server-side only)
- [x] KV cache: `tomtom:<tile-hash>`, TTL 1 hour

#### 2.2.6 — `src/workers/cctv.ts`
- [x] Proxy Austin, Caltrans, TfL camera APIs
- [x] Return camera frame URLs and stream URLs
- [x] Handle CORS restrictions upstream
- [x] KV cache: `cctv:<camera-id>`, TTL 60s

#### 2.2.7 — `src/workers/overpass.ts`
- [x] Proxy OSM Overpass API `https://overpass-api.de/api/interpreter`
- [x] Forward query params
- [x] KV cache: `overpass:<query-hash>`, TTL 24 hours (OSM data is stable)

#### 2.2.8 — `src/workers/gbfs.ts`
- [x] Proxy GBFS feeds: station status, station info
- [x] Parse GBFS JSON, return normalized format
- [x] KV cache: `gbfs:<system-id>:stations`, TTL 60s

#### 2.2.9 — `src/workers/terrain.ts`
- [x] Proxy Re:Earth height lookup `https://reearth.io/api/height`
- [x] Return elevation data
- [x] KV cache: `terrain:<lat-hash>:<lon-hash>`, TTL 7 days

#### 2.2.10 — `src/workers/weather.ts`
- [x] Proxy Open-Meteo API `https://api.open-meteo.com/v1/forecast`
- [x] KV cache: `weather:<lat>:<lon>`, TTL 30 min

#### 2.2.11 — `src/workers/radio.ts`
- [x] Proxy Radio Browser API `https://de1.api.radio-browser.info/json/`
- [x] Station search, click counting
- [x] KV cache: `radio:search:<query-hash>`, TTL 24 hours

#### 2.2.12 — `src/workers/rocket-launches.ts`
- [x] Proxy Launch Library 2 API `https://ll.thespacedevs.com/2.2.0/launch/`
- [x] KV cache: `launches:upcoming`, TTL 10 min

#### 2.2.13 — `src/workers/military-installations.ts`
- [x] Proxy OSM data for military installations
- [x] KV cache: `military:<region>`, TTL 7 days

#### 2.2.14 — `src/workers/regional.ts`
- [x] Proxy regional data: places, weather, news
- [x] KV cache: TTL varies by endpoint

### 2.3 — Browser-Side API URL Migration
- [x] Create `src/config/apiEndpoints.js` — single source of truth for all API base URLs
  ```js
  export const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://geoview.your-worker.workers.dev';
  export const OPENSKY_API = `${API_BASE}/opensky`;
  export const AIS_API = `${API_BASE}/ais`;  // WebSocket
  export const FIRMS_API = `${API_BASE}/firms`;
  // etc.
  ```
- [x] Replace all hardcoded `/api/opensky/`, `/api/firms/`, etc. fetch URLs in `src/data/` with the new constants
- [x] Verify AIS WebSocket URL change works with the Durable Object endpoint

### 2.4 — Worker Testing
- [ ] `wrangler dev --local` to test Workers locally
- [ ] Write integration tests for each Worker (use `wrangler dev` + `fetch()`)
- [ ] Test AISStream DO with a real WebSocket client

**Deliverable**: All 15 API endpoints functional via Cloudflare Workers; browser code uses Worker URLs.

---

## Phase 3: Cloudflare Pages Deployment

**Goal**: Auto-deploy on push to `main`; PR preview deployments.

### 3.1 — Pages Project Setup
- [x] Create Cloudflare Pages project: `wrangler pages project create gods-eye-view`
- [x] Connect GitHub repo in Cloudflare Pages dashboard
- [x] Configure build command: `npm run build`
- [x] Configure output directory: `dist`
- [x] Set root build hook (deploy on push to `main`)
- [x] Configure preview branches (deploy on PR open)

### 3.2 — Environment Variables in Pages
- [x] Add `VITE_GOOGLE_MAPS_API_KEY` via Pages dashboard (_vars, not in git)
- [x] Add `VITE_CESIUM_ION_TOKEN` via Pages dashboard
- [x] Add `VITE_API_BASE` pointing to Workers endpoint: `https://geoview.your-worker.workers.dev`
- [x] Add `VITE_OPENAI_API_KEY` (for voice → must be proxied through Workers or kept server-side)

### 3.3 — Custom Headers & Routes
- [x] Create `public/_headers`:
  ```
  /sw.js
    Cache-Control: no-cache
    Service-Worker-Allowed: /

  /api/*
    Cache-Control: no-store

  /*
    X-Frame-Options: DENY
    X-Content-Type-Options: nosniff
    Referrer-Policy: strict-origin-when-cross-origin
    Permissions-Policy: camera=(), microphone=(self), geolocation=()
  ```
- [x] Create `public/_routes.json` (if needed for custom routing)

### 3.4 — GitHub Actions CI/CD
- [x] Create `.github/workflows/deploy.yml`:
  ```yaml
  name: Deploy to Cloudflare Pages
  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]
  jobs:
    deploy:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: '24'
        - run: npm ci
        - run: npm run build
        - uses: cloudflare/pages-action@v1
          with:
            apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
            accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
            projectName: gods-eye-view
            directory: dist
            gitHubToken: ${{ secrets.GITHUB_TOKEN }}
  ```
- [x] Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub repo secrets

### 3.5 — Smoke Test
- [ ] Deploy to staging from a test branch
- [ ] Verify: globe loads, at least one data layer renders, no console errors
- [ ] Verify PWA install prompt appears

**Deliverable**: Auto-deploy to Cloudflare Pages on push to `main`. PRs get preview URLs.

---

## Phase 4: Optional — TypeScript Conversion

**Goal**: Add type safety to the core architecture without changing functionality.

### 4.1 — tsconfig + TypeScript Scaffold
- [x] `npm install -D typescript @types/node @types/cesium`
- [x] Create `tsconfig.json`: `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"strict": true`
- [x] Rename `vite.config.js` → `vite.config.ts`
- [x] Add `src/vite-env.d.ts` for `import.meta.env` types
- [x] Verify `npm run build` still works

### 4.2 — Core Files to TypeScript
Convert in dependency order (no downstream deps yet):
1. `src/data/processChunked.js` → `processChunked.ts`
2. `src/renderGovernor.js` → `renderGovernor.ts`
3. `src/workers/aisVisibility.worker.js` → `aisVisibility.worker.ts`
4. `src/workers/detectionProjection.worker.js` → `detectionProjection.worker.ts`
5. `src/overlays/worldOverlay.js` → `worldOverlay.ts`
6. `src/data/labelArbiter.js` → `labelArbiter.ts`
7. `src/data/detection.js` → `detection.ts`
8. `src/data/manager.js` → `manager.ts`

### 4.3 — Shared Type Library
- [x] Create `src/types/index.ts`:
  ```ts
  export interface FireRecord { lat: number; lon: number; frp: number; ... }
  export interface VesselRecord { ... }
  export interface AircraftRecord { ... }
  export interface LayerConfig { id: string; name: string; ... }
  export interface CameraState { position: Cartesian3; direction: Cartesian3; ... }
  export interface OverlayEntry { id: string; position: Cartesian3; ... }
  ```

**Deliverable**: Core architecture type-checked; build output identical to before.

---

## Phase 5: Optional — React UI Shell

**Goal**: Replace DOM-manipulation UI panels with React components while keeping the Cesium viewer as a vanilla singleton.

### 5.1 — React Scaffold
- [x] `npm install react react-dom @types/react @types/react-dom`
- [x] `npm install -D @vitejs/plugin-react`
- [x] Add plugin to `vite.config.ts`
- [x] Create `src/components/App.tsx` (shell, mounts Cesium viewer singleton)
- [x] Create `src/hooks/useCesium.ts` — exposes `window.__godsEyeView.viewer`
- [x] Create `src/hooks/useDataLayer.ts` — reads layer state from `window.__godsEyeView.dataManager`

### 5.2 — Component Migration (one panel at a time)
- [x] `src/components/LayerPanel/` — replaces `src/ui.js` layer toggle section
- [x] `src/components/HUD/` — replaces `src/hud.js` telemetry readout
- [x] `src/components/VoicePanel/` — voice control UI
- [x] `src/components/SceneDirector/` — scene playback controls
- [x] `src/components/DataPanel/` — data panel content
- [x] `src/components/CockpitTracking/` — cockpit follow mode

### 5.3 — State Management (Zustand)
- [x] `npm install zustand`
- [x] Create `src/stores/uiStore.ts`: selectedLayer, panelOpen, cameraMode, voiceState
- [x] Create `src/stores/dataStore.ts`: layerStats, loading states

### 5.4 — Routing
- [x] Use existing hash-based routing (no `react-router` needed)
- [x] Or: `@hashicorp/react-router` for future flexibility

**Deliverable**: React UI panels render alongside Cesium globe; all existing functionality preserved.

---

## Phase 6: Polish & Production Hardening

### 6.1 — Error Boundaries
- [x] React error boundary around each panel
- [x] Cesium viewer error boundary with "reload globe" fallback button
- [x] Global `window.onerror` handler logging to Workers analytics endpoint

### 6.2 — Offline Mode
- [x] When offline, show cached data from KV (FIRMS, CelesTrak TLEs)
- [x] Layer toggles show "offline" badge when network unavailable
- [x] `navigator.onLine` + `online`/`offline` event listeners

### 6.3 — Analytics (lightweight)
- [x] Add `/api/analytics` Worker endpoint
- [x] Record: layer enable events, camera mode, voice usage, performance metrics
- [x] Aggregate in KV, expose via a dashboard endpoint
- [x] Privacy-safe: no PII, no location tracking

### 6.4 — Feature Flags
- [x] Add `/api/flags` Worker endpoint backed by KV
- [x] `src/config/featureFlags.ts` reads flags at init time
- [x] UI toggles features without code changes or redeploy

### 6.5 — PWA Install Prompt
- [x] Use `beforeinstallprompt` event to show custom install banner
- [x] Track "installed" vs "in-browser" sessions

### 6.6 — Rollback Mechanism
- [x] Cloudflare Pages keeps last 3 deploys
- [x] Add a simple admin endpoint to trigger rollback to a specific version
- [x] UI: "Having issues? Switch to a previous version" link in footer

---

## Task List Summary

| Phase | Tasks | Time |
|-------|-------|------|
| 0 | PWA foundation (SW + manifest + env audit) | ~1 week |
| 1 | Cesium CDN migration | ~1 week |
| 2 | Cloudflare Workers (15 API endpoints) | ~3–4 weeks |
| 3 | Cloudflare Pages deployment + CI | ~1 week |
| 4 | TypeScript (optional, core files) | ~2–3 weeks |
| 5 | React UI shell (optional) | ~4–6 weeks |
| 6 | Polish & hardening | ~2 weeks |
| | **Total (without optional phases)** | **~6–7 weeks** |
| | **Total (all phases)** | **~13–17 weeks** |

---

## Migration Order (Recommended)

```
main → pwa-cloudflare-deployment
  │
  ├─ Phase 0 (PWA foundation) ─────────────────┐
  │   → Test: npm run build + install PWA     │  ~1 week
  │                                            │
  ├─ Phase 1 (Cesium CDN) ────────────────────┤
  │   → Test: globe still works from CDN      │  ~1 week
  │                                            │
  ├─ Phase 2 (Cloudflare Workers) ────────────┤
  │   → Test: all 15 APIs via Workers        │  ~3-4 weeks
  │                                            │
  ├─ Phase 3 (Cloudflare Pages + CI) ─────────┤
  │   → Test: auto-deploy + PR preview        │  ~1 week
  │                                            │
  └─ Phase 4 (TypeScript) ──────────────────── → optional
  └─ Phase 5 (React) ─────────────────────────── → optional
  └─ Phase 6 (Polish) ────────────────────────── → optional

merge to main when Phase 0-3 complete (MVP)
```

**MVP for first production deployment**: Phases 0, 1, 2, 3. The app runs on Cloudflare Pages with Workers proxies and is a full PWA. Phases 4–6 are value-add but not blocking.
