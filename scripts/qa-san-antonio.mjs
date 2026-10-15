#!/usr/bin/env node
/**
 * Deterministic browser gate for San Antonio parks, trails and trailheads.
 *
 * Run against a local Vite server:
 *   node scripts/qa-san-antonio.mjs --url http://localhost:4173
 * Add --headless-shell to use Puppeteer's dedicated headless browser binary.
 *
 * Only the three City ArcGIS service roots are intercepted. Metadata, counts
 * and one-record GeoJSON pages come from synthetic fixtures; no City request
 * reaches the provider. The real catalog, source, renderer, controls, picking,
 * shared cards and share restoration remain in use. This proves integration,
 * not the current availability or completeness of the live City datasets.
 *
 * After startup, an isolated page uses ellipsoid terrain and a plain globe so
 * geometry evidence does not depend on streamed imagery or terrain. Basemap
 * startup is otherwise the normal app; use a keyless dev server for this gate.
 * Screenshots and the verdict are saved under qa-shots/san-antonio/ by default.
 * The process exits nonzero on a failed check and never changes source data.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { SAN_ANTONIO_DATASETS } from '../src/layers/sanAntonio/config.js';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';
import {
  hookRenderErrors,
  readRenderErrors,
  redact,
  watchPage,
} from './qa-browserEvidence.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith('--'))
    throw new Error(`Missing value for ${name}`);
  return argv[index + 1];
};
if (argv.includes('--help')) {
  console.log(
    'Usage: node scripts/qa-san-antonio.mjs [--url http://localhost:4173] [--headful | --headless-shell]',
  );
  process.exit(0);
}
const base = new URL(
  option('--url', process.env.QA_BASE_URL || 'http://localhost:4173'),
);
if (
  !['http:', 'https:'].includes(base.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
)
  throw new Error('The fixture gate requires a loopback dev server');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.resolve(
  process.env.QA_SHOTS_DIR || path.join(root, 'qa-shots', 'san-antonio'),
);
const ids = [
  'san-antonio-parks',
  'san-antonio-trails',
  'san-antonio-trailheads',
];
assert.deepEqual(
  SAN_ANTONIO_DATASETS.map(({ id }) => id),
  ids,
);
const sourceDate = Date.UTC(2026, 0, 2, 12);
const injectedName =
  'QA Polygon <img src="qa-san-antonio-invalid" onerror="window.__qaCityInjection=1">';
const rectangle = (west, south, east, north) => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];
const feature = (id, geometry, properties) => ({
  type: 'Feature',
  id,
  geometry,
  properties: { OBJECTID: id, ...properties },
});
const fixtures = {
  'san-antonio-parks': [
    feature(
      1,
      {
        type: 'Polygon',
        coordinates: [
          rectangle(-98.503, 29.423, -98.497, 29.429),
          rectangle(-98.501, 29.425, -98.499, 29.427).reverse(),
        ],
      },
      {
        ParkID: 'QA-1',
        ParkName: injectedName,
        AltParkName: null,
        ParkType: 'Park',
      },
    ),
    feature(
      2,
      {
        type: 'MultiPolygon',
        coordinates: [
          [rectangle(-98.493, 29.42, -98.49, 29.423)],
          [rectangle(-98.486, 29.42, -98.483, 29.423)],
        ],
      },
      {
        ParkID: 'QA-2',
        ParkName: 'QA Multipart Park',
        AltParkName: null,
        ParkType: 'Greenway',
      },
    ),
  ],
  'san-antonio-trails': [
    feature(
      1,
      {
        type: 'LineString',
        coordinates: [
          [-98.502, 29.433],
          [-98.497, 29.433],
          [-98.495, 29.435],
        ],
      },
      {
        Trail_ID: 'QA-1',
        TrailType: 'Trail',
        TrailSubtype: 'Paved',
        TrailName: 'QA Trail Segment',
        TrailMiles: 0.42,
        TrailSource: 'QA fixture',
      },
    ),
    feature(
      2,
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [-98.493, 29.433],
            [-98.489, 29.433],
          ],
          [
            [-98.486, 29.433],
            [-98.482, 29.433],
          ],
        ],
      },
      {
        Trail_ID: 'QA-2',
        TrailType: 'Connector',
        TrailSubtype: null,
        TrailName: 'QA Multipart Trail',
        TrailMiles: 0,
        TrailSource: 'QA fixture',
      },
    ),
  ],
  'san-antonio-trailheads': [
    feature(
      1,
      { type: 'Point', coordinates: [-98.493, 29.427] },
      { Name: 'QA Trailhead One' },
    ),
    feature(
      2,
      { type: 'Point', coordinates: [-98.485, 29.427] },
      { Name: 'QA Trailhead Two' },
    ),
  ],
};
const targets = [
  {
    label: 'polygon fill',
    id: `${ids[0]}:1`,
    lon: -98.502,
    lat: 29.424,
    title: 'QA Polygon',
  },
  {
    label: 'multipart polygon first island',
    id: `${ids[0]}:2`,
    lon: -98.4915,
    lat: 29.4215,
  },
  {
    label: 'multipart polygon second island',
    id: `${ids[0]}:2`,
    lon: -98.4845,
    lat: 29.4215,
  },
  {
    label: 'line',
    id: `${ids[1]}:1`,
    lon: -98.4995,
    lat: 29.433,
    title: 'QA Trail Segment',
  },
  {
    label: 'multiline first part',
    id: `${ids[1]}:2`,
    lon: -98.491,
    lat: 29.433,
  },
  {
    label: 'multiline second part',
    id: `${ids[1]}:2`,
    lon: -98.484,
    lat: 29.433,
  },
  {
    label: 'first point',
    id: `${ids[2]}:1`,
    lon: -98.493,
    lat: 29.427,
    title: 'QA Trailhead One',
  },
  { label: 'second point', id: `${ids[2]}:2`, lon: -98.485, lat: 29.427 },
];
const gaps = [
  { label: 'polygon hole', id: ids[0], lon: -98.5, lat: 29.426 },
  { label: 'multipart polygon gap', id: ids[0], lon: -98.488, lat: 29.4215 },
  { label: 'multiline gap', id: ids[1], lon: -98.4875, lat: 29.433 },
];
const result = { checks: [], scenarios: [], errors: [], screenshots: [] };
function check(label, actual, detail) {
  result.checks.push({
    label,
    pass: Boolean(actual),
    // Request arrays continue growing after a check; preserve its own evidence.
    ...(detail === undefined ? {} : { detail: structuredClone(detail) }),
  });
  assert.ok(
    actual,
    `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`,
  );
  console.log(`PASS: ${label}`);
}

/** Intercept these service roots only; leave Cesium workers unpaused. */
async function interceptCitySources(page, state) {
  const client = await page.createCDPSession();
  await client.send('Fetch.enable', {
    patterns: SAN_ANTONIO_DATASETS.map(({ serviceUrl }) => ({
      urlPattern: `${serviceUrl}*`,
    })),
  });
  client.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const respond = (status, body) =>
      client.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: status,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      });
    try {
      const url = new URL(request.url);
      const dataset = SAN_ANTONIO_DATASETS.find(({ serviceUrl }) => {
        const source = new URL(serviceUrl);
        return (
          url.origin === source.origin &&
          [source.pathname, `${source.pathname}/query`].includes(url.pathname)
        );
      });
      assert.ok(dataset, `Unexpected City service route: ${url.pathname}`);
      assert.equal(request.method, 'GET');
      const record = {
        dataset: dataset.id,
        query: Object.fromEntries(url.searchParams),
      };
      state.requests.push(record);
      if (state.failDataset === dataset.id) {
        record.kind = 'injected-failure';
        return await respond(503, {
          error: { code: 503, message: 'QA City GIS temporarily unavailable' },
        });
      }
      if (!url.pathname.endsWith('/query')) {
        record.kind = 'metadata';
        assert.equal(url.searchParams.get('f'), 'json');
        return await respond(200, {
          name: dataset.id,
          objectIdField: 'OBJECTID',
          geometryType:
            dataset.id === ids[0]
              ? 'esriGeometryPolygon'
              : dataset.id === ids[1]
                ? 'esriGeometryPolyline'
                : 'esriGeometryPoint',
          fields: dataset.fields.map((name) => ({
            name,
            type:
              name === 'OBJECTID'
                ? 'esriFieldTypeOID'
                : name === 'TrailMiles'
                  ? 'esriFieldTypeDouble'
                  : 'esriFieldTypeString',
          })),
          maxRecordCount: 1,
          supportedQueryFormats: 'JSON, geoJSON',
          advancedQueryCapabilities: {
            supportsPagination: true,
            supportsOrderBy: true,
          },
          editingInfo: {
            dataLastEditDate: sourceDate,
            lastEditDate: sourceDate,
          },
        });
      }
      assert.equal(url.searchParams.get('where'), '1=1');
      if (url.searchParams.get('returnCountOnly') === 'true') {
        record.kind = 'count';
        return await respond(200, { count: fixtures[dataset.id].length });
      }
      record.kind = 'page';
      assert.equal(url.searchParams.get('f')?.toLowerCase(), 'geojson');
      assert.equal(url.searchParams.get('returnGeometry'), 'true');
      assert.equal(url.searchParams.get('outSR'), '4326');
      assert.equal(url.searchParams.get('outFields'), dataset.fields.join(','));
      assert.equal(url.searchParams.get('orderByFields'), 'OBJECTID ASC');
      const offset = Number(url.searchParams.get('resultOffset'));
      const count = Number(url.searchParams.get('resultRecordCount'));
      assert.ok(Number.isInteger(offset) && offset >= 0 && offset < 2);
      assert.equal(count, 1, 'source honors the service page-size limit');
      return await respond(200, {
        type: 'FeatureCollection',
        features: fixtures[dataset.id].slice(offset, offset + count),
        exceededTransferLimit: offset + count < fixtures[dataset.id].length,
      });
    } catch (error) {
      state.errors.push(redact(error.stack || error.message));
      await respond(500, {
        error: { message: 'QA fixture contract failed' },
      }).catch(() => {});
    }
  });
}

