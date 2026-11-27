/**
 * qa-air-quality.mjs — headless proof for the Air quality layer.
 *
 * Checks what unit tests cannot, in the real app with no provider key (the
 * stand-alone default): the layer turns on, its Layers row is not
 * UNAVAILABLE, says KEY REQUIRED and names the OpenAQ key it needs, and the
 * Weather card offers the US AQI as its one index (its tile across the row),
 * six pollutant tiles, the US AQI ramp and a line for the key to add. No index
 * of a network's own (Canada's AQHI is retired) is offered anywhere. The
 * script answers the air-quality station route itself
 * (/api/air-quality/openaq: 428, no key), so it gives the same answers
 * whatever key the server has, and reads nothing upstream.
 *
 * The model field a host may give the layer is checked against a small cut of
 * baked grids (src/layers/airQuality/fixtures/field: a 10° box over northern
 * Italy with a Europe inset, steps 0 and 24 h), served in place of the local
 * server's /api/air-quality/field routes with the run moved to the present:
 * the field draws, the timeline spans its forecast, and the step 24 h ahead
 * changes the tiles. It reads the world clock as the app's own module, so it
 * needs the dev server (npm run dev); any keys the server holds are not used.
 *
 * Run:  node scripts/qa-air-quality.mjs --url <the dev server, e.g. http://localhost:4173>
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
/**
 * Open Data Layers before reading its rows: they repaint while it is
 * displayed, and it starts collapsed.
 */
