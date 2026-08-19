import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * End-to-end against the built bundle on the preview server, with no backend running.
 *
 * `pnpm preview` rather than `pnpm dev`, because the thing worth smoke testing is what
 * actually ships: the Cesium asset copy and the CESIUM_BASE_URL substitution only happen
 * in a build, and both are exactly the sort of thing that breaks silently.
 *
 * Every `/api` and `/ws` call is intercepted in the spec, so nothing here needs the
 * backend. The preview server still proxies both, and without the interception the page
 * would sit waiting on a connection that is never accepted.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // A committed `.only` would silently reduce the suite to one test. In CI that is a
  // failure, not a convenience.
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] === undefined ? 0 : 2,
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  // Cesium compiles shaders and fetches imagery on first paint, and CI renders WebGL in
  // software through SwiftShader. The default 30s is not enough for a cold globe.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm preview --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 120_000,
  },
});
