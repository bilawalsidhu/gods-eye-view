import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// The backend owns every upstream feed, so the dev server proxies rather than enabling
// CORS in the browser: same-origin in development matches how this is served in
// production, where FastAPI serves the built bundle.
const backend = 'http://127.0.0.1:8000';

const proxy = {
  '/api': { target: backend, changeOrigin: true },
  '/ws': { target: backend, ws: true, changeOrigin: true },
};

/**
 * Cesium loads its workers, shaders and widget assets at runtime by URL rather than
 * through the module graph, so the bundler cannot see them and they have to be copied.
 *
 * This replaces vite-plugin-cesium, which last shipped in August 2024 and pins Vite
 * loosely enough that it was the one thing blocking this upgrade. Copy plus a
 * CESIUM_BASE_URL define is what CesiumGS/cesium-vite-example does, and it is a dozen
 * lines rather than a dependency.
 *
 * `stripBase` is not optional decoration. vite-plugin-static-copy preserves the source
 * directory structure in the output, so without it these land at
 * `dist/cesium/node_modules/cesium/Build/Cesium/Workers` and every asset Cesium asks for
 * under `/cesium` answers with `index.html`. What that looks like in a browser is not a
 * missing texture: the render loop throws "the source image could not be decoded", stops,
 * and covers the globe with Cesium's own error panel. There are four segments in
 * `node_modules/cesium/Build/Cesium`, hence the 4.
 */