const openDataLayers = (page) =>
  page.evaluate(() => {
    const panel = document.getElementById('data-panel');
    if (panel?.classList.contains('collapsed'))
      panel.querySelector('[data-collapse-target="data-panel"]')?.click();
  });

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
    // The model field: the fixture's grids, its run moved to now. The
    // station routes: a stand-alone server with no keys.
    const cdp = await page.createCDPSession();
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*/api/air-quality/field/*' },
        { urlPattern: '*/api/air-quality/openaq*' },
      ],
    });
    const STATION_ROUTES = Object.freeze({
      '/api/air-quality/openaq': [428, { error: 'no_key' }],
    });
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const path = new URL(request.url).pathname;
      const station = STATION_ROUTES[path];
      if (station) {
        await cdp
          .send('Fetch.fulfillRequest', {
            requestId,
            responseCode: station[0],
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
            ],
            body: Buffer.from(JSON.stringify(station[1])).toString('base64'),
          })
          .catch(() => {});
        return;
      }
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
      // Without a key the OpenAQ route answers 428 by design (the layer says
      // the provider needs a key); this run answers it so.
      if (
        /\/api\/air-quality\/openaq(\?|$)/.test(sourceUrl) &&
        /Failed to load resource.*428/i.test(m.text())
      )
        return;
      consoleErrors.push(
        `${m.text().slice(0, 160)} [${sourceUrl.split(/[?#]/, 1)[0]}]`,
      );
    });

    await page.goto(new URL('/#v=2&map=esri-imagery', APP_URL).href, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 90000 },
    );
    await sleep(1500);

    const keyless = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      const enabled = await dm.setEnabled('air-quality', true);
      const mod = dm.layers.get('air-quality')?.module;
      if (!mod) return { missing: true };
      // Every network answers at once without a key; OpenAQ asks only once
      // the camera has a view. Wait until every network has answered.
      const answered = () =>
        mod
          .getProviderStates()
          .every((s) =>
            ['no-key', 'disabled', 'failed', 'ok'].includes(s.status),
          );
      for (let i = 0; i < 90 && !answered(); i++)
        await new Promise((r) => setTimeout(r, 500));
      const row = dm.getAll().find((entry) => entry.id === 'air-quality');
      return {
        enabled,
        settled: answered(),
        stats: mod.getStats(),
        requiresKeyId: row?.requiresKeyId ?? null,
        rowSource: row?.stats?.source ?? null,
        states: mod.getProviderStates().map((s) => [s.id, s.status]),
      };
    });
    const turnedOn =
      keyless.enabled === true &&
      keyless.settled === true &&
      keyless.stats?.error === null &&
      keyless.stats?.keyRequired === true &&
      keyless.stats?.loadingLabel === 'KEY REQUIRED';
    record(
      'keyless, the layer turns on and reports its key as required, not as an error',
      turnedOn,
      `enabled=${keyless.enabled} settled=${keyless.settled} error=${keyless.stats?.error} keyRequired=${keyless.stats?.keyRequired} label=${keyless.stats?.loadingLabel} source="${keyless.rowSource}" states=${JSON.stringify(keyless.states)}`,
    );
    if (!turnedOn) exitCode = 1;

    // The Layers row: not UNAVAILABLE, says KEY REQUIRED, and its title names
    // the OpenAQ key.
    let toggle = null;
    await openDataLayers(page);
    for (let i = 0; i < 20 && !/KEY REQUIRED/.test(toggle?.meta ?? ''); i++) {
      await sleep(250);
      toggle = await page.evaluate(() => {
        const row = document.querySelector('[data-layer-id="air-quality"]');
        const button = row?.querySelector('.data-toggle-btn');
        return button
          ? {
              state: button.dataset.feedState,
              title: button.title,
              meta: row.querySelector('.data-toggle-meta')?.textContent ?? '',
            }
          : null;
      });
    }
    const rowOk =
      toggle !== null &&
      toggle.state !== 'unavailable' &&
      /KEY REQUIRED/.test(toggle.meta) &&
      /OPENAQ_API_KEY/.test(toggle.title) &&
      JSON.stringify(keyless.requiresKeyId) === JSON.stringify(['openaq']);
    record(
      'the Layers row is not UNAVAILABLE, says KEY REQUIRED and names the missing key',
      rowOk,
      toggle
        ? `state=${toggle.state} meta="${toggle.meta}" title="${toggle.title}" requiresKeyId=${JSON.stringify(keyless.requiresKeyId)}`
        : 'no row',
    );
    if (!rowOk) exitCode = 1;

    const controls = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('air-quality')
          ?.module.getRowControls?.() || null,
    );
    const indexTiles =
      controls?.sublists?.find((group) => group.id === 'index')?.tiles ?? [];
    const cardOk =
      controls?.readout === true &&
      indexTiles.length === 1 &&
      indexTiles[0].id === 'aqi' &&
      indexTiles[0].active === true &&
      controls.sublists?.find((group) => group.id === 'pollutants')?.tiles
        .length === 6 &&
      controls.legendCategorical === false &&
      JSON.stringify(controls.legend?.map((band) => band.label)) ===
        JSON.stringify(['0', '50', '100', '150', '200', '300+']) &&
      JSON.stringify(controls.summary?.lines?.map((line) => line.text)) ===
        JSON.stringify(['OpenAQ: add a key in Provider Settings']) &&
      controls.summary?.compact === 'OpenAQ: add a key in Provider Settings' &&
      !/AQHI|Canada/.test(JSON.stringify(controls));
    record(
      'the card offers the US AQI as its one index, the six pollutants, the US AQI ramp and the key to add',
      cardOk,
      controls
        ? `index=${indexTiles.map((tile) => tile.id).join('/')} bands=${controls.legend?.map((band) => band.label).join('/')} lines=${JSON.stringify(controls.summary?.lines?.map((line) => line.text))}`
        : 'no descriptor',
    );
    if (!cardOk) exitCode = 1;

    // The Weather card itself, opened: the US AQI tile spans its row.
    await page.evaluate(() => {
      const card = document.querySelector('[data-card-id="air-quality"]');
      if (card?.dataset.open !== 'true') card?.querySelector('button')?.click();
    });
    let tile = null;
    for (let i = 0; i < 20 && !tile; i++) {
      await sleep(250);
      tile = await page.evaluate(() => {
        const button = document.querySelector(
          '[data-card-id="air-quality"] [data-tile-id="aqi"]',
        );
        const grid = button?.parentElement;
        if (!button || !grid || !grid.getBoundingClientRect().width)
          return null;
        return {
          tile: button.getBoundingClientRect().width,
          grid: grid.getBoundingClientRect().width,
          tiles: grid.querySelectorAll('[data-tile-id]').length,
        };
      });
    }
    const spans =
      tile !== null && tile.tiles === 1 && Math.abs(tile.tile - tile.grid) < 1;
    record(
      'the US AQI tile spans its row',
      spans,
      tile
        ? `tile ${tile.tile.toFixed(1)} px of ${tile.grid.toFixed(1)} px, ${tile.tiles} tile(s)`
        : 'no tile on screen',
    );
    if (!spans) exitCode = 1;

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
      const images = window.__godsEyeView.viewer.imageryLayers;
      const ids = (window.__aqFieldIds ??= new WeakMap());
      window.__aqFieldSeq ??= 0;
      const fieldImageIds = [];
      for (let i = 0; i < (images?.length ?? 0); i++) {
        const image = images.get(i);
        const canvas = image.imageryProvider?.image;
        if (
          image.show &&
          image.alpha > 0 &&
          canvas instanceof HTMLCanvasElement
        ) {
          if (!ids.has(canvas)) ids.set(canvas, ++window.__aqFieldSeq);
          fieldImageIds.push(ids.get(canvas));
        }
      }
      fieldImageIds.sort((a, b) => a - b);
      return {
        subtitle: controls.sublists[0]?.subtitle,
        detail: controls.summary.detail,
        aqi: tile('index', 'aqi'),
        pm25: tile('pollutants', 'PM2.5'),
        coverage: worldClock.coverage(),
        follows: worldClock.follows('air-quality'),
        supported: worldClock.getState().supported,
        fieldImages: fieldImageIds.length,
        fieldImageIds,
      };
    });
  let now = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    now = await read();
    if (
      now.subtitle === 'model at view centre' &&
      now.pm25 !== '—' &&
      now.fieldImages === 2
    )
      break;
  }
  record(
    'with a field the tiles read the model at the view centre',
    now?.subtitle === 'model at view centre' && now.pm25 !== '—',
    `subtitle="${now?.subtitle}" PM2.5=${now?.pm25} US AQI=${now?.aqi} detail="${now?.detail}"`,
  );
  record(
    'the field draws on the globe: the global image and the Europe inset',
    now?.fieldImages === 2,
    'visible field images: ' + now?.fieldImages,
  );
  // The layer gives the clock exactly its run's span; other layers on the
  // timeline may widen the timeline's, which must hold the forecast.
  const spans =
    now?.coverage?.start <= FIELD_RUN &&
    now.coverage.end >= FIELD_RUN + 24 * HOUR &&
    now.follows === true &&
    now.supported === true;
  record(
    'the timeline spans the forecast',
    spans,
    JSON.stringify({ coverage: now?.coverage, follows: now?.follows }),
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
    if (
      /forecast for/.test(later.detail) &&
      later.pm25 !== now?.pm25 &&
      later.fieldImages === 2 &&
      later.fieldImageIds.join() !== now.fieldImageIds.join()
    )
      break;
  }
  record(
    'scrubbing to +24 h draws that step: the tiles change',
    /forecast for/.test(later?.detail) &&
      later.pm25 !== now?.pm25 &&
      later.pm25 !== '—' &&
      later.fieldImages === 2 &&
      later.fieldImageIds.join() !== now.fieldImageIds.join(),
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
