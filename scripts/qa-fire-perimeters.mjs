#!/usr/bin/env node
/**
 * Fire Perimeters browser gate: live source health, then synthetic INFONA
 * and WFIGS polygons through the real normalizers, renderer and mouse input.
 * Checks painted card text, separate legend counts, deselection and disable.
 * No provider data is bundled. Synthetic clicks do not prove live fire activity.
 *
 * PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node scripts/qa-fire-perimeters.mjs --url http://localhost:4174 --headful
 * Headful uses the native GPU; headless uses SwiftShader. Evidence is saved
 * under qa-artifacts/fire-perimeters/. Requires a running dev/preview server.
 * Preview's expected 404 for development-only /api/setup/status is recorded;
 * every other console error fails the gate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import {
  normalizeFirePerimeterSnapshot,
  normalizeInfonaPerimeterSnapshot,
} from '../src/layers/perimeters/records.js';
import { redact } from './qa-browserEvidence.mjs';

const args = process.argv.slice(2);
const url = args.includes('--url')
  ? args[args.indexOf('--url') + 1]
  : 'http://localhost:4173';
const headful = args.includes('--headful');
const dir = new URL('../qa-artifacts/fire-perimeters/', import.meta.url);
await fs.mkdir(dir, { recursive: true });
await fs.rm(new URL('failure.png', dir), { force: true });
const result = { checks: [], consoleErrors: [], pageErrors: [] };
const check = (name, condition) => {
  assert.ok(condition, name);
  result.checks.push(name);
  console.log(`PASS ${name}`);
};
// Canvas pixels work in both development and production, without a debug facade.
function paintedOverlayPixels() {
  const canvas = document.getElementById('world-overlay-canvas');
  if (!canvas) return 0;
  const pixels = canvas
    .getContext('2d')
    .getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++;
  return count;
}
const square = (lon, lat) => [
  [lon - 0.0013, lat - 0.0013],
  [lon + 0.0013, lat - 0.0013],
  [lon + 0.0013, lat + 0.0013],
  [lon - 0.0013, lat + 0.0013],
  [lon - 0.0013, lat - 0.0013],
];
const rows = [
  ...normalizeInfonaPerimeterSnapshot({
    features: [
      {
        properties: {
          id: 'qa-infona',
          date: Date.UTC(2026, 9, 15),
          sup_ha: 7.36,
          dist_desc: 'QA DISTRICT',
          dpto_desc: 'QA DEPARTMENT',
        },
        geometry: { type: 'Polygon', coordinates: [square(-57.5, -25)] },
      },
    ],
  }),
  ...normalizeFirePerimeterSnapshot({
    features: [
      {
        properties: {
          attr_UniqueFireIdentifier: 'qa-wfigs',
          poly_IncidentName: 'QA US FIRE',
          attr_IncidentSize: 100,
          attr_PercentContained: 50,
          attr_POOState: 'US-TX',
        },
        geometry: { type: 'Polygon', coordinates: [square(-97.5, 30.5)] },
      },
    ],
  }),
];
let browser;
let page;
try {
  const response = await fetch(new URL('/api/fire-perimeters', url), {
    signal: AbortSignal.timeout(180_000),
  });
  const live = await response.json();
  result.live = {
    status: response.status,
    checkedAt: new Date().toISOString(),
    fetchedAt: live.fetchedAt,
    sources: live.sources,
    wfigs: live.rows?.filter((row) => row.source !== 'INFONA').length,
    infona: live.rows?.filter((row) => row.source === 'INFONA').length,
  };
  check(
    'live WFIGS and INFONA return complete, healthy snapshots (empty is valid)',
    response.ok &&
      ['wfigs', 'infona'].every(
        (id) =>
          live.sources?.[id]?.status === 'ok' &&
          live.sources[id].truncated === false,
      ),
  );
  browser = await puppeteer.launch({
    headless: !headful,
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      ...(headful ? [] : ['--use-angle=swiftshader']),
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.bringToFront();
  page.on('pageerror', (error) =>
    result.pageErrors.push(redact(error.message)),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      result.consoleErrors.push({
        message: redact(message.text()),
        url: redact(message.location().url),
      });
  });
  await page.evaluateOnNewDocument((fixtureRows) => {
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
    window.__qaPerimeterText = new Set();
    const paint = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (
        /FIRE|estimated|contained|QA DISTRICT|INFONA|Report date|100 ac/.test(
          String(text),
        )
      )
        window.__qaPerimeterText.add(String(text));
      return paint.call(this, text, ...rest);
    };
    // Network interception stalls Cesium's geometry workers on some browsers.
    // Replace only these fetch routes; workers and map resources remain real.
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const target = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
        location.href,
      );
      if (target.origin === location.origin) {
        if (target.pathname === '/api/fire-perimeters/inciweb/index')
          return Promise.resolve(Response.json([]));
        if (target.pathname === '/api/fire-perimeters')
          return Promise.resolve(
            Response.json({
              rows: fixtureRows,
              fetchedAt: Date.now(),
              sources: { wfigs: { status: 'ok' }, infona: { status: 'ok' } },
            }),
          );
      }
      return original(input, init);
    };
  }, rows);
  await page.goto(new URL('/?welcome=0', url).href, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90_000 },
  );
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.keyboard.press('Escape');
  result.mode = await page.evaluate(() =>
    document.querySelector('script[src="/@vite/client"]') ? 'dev' : 'preview',
  );
  result.renderer = await page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  console.log('Renderer:', result.renderer);
  if (headful)
    check(
      'headful uses hardware rendering',
      !/swiftshader|llvmpipe|software/i.test(result.renderer),
    );
  const legend = await page.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;
    for (const [id, state] of dataManager.layers)
      if (state.enabled) await dataManager.setEnabled(id, false);
    await dataManager.setEnabled('fire-perimeters', true);
    return dataManager.layers.get('fire-perimeters').module.getRowControls()
      .legend;
  });
  check(
    'INFONA and US containment have separate legend counts',
    JSON.stringify(legend.map((band) => band.count)) === '[0,0,1,0,1]' &&
      legend[4].color === '#b388ff',
  );
  for (const [row, lon, lat, expected] of [
    [
      rows[0],
      -57.5,
      -25,
      [
        'FIRE ESTIMATE · QA DISTRICT',
        '7.36 ha estimated',
        'INFONA · grouped thermal detections',
        'Report date: 2026-10-15',
      ],
    ],
    [
      rows[1],
      -97.5,
      30.5,
      ['FIRE · QA US FIRE', '100 ac · 50% contained · US-TX'],
    ],
  ]) {
    await page.evaluate(
      (longitude, latitude) => {
        const { viewer } = window.__godsEyeView;
        viewer.camera.cancelFlight();
        viewer.camera.setView({
          destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
            longitude: (longitude * Math.PI) / 180,
            latitude: (latitude * Math.PI) / 180,
            height: 1800,
          }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        viewer.scene.requestRender();
      },
      lon,
      lat,
    );
    await page.waitForFunction(
      (id) => {
        const { viewer } = window.__godsEyeView;
        viewer.scene.requestRender();
        const picked = viewer.scene.pick({
          x: viewer.canvas.clientWidth / 2,
          y: viewer.canvas.clientHeight / 2,
        });
        return (picked?.id?.id ?? picked?.id) === `fire-perimeter:${id}:0`;
      },
      { timeout: 60_000, polling: 250 },
      row.stableId,
    );
    const points = await page.evaluate(() => {
      const canvas = window.__godsEyeView.viewer.canvas;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + canvas.clientWidth / 2,
        y: rect.top + canvas.clientHeight / 2,
      };
    });
    const beforePixels = await page.evaluate(paintedOverlayPixels);
    await page.mouse.click(points.x, points.y);
    await page.waitForFunction(
      `(${paintedOverlayPixels})() > ${beforePixels + 100}`,
      { timeout: 15_000 },
    );
    const text = await page.evaluate(() => [...window.__qaPerimeterText]);
    check(
      `${row.source || 'WFIGS'} real polygon click paints the correct card`,
      expected.every((line) => text.includes(line)),
    );
    if (row.source === 'INFONA') {
      check(
        'INFONA card has no containment or InciWeb claims',
        !text.some((line) => /contained|InciWeb/.test(line)),
      );
      result.infonaCardText = text;
    }
    await page.screenshot({
      path: new URL(`${row.source || 'WFIGS'}-selected.png`, dir).pathname,
    });
    await page.mouse.click(points.x + 350, points.y);
    await page.waitForFunction(
      `(${paintedOverlayPixels})() <= ${beforePixels}`,
      { timeout: 10_000 },
    );
    check(`${row.source || 'WFIGS'} empty-ground click clears the card`, true);
  }
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('fire-perimeters', false),
  );
  check(
    'disabling hides perimeter geometry',
    await page.evaluate(
      () =>
        !window.__godsEyeView.viewer.dataSources.getByName('fire-perimeters')[0]
          .show,
    ),
  );
  assert.deepEqual(result.pageErrors, [], 'no uncaught page errors');
  // previewServing.test.mjs requires the credential-editing API to stay dev-only.
  const expectedSetup404 = (entry) =>
    result.mode === 'preview' &&
    entry.url === new URL('/api/setup/status', url).href &&
    entry.message.includes('status of 404');
  result.expectedConsoleErrors = result.consoleErrors.filter(expectedSetup404);
  assert.deepEqual(
    result.consoleErrors.filter((entry) => !expectedSetup404(entry)),
    [],
    'no unexpected console errors',
  );
  if (result.expectedConsoleErrors.length)
    console.log(
      `Expected preview-only setup 404: ${result.expectedConsoleErrors.length}`,
    );
  check('browser has no unexpected console or page errors', true);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = redact(error.stack || error.message);
  console.error(result.error);
  process.exitCode = 1;
  await page
    ?.screenshot({ path: new URL('failure.png', dir).pathname })
    .catch(() => {});
} finally {
  await fs.writeFile(
    new URL('result.json', dir),
    JSON.stringify(result, null, 2),
  );
  await browser?.close();
}