const CESIUM_SOURCE = 'node_modules/cesium/Build/Cesium';
const CESIUM_SOURCE_DEPTH = CESIUM_SOURCE.split('/').length;
const CESIUM_ASSET_DIRECTORIES = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: CESIUM_ASSET_DIRECTORIES.map((directory) => ({
        src: `${CESIUM_SOURCE}/${directory}`,
        dest: 'cesium',
        rename: { stripBase: CESIUM_SOURCE_DEPTH },
      })),
    }),
  ],
  // Cesium's buildModuleUrl reads a bare `CESIUM_BASE_URL` identifier behind a `typeof`
  // guard. Vite substitutes it at build time, which is why no runtime global is set.
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium') },
  resolve: {
    alias: [
      /**
       * Keep satellite.js's optional WASM propagator out of the bundle.
       *
       * Its package root re-exports a `BulkPropagator` behind two private subpath imports,
       * and the multi-threaded one is emscripten output carrying a top-level
       * `await import('node:worker_threads')`. A browser target has no node builtins, so
       * importing anything from `satellite.js` fails the build without this. Nothing here
       * uses the WASM path: pure-JS SGP4 propagates a thousand satellites in 3.5 ms inside a
       * worker. The reasoning is in the module this points at.
       */
      {
        find: /^#wasm-(?:single|multi)-thread$/,
        replacement: fileURLToPath(
          new URL('src/globe/satellites/wasm-propagator-absent.ts', import.meta.url),
        ),
      },
    ],
  },
  // `watch.ignored` because vite's watcher does not read `.gitignore`, and `pnpm verify`
  // writes an lcov HTML report of roughly forty files into `coverage/`. Running the gate with
  // the dev server up therefore full-page-reloaded the app once per file written, which reads
  // as the globe flickering and losing its camera rather than as a watcher misconfiguration.
  // Measured 2026-08-24. `coverage/` is gitignored, so nothing here is a source file.
  server: { port: 5173, proxy, watch: { ignored: ['**/coverage/**'] } },
  // The built bundle needs the same origin for the API as it has in production, or
  // `pnpm preview` is testing something the deployment never does.
  preview: { port: 4173, proxy },
  build: {
    sourcemap: true,
  },
  test: {
    // Node, not jsdom. Nothing under test needs a document: the pure logic does not, and
    // the two modules that drive Cesium are tested against a fake collection because
    // jsdom has no WebGL and so could not run them either. The real DOM is covered by the
    // Playwright suite in e2e/, against a real browser rendering the real globe.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Required since Vitest 4 removed `coverage.all`. Without it the report only counts
      // files some test happened to import, so a wholly untested module is invisible and
      // the thresholds below pass while meaning nothing.
      include: ['src/**/*.ts'],
      exclude: [
        // Generated from the backend contract by `pnpm codegen`.
        'src/types/**',
        // A test fixture, not shipped code.
        'src/testing/**',
        'src/**/*.test.ts',
        // Bootstrap wiring. Excluded because it builds a real Cesium viewer, which needs a
        // WebGL context, and because its last statement is a top-level await. What covers it
        // is e2e/smoke.spec.ts, against the built bundle in a real browser: a mover on the
        // globe and its card, a shared URL restoring the camera and the layer switches, the
        // Cities switch and the URL, the search box painting a row and flying the camera,
        // follow mode holding a moving aircraft, and a failed gazetteer read on the rail.
        // Each of those was mutation-tested on 2026-08-20 by breaking the line it asserts.
        // Two things in here are not browser-observable and so are not covered by that suite:
        // whether follow mode is engaged (only its effect is), and whether the city labels
        // actually left the globe when the switch moved. Cesium primitives are not in the DOM
        // and the canvas pixels are not stable enough to carry either. globe/follow.test.ts
        // and globe/layers/cities.test.ts carry them.
        'src/main.ts',
        // Builds a real Cesium Viewer, which needs a WebGL context. Also covered by the
        // Playwright suite, which renders the actual globe.
        'src/globe/viewer.ts',
        // Worker bootstrap: a message listener around `handleRequest`, which is tested in
        // full in globe/satellites/orbit.test.ts. Nothing is decided in the file itself.
        'src/globe/satellites/worker.ts',
        // A build-time alias target that exists so satellite.js's unused WASM propagator
        // stays out of the bundle. It cannot be reached at runtime.
        'src/globe/satellites/wasm-propagator-absent.ts',
      ],
      reporter: ['text', 'lcov'],
      /**
       * Set just under what the suite actually measures, so this is a ratchet rather than
       * an aspiration. Deleting a test file drops straight through it.
       *
       * The number is held down by three classes that paint the DOM: AttributionPanel,
       * StatusBanner and InfoCard. Their pure logic is tested here; their rendering needs
       * a real document and is covered by the Playwright suite in e2e/. The modules that
       * carry the actual behaviour are at 97 to 100 per cent.
       *
       * Raise these when the numbers rise. Never lower them to make a build pass.
       *
       * Raised again after the phase 2 review. The suite measures 84.6 statements, 83.7
       * branches, 84.4 functions and 84.6 lines: the vessel layer, the vessel card's state
       * and the socket routing all gained tests, and the store and the WebSocket client are
       * at 100 per cent of lines. What still holds the total down is the three classes that
       * paint the DOM, AttributionPanel, StatusBanner and the two cards, whose rendering needs
       * a real document and is covered by the Playwright suite in e2e/ instead.
       *
       * Raised again in phase 4. The suite measures 87.7 statements, 86.4 branches, 87.2
       * functions and 87.7 lines, with the city layer, the search box, the fly-to, follow
       * mode and the URL state all landing at or near 100 per cent. Set a point and a half
       * under that rather than on it: the same four DOM-painting classes still hold the
       * total down and they are what a later phase will lift.
       *
       * Raised again with the credits menu. Two of those four DOM-painting classes are no
       * longer holding anything down: AttributionPanel and StatusBanner are painted against
       * a fake element here, the way the layer rail already was, so the menu's fallback to
       * the baseline credits and the collapsed banner's wording are both asserted rather
       * than left to the browser suite. The suite now measures 90.5 statements, 87.5
       * branches, 90.3 functions and 90.5 lines. The two cards are what is left.
       */
      thresholds: {
        lines: 89,
        functions: 89,
        branches: 86,
        statements: 89,
        perFile: false,
      },
    },
  },
});