async function createScenario(browser, name, url, failDataset = null) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const state = { name, requests: [], errors: [], failDataset };
  result.scenarios.push(state);
  const monitor = watchPage(page, { name, errors: result.errors });
  const scenario = { context, page, state, monitor };
  contexts.push(scenario);
  await hookRenderErrors(page);
  await page.evaluateOnNewDocument(() => {
    window.__qaCityRestoreEvents = [];
    window.addEventListener('gev:initial-share-restore-settled', (event) => {
      window.__qaCityRestoreEvents.push(event.detail);
    });
  });
  await interceptCitySources(page, state);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    (wanted) => {
      const app = window.__godsEyeView;
      return (
        wanted.every((id) => app?.dataManager?.layers?.has(id)) &&
        document.getElementById('loading-screen')?.classList.contains('hidden')
      );
    },
    { timeout: 60_000 },
    ids,
  );
  await page.evaluate(async () => {
    await window.__godsEyeView.styleManager.initialRestorePromise;
  });
  return scenario;
}

async function renderFrames(page, count = 3) {
  await page.evaluate(async (count) => {
    const scene = window.__godsEyeView.viewer.scene;
    for (let i = 0; i < count; i++) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          remove();
          reject(new Error('No Cesium postRender frame'));
        }, 5000);
        const remove = scene.postRender.addEventListener(() => {
          clearTimeout(timer);
          remove();
          resolve();
        });
        scene.requestRender();
      });
    }
  }, count);
}

