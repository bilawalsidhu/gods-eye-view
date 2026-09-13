/**
 * Vite configuration for God's Eye View — a cinematic geospatial app.
 *
 * This file is the ASSEMBLY only: each dev-server proxy middleware lives in
 * its own module under `vite/proxies/` (Batch 4, PLAN.md) so endpoints can be
 * unit-tested in isolation and the dev side of every parity fix has a
 * testable seam:
 *
 *   1. OpenSky  — aircraft state vectors (OAuth / Basic / anon)   → proxies/opensky.js
 *   2. CelesTrak — satellite TLE orbital elements                 → proxies/celestrak.js
 *   3. Overpass  — OSM road geometry + route snapping             → proxies/overpass.js
 *   4. GBFS     — bike-share station feeds                        → proxies/gbfs.js
 *   5. CCTV     — traffic-camera frames and fallback SVG          → proxies/cctv.js
 *   6. adsb.lol — military aircraft tracking                      → proxies/adsblol.js
 *   7. AIS live — AISStream websocket vessel positions            → proxies/ais-live.js
 *   8. Terrain heights — Re:Earth keyless lookups                 → proxies/terrain-heights.js
 *   9. TomTom   — traffic-flow tiles (budget-governed)            → proxies/tomtom.js
 *  10. NASA FIRMS — active-fire detections                        → proxies/firms.js
 *  11. Military-installation context                              → proxies/military-installations.js
 *  12. Regional briefing                                          → proxies/regional.js
 *  13. Weather effects                                            → proxies/regional.js
 *  14. Rocket launches — Launch Library 2                         → proxies/launches.js
 *  15. Radio Browser — station directory                          → proxies/radio.js
 *  16. adsbdb route/registration                                  → proxies/adsbdb.js
 *  17. OpenZenith bridge                                          → proxies/openzenith.js
 *  18. Track backfill (opensky-track / adsbdb-track)              → proxies/track-backfill.js
 *  19. OpenAI Realtime token + HUD summary + debug log            → proxies/realtime.js
 *  20. Google Places context                                      → proxies/google-places.js
 *
 * Shared infrastructure (rate limiters, same-site gates, capped readers,
 * OpenSky OAuth) lives in `vite/proxies/_shared.js`.
 *
 * Also exposes Cesium and Google 3D Tiles API keys to the
 * client via `import.meta.env.*` defines.
 *
 * @module vite.config
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { adsbdbProxy } from './vite/proxies/adsbdb.js';
import { adsbLolProxy } from './vite/proxies/adsblol.js';
import { aisLiveProxy } from './vite/proxies/ais-live.js';
import { celestrakProxy } from './vite/proxies/celestrak.js';
import { cctvProxy } from './vite/proxies/cctv.js';
import { firmsProxy } from './vite/proxies/firms.js';
import { gbfsProxy } from './vite/proxies/gbfs.js';
import { googlePlacesContextProxy } from './vite/proxies/google-places.js';
import { militaryInstallationsProxy } from './vite/proxies/military-installations.js';
import { openAiRealtimeProxy } from './vite/proxies/realtime.js';
import { openSkyProxy } from './vite/proxies/opensky.js';
import { openZenithProxy } from './vite/proxies/openzenith.js';
import { overpassProxy } from './vite/proxies/overpass.js';
import { radioBrowserProxy } from './vite/proxies/radio.js';
import { regionalBriefProxy, weatherEffectsProxy } from './vite/proxies/regional.js';
import { rocketLaunchesProxy } from './vite/proxies/launches.js';
import { terrainHeightsProxy } from './vite/proxies/terrain-heights.js';
import { tomtomProxy } from './vite/proxies/tomtom.js';
import { trackBackfillProxies } from './vite/proxies/track-backfill.js';

/** Resolve __dirname for ESM context. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Main Vite configuration factory.
 *
 * Loads .env files via Vite's loadEnv, registers Cesium + local proxy
 * plugins, configures the dev server host/port, and exposes selected
 * API keys to the client as import.meta.env defines.
 */
