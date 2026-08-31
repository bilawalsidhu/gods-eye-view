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
  /*
   * Two workers locally, Playwright's own default in CI.
   *
   * The default is half the cores, which is six on this machine, and each one is a headless
   * Chromium compiling Cesium's shaders and then drawing the whole scene: 669 clustered
   * satellite billboards with count labels, on top of the aircraft and vessel layers. Six of
   * those at once on one laptop is where the expect timeouts start losing to contention rather
   * than to anything being wrong.
   *
   * Measured 2026-08-23. Under load the suite failed 8 of 21 on two consecutive runs and **a
   * different eight each time**, including tests that never open a card, while `--workers=1`
   * passed 21 of 21. On an idle machine the default passes too. So it is contention, and the
   * moving failure set is the tell.
   *
   * `retries` above is the reason this matters more than it sounds. CI gets two retries and
   * absorbs a contention timeout; a developer on a laptop gets none and reads a red suite as a
   * broken feature. AGENTS.md already records one instance of a deliberate product change
   * reading as three broken features, and a suite whose failures move is how people stop
   * trusting it. CI keeps the default because its runners are not also hosting five agents.
   *
   * **Re-measured 2026-08-24 at 33 tests, and two is faster than three as well as more
   * reliable**, which is not the trade anyone expects:
   *
   *     3 workers   1.5m   1 failed, 32 passed
   *     2 workers   1.2m   33 passed
   *     2 workers   1.1m   33 passed
   *     1 worker    2.3m   33 passed
   *
   * Three was chosen on 2026-08-23 when the suite was 21 tests and it has been outgrown: the
   * failure was `#globe canvas` never appearing at all, so Cesium had not got a WebGL context,
   * and it burned the full 20-second `expect` timeout doing it. That one stall costs more wall
   * clock than a third worker saves, which is why two wins on both axes at once. It also means
   * this number needs re-measuring as the suite grows rather than trusting, because the point
   * where contention starts moves with the number of globes drawn at once, not with the number
   * of tests.
   */
  // Spread rather than a ternary ending in `undefined`: `exactOptionalPropertyTypes` is on,
  // so an optional field will not accept an explicit `undefined`, and in CI the point is to
  // leave the key off entirely and take Playwright's own default.
  ...(process.env['CI'] === undefined && { workers: 2 }),
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