async function preparePlainScene(page) {
  await page.evaluate(async () => {
    const C = await import('/node_modules/cesium/Build/Cesium/index.js');
    window.__qaCityCesium = C;
    const app = window.__godsEyeView;
    const viewer = app.viewer;
    viewer.camera.cancelFlight();
    viewer.imageryLayers.removeAll();
    if (app.tileset) app.tileset.show = false;
    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    viewer.scene.globe.show = true;
    viewer.scene.globe.baseColor = C.Color.fromCssColorString('#20252a');
    viewer.scene.globe.enableLighting = false;
    if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
    if (viewer.scene.sun) viewer.scene.sun.show = false;
    if (viewer.scene.moon) viewer.scene.moon.show = false;
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(-98.493, 29.427, 6000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.camera.moveEnd.raiseEvent();
    const canvas = document.getElementById('world-overlay-canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const original = ctx.fillText;
      window.__qaCityPaint = [];
      ctx.fillText = function (text, ...args) {
        const value = String(text);
        if (
          value.includes('QA ') ||
          value.includes('Source data edited') ||
          value.includes('City of San Antonio')
        ) {
          window.__qaCityPaint.push(value);
          if (window.__qaCityPaint.length > 300) window.__qaCityPaint.shift();
        }
        return original.call(this, text, ...args);
      };
    }
    viewer.scene.requestRender();
  });
  await renderFrames(page);
}

async function setPanel(page, open) {
  const collapsed = await page.$eval('#data-panel', (node) =>
    node.classList.contains('collapsed'),
  );
  if (collapsed === open)
    await page.locator('[data-collapse-target="data-panel"]').click();
}

async function toggle(page, id, enabled) {
  const current = await page.evaluate(
    (id) => window.__godsEyeView.dataManager.isEnabled(id),
    id,
  );
  if (current !== enabled) {
    await setPanel(page, true);
    await page.locator(`[data-layer-id="${id}"] .data-toggle-btn`).click();
  }
  await page.waitForFunction(
    (id, enabled) => window.__godsEyeView.dataManager.isEnabled(id) === enabled,
    {},
    id,
    enabled,
  );
}

async function waitLoaded(page, wanted = ids) {
  await page.waitForFunction(
    (wanted) =>
      wanted.every((id) => {
        const app = window.__godsEyeView;
        const stats = app?.dataManager?.layers.get(id)?.module?.getStats();
        app?.viewer?.scene?.requestRender();
        return stats && !stats.loading && (stats.count === 2 || stats.error);
      }),
    {},
    wanted,
  );
  const stats = await page.evaluate(
    (wanted) =>
      Object.fromEntries(
        wanted.map((id) => [
          id,
          window.__godsEyeView.dataManager.layers.get(id).module.getStats(),
        ]),
      ),
    wanted,
  );
  for (const id of wanted)
    check(
      `${id} loads both ordered fixture features`,
      stats[id].count === 2 &&
        stats[id].sourceCount === 2 &&
        !stats[id].error &&
        !stats[id].partial &&
        stats[id].sourceUpdatedAt === sourceDate,
      stats[id],
    );
  return stats;
}

async function resources(page) {
  return page.evaluate((ids) => {
    const app = window.__godsEyeView;
    const ground = app.viewer.scene.groundPrimitives;
    const primitives = [];
    for (let i = 0; i < ground.length; i++) {
      const primitive = ground.get(i);
      if (ids.includes(primitive.id))
        primitives.push({
          id: primitive.id,
          ready: primitive.ready,
          show: primitive.show,
        });
    }
    const dataSources = [];
    for (let i = 0; i < app.viewer.dataSources.length; i++) {
      const source = app.viewer.dataSources.get(i);
      if (ids.includes(source.name))
        dataSources.push({
          id: source.name,
          count: source.entities.values.length,
        });
    }
    return {
      primitives,
      dataSources,
      overlay: window.__gevWorldOverlay?.getDiagnostics?.(),
    };
  }, ids);
}

async function probeTargets(page, probes, exact = false) {
  return page.evaluate(
    (probes, exact) => {
      const C = window.__qaCityCesium;
      const scene = window.__godsEyeView.viewer.scene;
      const resolve = (pick) => {
        const value = pick?.id ?? pick?.primitive?.id;
        return typeof value === 'object' ? value?.id : value;
      };
      return probes.map((probe) => {
        const screen = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          C.Cartesian3.fromDegrees(probe.lon, probe.lat),
        );
        if (!screen) return { ...probe, visible: false, picked: [] };
        const offsets = exact
          ? [[0, 0]]
          : [
              [0, 0],
              [-3, 0],
              [3, 0],
              [0, -3],
              [0, 3],
            ];
        for (const [dx, dy] of offsets) {
          const at = new C.Cartesian2(screen.x + dx, screen.y + dy);
          const picked = scene
            .drillPick(at, 20, 1, 1)
            .map(resolve)
            .filter(Boolean);
          if (
            picked.some(
              (id) =>
                String(id) === probe.id ||
                String(id).startsWith(`${probe.id}:`),
            )
          )
            return { ...probe, x: at.x, y: at.y, visible: true, picked };
        }
        return {
          ...probe,
          x: screen.x,
          y: screen.y,
          visible: false,
          picked: [],
        };
      });
    },
    probes,
    exact,
  );
}

