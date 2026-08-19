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
 */
const CESIUM_ASSET_DIRECTORIES = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: CESIUM_ASSET_DIRECTORIES.map((directory) => ({
        src: `node_modules/cesium/Build/Cesium/${directory}`,
        dest: 'cesium',
      })),
    }),
  ],
  // Cesium's buildModuleUrl reads a bare `CESIUM_BASE_URL` identifier behind a `typeof`
  // guard. Vite substitutes it at build time, which is why no runtime global is set.
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium') },
  server: { port: 5173, proxy },
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
        // Bootstrap wiring: constructions and subscriptions with no branches of its own.
        // Covered end to end by e2e/smoke.spec.ts, which fails if any of it is wrong.
        'src/main.ts',
        // Builds a real Cesium Viewer, which needs a WebGL context. Also covered by the
        // Playwright suite, which renders the actual globe.
        'src/globe/viewer.ts',
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
       */
      thresholds: {
        lines: 70,
        functions: 68,
        branches: 72,
        statements: 70,
        perFile: false,
      },
    },
  },
});
