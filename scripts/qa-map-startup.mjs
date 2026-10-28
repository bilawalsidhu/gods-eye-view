import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { redact } from './qa-browserEvidence.mjs';

// A small guarded startup check, not a live-photoreal parity test.
const base = process.argv[2];
if (!base) throw new Error('Pass an explicit local server URL');
const parsed = new URL(base);
if (
  !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
  ['4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(parsed.port)
)
  throw new Error('Use an owned local test server');
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  for (const engine of ['cesium', 'navara']) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const guard = await blockPaidQaMaps(page);
      let paidAttempts = 0;
      let blockedTokenFallbacks = 0;
      const errors = [];
      page.on('pageerror', (error) => errors.push(redact(error.message)));
      page.on('console', (message) => {
        if (message.type() === 'error')
          console.error(engine, redact(message.text()));
      });
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (
          url.hostname === 'tile.googleapis.com' ||
          (url.hostname === 'api.cesium.com' &&
            url.pathname.includes('/2275207/')) ||
          (url.pathname.startsWith('/api/google/tiles') &&
            url.pathname !== '/api/google/tiles-token')
        )
          paidAttempts++;
      });
      guard.on('Network.loadingFailed', ({ blockedReason }) => {
        if (blockedReason === 'inspector') blockedTokenFallbacks++;
      });
      await page.evaluateOnNewDocument(() => {
        localStorage.clear();
        localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
        sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
      });
      const url = new URL(base);
      url.searchParams.set('engine', engine);
      url.searchParams.set('welcome', '0');
      await page.goto(url.href, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page
        .waitForFunction(
          () =>
            window.__godsEyeView?.dataManager &&
            document
              .getElementById('loading-screen')
              ?.classList.contains('hidden'),
          { timeout: 60000 },
        )
        .catch(async (error) => {
          console.error(
            JSON.stringify({
              engine,
              paidAttempts,
              errors,
              startup: await page.evaluate(() => ({
                app: Boolean(window.__godsEyeView),
                status: document.getElementById('loading-status')?.textContent,
              })),
            }),
          );
          throw error;
        });
      const state = await page.evaluate(async () => {
        const app = window.__godsEyeView;
        await app.styleManager.initialRestorePromise;
        app.styleManager.orbitController.stop();
        return {
          map: app.mapStackController.getActiveId(),
          tileset: Boolean(app.tileset),
          googleKeyPresent: Boolean(window.__GOOGLE_MAPS_API_KEY__),
          photorealAvailable:
            app.mapStackController.isStackAvailable('photoreal'),
        };
      });
      assert.equal(state.map, 'esri-imagery');
      assert.equal(state.tileset, false);
      assert.equal(state.googleKeyPresent, false);
      assert.equal(state.photorealAvailable, false);
      assert.equal(paidAttempts, 0);
      assert.equal(blockedTokenFallbacks, engine === 'cesium' ? 1 : 0);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          engine,
          ...state,
          paidAttempts,
          blockedTokenFallbacks,
          pass: true,
        }),
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