async function pixelDifferences(before, after, probes) {
  const a = await sharp(before)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const b = await sharp(after)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual(a.info, b.info);
  return probes.map(({ label, x, y }) => {
    let changed = 0;
    for (let dy = -5; dy <= 5; dy++)
      for (let dx = -5; dx <= 5; dx++) {
        const px = Math.round(x) + dx,
          py = Math.round(y) + dy;
        if (px < 0 || py < 0 || px >= a.info.width || py >= a.info.height)
          continue;
        const index = (py * a.info.width + px) * a.info.channels;
        const difference = [0, 1, 2].reduce(
          (sum, channel) =>
            sum + Math.abs(a.data[index + channel] - b.data[index + channel]),
          0,
        );
        if (difference > 24) changed++;
      }
    return { label, changed };
  });
}

async function screenshot(page, name) {
  const filename = path.join(shots, name);
  const bytes = await page.screenshot({ path: filename });
  result.screenshots.push(filename);
  return bytes;
}

async function finishScenario(scenario) {
  result.errors.push(...(await readRenderErrors(scenario.page)));
  check(
    `${scenario.state.name} fixture requests obey the source contract`,
    scenario.state.errors.length === 0,
    scenario.state.errors,
  );
  // Each scenario owns a fresh context. Release a finished globe before the
  // next one starts, especially when CI uses a software WebGL renderer.
  await scenario.context.close();
}

