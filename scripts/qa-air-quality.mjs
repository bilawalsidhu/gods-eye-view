/**
 * qa-air-quality.mjs — headless proof for the Air quality layer.
 *
 * Checks what unit tests cannot: that the live ECCC feed answers, that readings
 * reach the app in the provider-shaped form other networks will share, and that
 * the Weather readout descriptor carries a legend and an in-view list.
 *
 * AQHI is reported by ECCC as an integer from 1 with "10+" above ten. The API
 * returns the underlying decimal, so a reading arriving as 1.08 — or a station
 * with no reading surfacing as a confident 1 — is a real defect this catches.
 *
 * The model field a host may give the layer is checked against a small cut of
 * baked grids (src/layers/airQuality/fixtures/field: a 10° box over northern
 * Italy with a Europe inset, steps 0 and 24 h), served in place of the local
 * server's /api/air-quality/field routes with the run moved to the present:
 * the field draws, the timeline spans its forecast, and the step 24 h ahead
 * changes the tiles. It reads the world clock as the app's own module, so it
 * needs the dev server (npm run dev).
 *
 * Run:  node scripts/qa-air-quality.mjs --url http://localhost:4173
 */

import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer';

const FIELD_FIXTURE = new URL(
  '../src/layers/airQuality/fixtures/field/',
  import.meta.url,
);
const HOUR = 3600_000;
/** The fixture's run, moved to the start of the present three hours. */
const FIELD_RUN = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let exitCode = 0;
  const consoleErrors = [];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: 1400, height: 900 },
  });

  try {
    const page = await browser.newPage();
    page.on('response', (response) => {
      if (response.status() >= 400) {
        const url = new URL(response.url());
        console.log(`HTTP ${response.status()}: ${url.origin}${url.pathname}`);
      }
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 160)));
    // The model field: the fixture's grids, its run moved to now.
    const cdp = await page.createCDPSession();
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*/api/air-quality/field/*' }],
    });
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const path = new URL(request.url).pathname;
      let body = null;
      let type = 'application/octet-stream';
      if (path.endsWith('/manifest')) {
        const manifest = JSON.parse(
          readFileSync(new URL('manifest.json', FIELD_FIXTURE), 'utf8'),
        );
        manifest.run = new Date(FIELD_RUN).toISOString();
        body = Buffer.from(JSON.stringify(manifest));
        type = 'application/json';
      } else {
        const grid = /\/grid\/(global|europe)\/(\d{3})\/(\w+)\.u16$/.exec(path);
        try {
          body = grid
            ? readFileSync(
                new URL(`${grid[1]}/${grid[2]}/${grid[3]}.u16`, FIELD_FIXTURE),
              )
            : null;
        } catch {
          body = null;
        }
      }
      await cdp
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode: body ? 200 : 404,
          responseHeaders: [{ name: 'Content-Type', value: type }],
          body: (body ?? Buffer.from('{}')).toString('base64'),
        })
        .catch(() => {}); // A disabled layer may have cancelled it.
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const sourceUrl = m.location()?.url || '';
      // googleTokens.js deliberately probes an optional host capability. A
      // standalone server without it returns 404 and falls back to keyless maps.
      // Keep every other resource error and every page exception as a failure.
      if (
        sourceUrl === new URL('/api/google/tiles-token', APP_URL).href &&
        /Failed to load resource.*404/i.test(m.text())
      )
        return;
      // Without a key the OpenAQ and India routes answer 428 by design (the
      // layer says the provider needs a key); this run has none.
      if (
        /\/api\/air-quality\/(openaq|india)(\?|$)/.test(sourceUrl) &&
        /Failed to load resource.*428/i.test(m.text())
      )
        return;
      consoleErrors.push(`${m.text().slice(0, 160)} [${sourceUrl}]`);
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 90000 },
    );
    await sleep(1500);

    const stats = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      // Canada's AQHI is a view of its own; the default view is the US AQI.
      dm.setLayerParams('air-quality', { view: 'aqhi' });
      await dm.setEnabled('air-quality', true);
      const mod = dm.layers.get('air-quality')?.module;
      if (!mod) return { missing: true };
      let s = null;
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = mod.getStats();
        if (s.count > 0 || s.error) break;
      }
      return s;
    });

    const loaded = !stats?.missing && !stats?.error && stats?.count > 0;
    record(
      'stations report a current index',
      loaded,
      `count=${stats?.count} error=${stats?.error}`,
    );
    if (!loaded) exitCode = 1;

    const records = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('air-quality')
          ?.module.getAnalystRecords(500) || [],
    );

    // The provider-neutral contract other networks will share.
    const shaped = records.every(
      (r) => r.provider && r.scale && Number.isFinite(r.value) && r.band,
    );
    record(
      'every reading carries provider, scale, value and band',
      shaped,
      records.length
        ? `sample={provider:${records[0].provider}, scale:${records[0].scale}, value:${records[0].value}, band:${records[0].band}}`
        : 'no records',
    );
    if (!shaped) exitCode = 1;

    const published = records.every(
      (r) => Number.isInteger(r.value) && r.value >= 1,
    );
    record(
      'every AQHI value is in the published integer form, floored at 1',
      published,
      `values=${[...new Set(records.map((r) => r.value))].sort((a, b) => a - b).join(',')}`,
    );
    if (!published) exitCode = 1;

    const zones = [
      ...new Set(records.map((r) => r.zone).filter(Boolean)),
    ].sort();
    record(
      'coverage spans multiple ECCC administrative zones',
      zones.length >= 3,
      `zones=${zones.join(',') || 'none'} stations=${records.length}`,
    );
    if (zones.length < 3) exitCode = 1;

    // The card's whole point is "highest readings in view", so put the camera
    // over Canada before asserting on it — the default view is over Austin,
    // where an empty in-view list is correct and proves nothing.
    await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const ellipsoid = gev.viewer.scene.globe.ellipsoid;
      const d2r = Math.PI / 180;
      try {
        gev.viewer.camera.cancelFlight();
      } catch {
        /* no flight in progress */
      }
      gev.viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: -100 * d2r,
          latitude: 55 * d2r,
          height: 4_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.scene.requestRender?.();
    });
    await sleep(2500);

    const controls = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('air-quality')
          ?.module.getRowControls?.() || null,
    );
    const readoutOk =
      controls?.readout === true &&
      Array.isArray(controls?.legend) &&
      controls.legend.length === 4 &&
      controls.legend.every(
        (band) => /^#[0-9a-f]{6}$/i.test(band.color) && band.label,
      ) &&
      controls.legendCategorical === true &&
      Array.isArray(controls?.list?.items) &&
      controls.list.items.length > 0 &&
      controls.list.items.every((item) => item.id && item.lead && item.text) &&
      controls.summary?.coverage === 'Canada' &&
      // The slim tile card: an Index group holding the AQHI tile, active, and
      // a Pollutants group of six.
      controls.sublists
        ?.find((group) => group.id === 'index')
        ?.tiles.find((tile) => tile.id === 'aqhi')?.active === true &&
      controls.sublists?.find((group) => group.id === 'pollutants')?.tiles
        .length === 6;
    record(
      'the Weather card lists the worst readings in view, with a legend and tiles',
      readoutOk,
      controls
        ? `bands=${controls.legend?.map((band) => band.label).join('/')} inView=${controls.list?.items?.length} coverage="${controls.summary?.coverage}"`
        : 'no descriptor',
    );
    if (!readoutOk) exitCode = 1;

    await checkField(page);

    record(
      'no console errors',
      consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors.slice(0, 2).join(' | ') : 'clean',
    );
    if (consoleErrors.length) exitCode = 1;
  } catch (e) {
    console.error('\x1b[31mHarness error:\x1b[0m', e);
    exitCode = 3;
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  console.log('\n' + '─'.repeat(60));
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

/**
 * The model field over the fixture's box: drawn on the globe, its forecast on
 * the timeline, and a later step read by the tiles.
 */
async function checkField(page) {
  const before = await page.evaluate(
    () => window.__godsEyeView.viewer.imageryLayers?.length ?? null,
  );
  await page.evaluate(() => {
    const gev = window.__godsEyeView;
    gev.dataManager.setLayerParams('air-quality', { view: 'PM2.5' });
    const d2r = Math.PI / 180;
    gev.viewer.camera.setView({
      destination: gev.viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: 10.5 * d2r,
        latitude: 45.3 * d2r,
        height: 1_200_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    gev.viewer.scene.requestRender?.();
  });
  const read = () =>
    page.evaluate(async () => {
      const { worldClock } = await import('/src/time/worldClock.js');
      const layer =
        window.__godsEyeView.dataManager.layers.get('air-quality').module;
      const controls = layer.getRowControls();
      const tile = (group, id) =>
        controls.sublists
          .find((entry) => entry.id === group)
          ?.tiles.find((entry) => entry.id === id)?.value;
      return {
        subtitle: controls.sublists[0]?.subtitle,
        detail: controls.summary.detail,
        aqi: tile('index', 'aqi'),
        pm25: tile('pollutants', 'PM2.5'),
        coverage: worldClock.coverage(),
        own: layer.getClockCoverage(),
        follows: worldClock.follows('air-quality'),
        supported: worldClock.getState().supported,
        imagery: window.__godsEyeView.viewer.imageryLayers?.length ?? null,
      };
    });
  let now = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    now = await read();
    if (now.subtitle === 'model at view centre' && now.pm25 !== '—') break;
  }
  record(
    'with a field the tiles read the model at the view centre',
    now?.subtitle === 'model at view centre' && now.pm25 !== '—',
    `subtitle="${now?.subtitle}" PM2.5=${now?.pm25} US AQI=${now?.aqi} detail="${now?.detail}"`,
  );
  record(
    'the field draws on the globe: the global image and the Europe inset',
    Number.isInteger(before) && now?.imagery - before === 2,
    `imagery layers ${before} -> ${now?.imagery}`,
  );
  // The layer gives the clock exactly its run's span; other layers on the
  // timeline may widen the timeline's, which must hold the forecast.
  const spans =
    now?.own?.start === FIELD_RUN &&
    now?.own?.end === FIELD_RUN + 24 * HOUR &&
    now.coverage?.start <= now.own.start &&
    now.coverage?.end >= now.own.end &&
    now.follows === true &&
    now.supported === true;
  record(
    'the timeline spans the forecast',
    spans,
    now?.own
      ? `layer ${new Date(now.own.start).toISOString()} .. ${new Date(now.own.end).toISOString()}, timeline ${new Date(now.coverage?.start).toISOString()} .. ${new Date(now.coverage?.end).toISOString()}, follows=${now.follows}`
      : 'no coverage from the layer',
  );
  await page.evaluate(
    async (at) => {
      const { worldClock } = await import('/src/time/worldClock.js');
      worldClock.seek(at);
    },
    FIELD_RUN + 24 * HOUR,
  );
  let later = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    later = await read();
    if (/forecast for/.test(later.detail) && later.pm25 !== now?.pm25) break;
  }
  record(
    'scrubbing to +24 h draws that step: the tiles change',
    /forecast for/.test(later?.detail) &&
      later.pm25 !== now?.pm25 &&
      later.pm25 !== '—',
    `PM2.5 ${now?.pm25} -> ${later?.pm25}, US AQI ${now?.aqi} -> ${later?.aqi}, detail="${later?.detail}"`,
  );
  await page.evaluate(async () => {
    const { worldClock } = await import('/src/time/worldClock.js');
    worldClock.goLive();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