export default defineConfig(({ mode }) => {
  // Load only this checkout's dotenv files. Shell/Keychain values still win,
  // and no sibling workspace is consulted implicitly.
  const loaded = loadEnv(mode, __dirname, '');
  for (const [key, val] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
  const env = { ...process.env };
  return {
    plugins: [
      // Cesium is loaded from CDN (unpkg.com) via <script> in index.html.
      // Workers/Assets are at https://unpkg.com/cesium@1.124.0/files/ — see CESIUM_BASE_URL define.
      // The cesium npm package is still in package.json for type definitions (devDependency).
      // Dev/preview without internet: set CESIUM_BASE_URL=/cesium/ and copy Assets/Workers
      // from node_modules/ to public/cesium/ (npm run fetch-cesium-assets).
      openSkyProxy(),
      celestrakProxy(),
      tomtomProxy(),
      firmsProxy(),
      rocketLaunchesProxy(),
      terrainHeightsProxy(),
      adsbdbProxy(),
      openZenithProxy(),
      overpassProxy(),
      militaryInstallationsProxy(),
      regionalBriefProxy(),
      weatherEffectsProxy(),
      cctvProxy(),
      radioBrowserProxy(),
      gbfsProxy(),
      adsbLolProxy(),
      aisLiveProxy(),
      trackBackfillProxies(),
      openAiRealtimeProxy(),
      googlePlacesContextProxy(),
      // ── PWA (CSR-first + offline-capable shell) ────────────────────────────
      // Generates the service worker (workbox) and registers it in the client
      // (main.js listens for `controllerchange` to show the update banner).
      // Precache policy: the APP SHELL ONLY. The 19 MB of lazy feature chunks
      // and datasets (egm96, regions, datacenters, …) stay on-demand and are
      // picked up by the runtime caches below — the bundle-budget work in
      // docs/PLAN.md Phase 7 decides what graduates to precache, not this
      // list. Cesium's copied /cesium/ tree (9 MB) is likewise runtime-cached
      // per file instead of precached.
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        // public/manifest.json is the manifest source of truth (already
        // linked from index.html); don't generate a competing one.
        manifest: false,
        includeAssets: ['icons/*.png', 'icon.svg', 'logo.svg', 'mic.svg', 'location.svg'],
        workbox: {
          globPatterns: ['index.html', 'assets/index-*.js', 'assets/*.css'],
          // The shell's index chunk is ~5.8 MB; the default 2 MiB cap would
          // silently drop it from its own precache.
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              // Cesium Workers/Assets/ThirdParty (copied to /cesium/ at
              // build): immutable per release — cache-first per file with a
              // generous LRU. purgeOnQuotaError keeps a full disk from
              // wedging the whole app.
              urlPattern: ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/cesium/'),
              handler: 'CacheFirst',
              options: {
                cacheName: 'gev-cesium-assets',
                expiration: { maxEntries: 80, maxAgeSeconds: 30 * 24 * 3600, purgeOnQuotaError: true },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // Lazy feature chunks + datasets: stale-while-revalidate so a
              // second visit is instant and offline-capable without taxing
              // the first visit.
              urlPattern: ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/assets/'),
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'gev-lazy-assets',
                expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 3600, purgeOnQuotaError: true },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // Live layer APIs: network-first with a short timeout — fresh
              // when online, last-known data instead of an error offline.
              // Only GET routes match (workbox default); token-minting POSTs
              // are never cached.
              urlPattern: ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/api/'),
              handler: 'NetworkFirst',
              options: {
                cacheName: 'gev-live-api',
                networkTimeoutSeconds: 4,
                expiration: { maxEntries: 120, maxAgeSeconds: 6 * 3600, purgeOnQuotaError: true },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // Google Fonts stylesheets and font binaries.
              urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'gev-fonts-css',
                expiration: { maxEntries: 12, maxAgeSeconds: 30 * 24 * 3600, purgeOnQuotaError: true },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
              handler: 'CacheFirst',
              options: {
                cacheName: 'gev-fonts',
                expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 3600, purgeOnQuotaError: true },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        // The dev server runs the real middlewares; an SW in dev would make
        // proxy behavior order-dependent. The PWA contract is verified
        // against `vite preview` of the real build instead.
        devOptions: { enabled: false },
      }),
    ],
    server: {
      host: env.HOST || 'localhost',
      port: parseInt(env.PORT, 10) || 5173,
      // When binding to all interfaces, allow any host; otherwise restrict to local names
      allowedHosts: (env.HOST === '0.0.0.0' || env.HOST === '::')
        ? true
        : ['localhost', '127.0.0.1', '.local'],
    },
    // Expose selected API keys to the browser via import.meta.env.*
    // Cloudflare Pages injects non-prefixed vars from _vars / dashboard at runtime.
    // Local dev reads from .env (which maps VITE_GOOGLE_MAPS_API_KEY → GOOGLE_MAPS_API_KEY).
    // Pre-bundle the lazily-imported geoid dependency: `src/data/geoid.js`
    // does `import('egm96-universal')` on first altitude read, so on a fresh
    // `--force` server the FIRST page that enables a flight layer used to
    // 504 "Outdated Optimize Dep" — killing that harness's boot console
    // record and every `--only` rerun before it (L9 matrix D1/D2/D3/D6/D8).
    optimizeDeps: {
      include: ['egm96-universal'],
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(env.GOOGLE_MAPS_API_KEY),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(env.CESIUM_ION_TOKEN),
      // API base URL: empty in dev (Vite proxy), empty in production (same-domain Workers).
      // Override with VITE_API_BASE_URL in .env for a remote staging API.
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(env.VITE_API_BASE_URL ?? ''),
      // Tell Cesium where to find Workers + Assets at runtime.
      // Pointed at unpkg /files/ which contains the Build/Cesium/ tree.
      'CESIUM_BASE_URL': JSON.stringify('/cesium/'),
    },
    resolve: {
      // Use the pre-built Cesium (same as CDN) to avoid @zip.js dependency issues
      // from the npm source build. This is the UMD build repackaged as ESM.
      alias: {
        cesium: fileURLToPath(new URL('./node_modules/cesium/Build/Cesium/index.js', import.meta.url)),
      },
    },
    esbuild: {
      // Use the React 17+ automatic JSX runtime — transforms JSX to use jsx-runtime
      // instead of the classic React.createElement (which requires a global React ref).
      jsx: 'automatic',
    },
    build: {
      chunkSizeWarningLimit: 1500,
    },
  };
});
