#!/usr/bin/env node
/**
 * Real-application gate with invented OGC fixtures, not a live-provider check.
 * npm run dev, then node scripts/qa-usgs-water.mjs [--url http://localhost:4173]
 * Use --headful for a real GPU; default is full headless Chrome/SwiftShader.
 * Evidence is written under ignored qa-shots/usgs-water. No real USGS rows are saved.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { USGS_WATER_LAYER_ID as ID } from '../src/layers/usgsWater/config.js';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';
import { usgsWaterFixturePage } from './qa-usgs-water-fixtures.mjs';
import {
  watchPage,
  hookRenderErrors,
  readRenderErrors,
} from './qa-browserEvidence.mjs';

const argv = process.argv.slice(2);
const base = new URL(
  argv.includes('--url')
    ? argv[argv.indexOf('--url') + 1]
    : 'http://localhost:4173',
);
if (
  !['http:', 'https:'].includes(base.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
)
  throw new Error('USGS fixture gate requires loopback');
const shots = path.resolve(process.env.QA_SHOTS_DIR || 'qa-shots/usgs-water');
await fs.mkdir(shots, { recursive: true });
const results = { checks: [], errors: [], scenarios: [] };
function check(name, condition, details) {
  results.checks.push({ name, passed: Boolean(condition), details });
  assert.ok(condition, name);
  console.log('PASS:', name);
}
const browser = await puppeteer.launch({
  headless: !argv.includes('--headful'),
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  protocolTimeout: 60000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(argv.includes('--headful')
      ? []
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
const contexts = [];

async function scenario(name, url, fail = false) {
  const context = await browser.createBrowserContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const state = {
    name,
    requests: [],
    fixtureErrors: [],
    fail,
    now: Date.now(),
  };
  results.scenarios.push(state);
  const monitor = watchPage(page, { name, errors: results.errors });
  await hookRenderErrors(page);
  await page.evaluateOnNewDocument(() => {
    window.__waterDrawn = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (value, ...args) {
      const text = String(value);
      if (
        window.__waterDrawn.length < 12000 &&
        !window.__waterDrawn.includes(text)
      )
        window.__waterDrawn.push(text);
      return original.call(this, value, ...args);
    };
  });
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const target = new URL(request.url());
    if (target.origin !== 'https://api.waterdata.usgs.gov') {
      await request.continue().catch(() => {});
      return;
    }
    state.requests.push(target.href);
    try {
      assert.equal(request.method(), 'GET');
      assert.equal(target.searchParams.get('f'), 'json');
      assert.equal(target.searchParams.get('api_key'), null);
      assert.match(
        target.pathname,
        /^\/ogcapi\/v1\/collections\/(latest-continuous|monitoring-locations|time-series-metadata)\/items$/,
      );
      if (target.pathname.includes('latest-continuous')) {
        assert.equal(
          target.searchParams.get('bbox'),
          '-98.85,29.05,-98.08,29.85',
        );
        const start = Date.parse(
          target.searchParams.get('datetime')?.split('/')[0],
        );
        assert.ok(
          Math.abs(Date.now() - 86400000 - start) < 120000,
          'dynamic observation window',
        );
      }
      const payload = usgsWaterFixturePage(target, state.now);
      await request.respond({
        status: state.fail ? 429 : 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Retry-After': '0' },
        contentType: 'application/geo+json',
        body: JSON.stringify(payload),
      });
    } catch (error) {
      state.fixtureErrors.push(error.message);
      await request
        .respond({ status: 400, contentType: 'application/json', body: '{}' })
        .catch(() => {});
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView?.dataManager?.layers.has(id) &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
    ID,
  );
  return { page, context, state, monitor };
}
async function toggle(page) {
  await page.evaluate(
    (id) =>
      document
        .querySelector(`[data-layer-id="${id}"] .data-toggle-btn`)
        .click(),
    ID,
  );
}
async function loaded(page) {
  await page.waitForFunction(
    (id) => {
      const s = window.__godsEyeView.dataManager.layers
        .get(id)
        .module.getStats();
      return s.count === 2 && !s.loading && !s.error;
    },
    { timeout: 60000 },
    ID,
  );
}
async function stats(page) {
  return page.evaluate(
    (id) => window.__godsEyeView.dataManager.layers.get(id).module.getStats(),
    ID,
  );
}
async function drawFrame(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const s = window.__godsEyeView.viewer.scene;
        const stop = s.postRender.addEventListener(() => {
          stop();
          resolve();
        });
        s.requestRender();
      }),
  );
}
async function plainScene(page) {
  await page.evaluate(async () => {
    const C = await import('/node_modules/cesium/Build/Cesium/index.js');
    window.__waterCesium = C;
    const v = window.__godsEyeView.viewer;
    v.camera.cancelFlight();
    v.imageryLayers.removeAll();
    v.terrainProvider = new C.EllipsoidTerrainProvider();
    v.scene.globe.show = true;
    v.scene.globe.baseColor = C.Color.fromCssColorString('#20252a');
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-98.496, 29.422, 6500),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await drawFrame(page);
}
async function resources(page) {
  return page.evaluate((id) => {
    const v = window.__godsEyeView.viewer;
    const result = [];
    for (let i = 0; i < v.dataSources.length; i++) {
      const d = v.dataSources.get(i);
      if (d.name === id) result.push(d.entities.values.map((e) => e.id));
    }
    return result;
  }, ID);
}
async function pickSite(page, id, lon, lat) {
  await drawFrame(page);
  // A loaded data source can precede its clamped point's first rendered frame.
  // Wait for the same observable pick asserted below, without accepting an
  // absent marker or changing the production renderer.
  await page.waitForFunction(
    ({ id, lon, lat }) => {
      const C = window.__waterCesium,
        s = window.__godsEyeView.viewer.scene;
      s.requestRender();
      const point = C.SceneTransforms.worldToWindowCoordinates(
        s,
        C.Cartesian3.fromDegrees(lon, lat),
      );
      return (
        point &&
        s.drillPick(point, 20).some((hit) => {
          const value = hit?.id ?? hit?.primitive?.id;
          return (typeof value === 'object' ? value?.id : value) === id;
        })
      );
    },
    { timeout: 30000 },
    { id, lon, lat },
  );
  const point = await page.evaluate(
    ({ id, lon, lat }) => {
      const C = window.__waterCesium,
        s = window.__godsEyeView.viewer.scene;
      const p = C.SceneTransforms.worldToWindowCoordinates(
        s,
        C.Cartesian3.fromDegrees(lon, lat),
      );
      if (!p) return null;
      const picked = s.drillPick(p, 20).map((hit) => {
        const v = hit?.id ?? hit?.primitive?.id;
        return typeof v === 'object' ? v?.id : v;
      });
      return { x: p.x, y: p.y, picked };
    },
    { id, lon, lat },
  );
  check(`${id} is rendered and pickable`, point?.picked.includes(id), point);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(
    ({ layer, id }) =>
      window.__godsEyeView.dataManager.layers.get(layer).module.getStats()
        .selectedId === id,
    {},
    { layer: ID, id },
  );
  await drawFrame(page);
}
async function chip(page, id) {
  await page.waitForFunction(
    ({ layer, id }) =>
      document.querySelector(
        `[data-layer-id="${layer}"] [data-chip-id="${id}"]`,
      ),
    {},
    { layer: ID, id },
  );
  await page.evaluate(
    ({ layer, id }) =>
      document
        .querySelector(`[data-layer-id="${layer}"] [data-chip-id="${id}"]`)
        .click(),
    { layer: ID, id },
  );
  await drawFrame(page);
}
async function finish(scenario) {
  check(
    `${scenario.state.name} obeys the OGC query contract`,
    scenario.state.fixtureErrors.length === 0,
    scenario.state.fixtureErrors,
  );
  check(
    `${scenario.state.name} has no uncaught page errors`,
    scenario.monitor.console.every((row) => row.type !== 'pageerror'),
    scenario.monitor.console.filter((row) => row.type === 'pageerror'),
  );
  const errors = await readRenderErrors(scenario.page);
  check(
    `${scenario.state.name} has no Cesium render errors`,
    errors.length === 0,
    errors,
  );
  await scenario.context.close();
}

try {
  const url = new URL(base);
  url.searchParams.set('welcome', '0');
  const normal = await scenario('normal', url.href);
  const { page, state } = normal;
  check('USGS is lazy at startup', state.requests.length === 0);
  check(
    'water control starts disabled',
    !(await page.evaluate(
      (id) => window.__godsEyeView.dataManager.isEnabled(id),
      ID,
    )),
  );
  await plainScene(page);
  await toggle(page);
  await loaded(page);
  await drawFrame(page);
  check(
    'seven series group into two sites including a null-only station',
    (await stats(page)).readingCount === 7 &&
      (await resources(page))[0]?.length === 2,
  );
  check(
    'zero and negative stage remain numeric; missing values stay missing',
    (await stats(page)).numericReadingCount === 3,
  );
  await page.screenshot({ path: path.join(shots, '01-sites.png') });
  await pickSite(page, 'USGS-08100001', -98.5, 29.42);
  for (let i = 0; i < 4; i++) {
    await chip(page, 'next-reading');
  }
  const drawn = await page.evaluate(() => window.__waterDrawn.join('\n'));
  for (const text of [
    'QA Creek',
    'Bexar County',
    'Provisional',
    '-0.75 ft',
    '0.00 ft',
    '0.00 in',
    'No numeric reading',
    'Observed',
    'Retrieved',
    'UNAVAIL',
    'Upstream',
    'Downstream',
    'not a 24-hour rainfall total',
    'not necessarily river depth',
  ])
    check(`card draws ${text}`, drawn.includes(text));
  check(
    'provider text cannot execute HTML',
    await page.evaluate(
      () =>
        !window.__waterInjection &&
        !document.querySelector('img[src="qa-water-injection"]'),
    ),
  );
  await page.screenshot({ path: path.join(shots, '02-reading.png') });
  // The selected source card correctly owns clicks above the map. Clear it
  // before probing a nearby marker that might sit behind that card.
  await page.mouse.click(800, 820);
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getStats()
        .selectedId === null,
    {},
    ID,
  );
  await pickSite(page, 'USGS-295000098200001', -98.492, 29.424);
  check(
    'neighboring county remains distinct',
    (await page.evaluate(() => window.__waterDrawn.join('\n'))).includes(
      'Comal County',
    ),
  );
  await chip(page, 'bexar');
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getStats()
        .count === 1,
    {},
    ID,
  );
  check(
    'Bexar filters sites without downloading again',
    (await resources(page))[0].length === 1 && state.requests.length === 9,
  );
  await chip(page, 'all');
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getStats()
        .count === 2,
    {},
    ID,
  );
  await toggle(page);
  await page.waitForFunction(
    (id) => !window.__godsEyeView.dataManager.isEnabled(id),
    {},
    ID,
  );
  check(
    'disable releases graphics, selected card and records',
    (await resources(page)).length === 0 &&
      (await stats(page)).selectedId === null,
  );
  await toggle(page);
  await loaded(page);
  check(
    're-enable reuses the observation/metadata cache',
    state.requests.length === 9,
  );
  const token = LAYER_STATE_REGISTRY.find((row) => row.id === ID).token;
  await page.waitForFunction(
    (token) => new URLSearchParams(location.hash.slice(1)).get('l') === token,
    {},
    token,
  );
  const authored = page.url();
  await finish(normal);
  const recipient = await scenario('share-recipient', authored);
  await loaded(recipient.page);
  check(
    'fresh share recipient restores only the authored water layer',
    await recipient.page.evaluate((id) => {
      const dm = window.__godsEyeView.dataManager;
      return (
        [...dm.layers.keys()].filter((key) => dm.isEnabled(key)).join() === id
      );
    }, ID),
  );
  await finish(recipient);
  const failure = await scenario('rate-limit', url.href, true);
  await toggle(failure.page);
  await failure.page.waitForFunction(
    (id) => {
      const s = window.__godsEyeView.dataManager.layers
        .get(id)
        .module.getStats();
      return !s.loading && s.retryAt !== null;
    },
    {},
    ID,
  );
  check(
    '429 rolls back first enable and leaves no orphan markers',
    (await resources(failure.page)).length === 0 &&
      !(await failure.page.evaluate(
        (id) => window.__godsEyeView.dataManager.isEnabled(id),
        ID,
      )),
  );
  await toggle(failure.page);
  check(
    'immediate retry respects cooldown without another request',
    failure.state.requests.length === 1,
  );
  failure.state.fail = false;
  await failure.page.waitForFunction(
    (id) =>
      Date.now() >=
      window.__godsEyeView.dataManager.layers.get(id).module.getStats().retryAt,
    {},
    ID,
  );
  await toggle(failure.page);
  await loaded(failure.page);
  check(
    'rate-limit retry recovers through the real UI',
    (await stats(failure.page)).count === 2,
  );
  await finish(failure);
} catch (error) {
  results.errors.push(error.stack || error.message);
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  results.passed =
    !results.errors.length && results.checks.every((check) => check.passed);
  await fs.writeFile(
    path.join(shots, 'result.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(
    `RESULT: ${results.passed ? 'PASS' : 'FAIL'}; ${results.checks.length} checks; evidence ${shots}`,
  );
  if (!results.passed) {
    process.exitCode = 1;
    console.error(results.errors.join('\n'));
  }
}