await fs.mkdir(shots, { recursive: true });
let browser;
const contexts = [];
try {
  browser = await puppeteer.launch({
    headless: argv.includes('--headful')
      ? false
      : argv.includes('--headless-shell')
        ? 'shell'
        : true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 60_000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
  const start = new URL(base.href);
  start.searchParams.set('welcome', '0');
  const normal = await createScenario(browser, 'normal', start.href);
  const { page, state } = normal;
  check(
    'City sources are not fetched while disabled at startup',
    state.requests.length === 0,
    state.requests,
  );
  check(
    'all three independent controls start disabled',
    await page.evaluate(
      (ids) =>
        ids.every(
          (id) =>
            !window.__godsEyeView.dataManager.isEnabled(id) &&
            document.querySelectorAll(
              `[data-layer-id="${id}"] .data-toggle-btn`,
            ).length === 1,
        ),
      ids,
    ),
  );
  check(
    'City layers have an explicit San Antonio panel group',
    await page.evaluate(() =>
      [...document.querySelectorAll('.data-layer-group-heading')].some(
        (node) => node.textContent === 'San Antonio',
      ),
    ),
  );
  await preparePlainScene(page);
  await setPanel(page, false);
  const empty = await screenshot(page, '01-disabled.png');
  for (const id of ids) await toggle(page, id, true);
  await waitLoaded(page);
  await setPanel(page, false);
  await page.waitForFunction(
    (ids) => {
      const scene = window.__godsEyeView.viewer.scene;
      scene.requestRender();
      const owned = [];
      for (let i = 0; i < scene.groundPrimitives.length; i++) {
        const primitive = scene.groundPrimitives.get(i);
        if (ids.includes(primitive.id)) owned.push(primitive);
      }
      return (
        ids
          .slice(0, 2)
          .every((id) => owned.some((primitive) => primitive.id === id)) &&
        owned.every((primitive) => primitive.ready && primitive.show)
      );
    },
    {},
    ids,
  );
  await renderFrames(page);
  const painted = await screenshot(page, '02-geometries.png');
  const picked = await probeTargets(page, targets);
  for (const probe of picked)
    check(
      `${probe.label} is rendered and pickable at its own coordinates`,
      probe.visible,
      probe,
    );
  for (const probe of await probeTargets(page, gaps, true))
    check(`${probe.label} remains empty`, !probe.visible, probe);
  for (const proof of await pixelDifferences(empty, painted, picked))
    check(
      `${proof.label} changes actual globe pixels`,
      proof.changed >= 3,
      proof,
    );
  for (const id of ids) {
    const calls = state.requests.filter((call) => call.dataset === id);
    check(
      `${id} uses both pages and verifies source count and date`,
      calls.filter(({ kind }) => kind === 'page').length === 2 &&
        calls.filter(({ kind }) => kind === 'metadata').length === 2 &&
        calls.filter(({ kind }) => kind === 'count').length === 2,
      calls,
    );
  }
  for (const target of picked.filter(({ title }) => title)) {
    const layerId = target.id.slice(0, target.id.lastIndexOf(':'));
    // A source card intentionally owns clicks above other geometry. Clear the
    // previous card through the UI before targeting a fixture beneath it.
    await page.mouse.click(1050, 650);
    await page.waitForFunction(
      (ids) =>
        ids.every(
          (id) =>
            window.__godsEyeView.dataManager.layers.get(id).module.getStats()
              .selectedId === null,
        ),
      {},
      ids,
    );
    await renderFrames(page);
    await page.mouse.click(target.x, target.y);
    await page.waitForFunction(
      (layerId, id) =>
        window.__godsEyeView.dataManager.layers.get(layerId).module.getStats()
          .selectedId === id,
      {},
      layerId,
      target.id,
    );
    await page.waitForFunction(
      (layerId) => {
        window.__godsEyeView.viewer.scene.requestRender();
        return (
          (window.__gevWorldOverlay?.getDiagnostics?.().paintedBySource?.[
            layerId
          ] || 0) > 0
        );
      },
      {},
      layerId,
    );
    check(
      `${layerId} selection paints its named source card`,
      await page.evaluate(
        (title) => window.__qaCityPaint.some((text) => text.includes(title)),
        target.title,
      ),
    );
    check(
      `${layerId} source text cannot create executable HTML`,
      await page.evaluate(
        () =>
          window.__qaCityInjection === undefined &&
          !document.querySelector('img[src="qa-san-antonio-invalid"]'),
      ),
    );
    await screenshot(page, `03-${layerId}-selected.png`);
  }
  check(
    'selected cards distinguish source edit date from retrieval',
    await page.evaluate(
      () =>
        window.__qaCityPaint.some((text) =>
          text.includes('Source data edited 2026-01-02'),
        ) &&
        window.__qaCityPaint.some((text) =>
          text.includes('City of San Antonio'),
        ),
    ),
  );
  for (const id of ids) await toggle(page, id, false);
  await setPanel(page, false);
  await renderFrames(page);
  const released = await resources(page);
  check(
    'disable removes owned primitives and point data sources',
    released.primitives.length === 0 && released.dataSources.length === 0,
    released,
  );
  check(
    'disable clears cards and selected records',
    await page.evaluate(
      (ids) =>
        ids.every((id) => {
          const stats = window.__godsEyeView.dataManager.layers
            .get(id)
            .module.getStats();
          return (
            stats.count === 0 &&
            stats.selectedId === null &&
            (window.__gevWorldOverlay?.getDiagnostics?.().entriesBySource?.[
              id
            ] || 0) === 0
          );
        }),
      ids,
    ),
  );
  for (const probe of await probeTargets(page, targets))
    check(
      `${probe.label} stops receiving picks after disable`,
      !probe.visible,
      probe,
    );
  const beforeReenable = state.requests.length;
  for (const id of ids) await toggle(page, id, true);
  await waitLoaded(page);
  check(
    're-enable uses the six-hour source cache without new network requests',
    state.requests.length === beforeReenable,
  );
  const tokens = ids
    .map((id) => LAYER_STATE_REGISTRY.find((entry) => entry.id === id)?.token)
    .sort();
  check(
    'all three City layers own registered share tokens',
    tokens.every(Boolean),
  );
  await page.waitForFunction(
    (tokens) => {
      const actual = (
        new URLSearchParams(location.hash.slice(1)).get('l') || ''
      )
        .split('.')
        .filter(Boolean)
        .sort();
      return JSON.stringify(actual) === JSON.stringify(tokens);
    },
    {},
    tokens,
  );
  const authoredUrl = page.url();
  await finishScenario(normal);
  const recipient = await createScenario(
    browser,
    'share-recipient',
    authoredUrl,
  );
  await waitLoaded(recipient.page);
  check(
    'a clean recipient restores exactly the authored layers',
    await recipient.page.evaluate((ids) => {
      const manager = window.__godsEyeView.dataManager;
      const enabled = [...manager.layers.keys()]
        .filter((id) => manager.isEnabled(id))
        .sort();
      return (
        JSON.stringify(enabled) === JSON.stringify([...ids].sort()) &&
        localStorage.getItem('gev:layer-state:v2') === null
      );
    }, ids),
  );
  await finishScenario(recipient);
  const failure = await createScenario(
    browser,
    'provider-failure',
    start.href,
    ids[0],
  );
  await preparePlainScene(failure.page);
  await setPanel(failure.page, true);
  await failure.page
    .locator(`[data-layer-id="${ids[0]}"] .data-toggle-btn`)
    .click();
  await failure.page.waitForFunction(
    (id) => {
      const stats = window.__godsEyeView.dataManager.layers
        .get(id)
        .module.getStats();
      const button = document.querySelector(
        `[data-layer-id="${id}"] .data-toggle-btn`,
      );
      return (
        stats.error &&
        !stats.loading &&
        button?.getAttribute('aria-busy') === 'false'
      );
    },
    {},
    ids[0],
  );
  const failed = await failure.page.evaluate(
    (id) => ({
      stats: window.__godsEyeView.dataManager.layers.get(id).module.getStats(),
      enabled: window.__godsEyeView.dataManager.isEnabled(id),
      feedState: document.querySelector(
        `[data-layer-id="${id}"] .data-toggle-btn`,
      )?.dataset.feedState,
      row: document.querySelector(`[data-layer-id="${id}"]`)?.textContent,
    }),
    ids[0],
  );
  check(
    'a failed first load rolls back and reports unavailable with no claimed features',
    failed.stats.count === 0 &&
      failed.stats.error &&
      !failed.stats.loading &&
      !failed.enabled &&
      failed.feedState === 'off' &&
      /UNAVAILABLE/.test(failed.row),
    failed,
  );
  const failedResources = await resources(failure.page);
  check(
    'a failed first load leaves no City graphics',
    failedResources.primitives.length === 0 &&
      failedResources.dataSources.length === 0,
  );
  await screenshot(failure.page, '04-provider-unavailable.png');
  failure.state.failDataset = null;
  await toggle(failure.page, ids[0], true);
  await waitLoaded(failure.page, [ids[0]]);
  check('a failed load can recover without a page reload', true);
  for (const scenario of contexts) {
    if (!scenario.page.isClosed()) await finishScenario(scenario);
  }
  check(
    'no uncaught browser or Cesium render errors',
    result.errors.length === 0,
    result.errors,
  );
} catch (error) {
  result.errors.push(redact(error.stack || error.message));
  for (const { page, state, monitor } of contexts) {
    if (page.isClosed()) continue;
    await screenshot(page, `failure-${state.name}.png`).catch(() => {});
    state.console = monitor.console;
    state.failedRequests = monitor.failed;
  }
  process.exitCode = 1;
} finally {
  result.passed = !process.exitCode && result.checks.every(({ pass }) => pass);
  await fs.writeFile(
    path.join(shots, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await browser?.close();
  console.log(`RESULT: ${result.passed ? 'PASS' : 'FAIL'}; evidence ${shots}`);
  if (!result.passed) console.error(result.errors.join('\n'));
}
