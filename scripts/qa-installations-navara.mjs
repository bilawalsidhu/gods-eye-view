#!/usr/bin/env node
// Headless Navara acceptance probe for the real military-installations layer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import sharp from 'sharp';

const arg = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reserved = new Set([4173, 4185, 4186, 4187, 4188, 4189]);
const site = { latitude: 37.77, longitude: -122.42 };
const ring = [
  [-122.438, 37.758],
  [-122.402, 37.758],
  [-122.402, 37.782],
  [-122.438, 37.782],
  [-122.438, 37.758],
];
const fixture = {
  status: 'ready',
  retrievedAt: '2026-10-28T00:00:00.000Z',
  saturated: false,
  elements: [
    {
      type: 'way',
      id: 980001,
      center: site,
      bounds: {
        minlat: 37.758,
        minlon: -122.438,
        maxlat: 37.782,
        maxlon: -122.402,
      },
      tags: { military: 'airfield', name: 'Navara QA Airfield' },
      geometry: ring.map(([lon, lat]) => ({ lon, lat })),
    },
  ],
};
const baseUrl = arg('base-url');
const engineKind = arg('engine') ?? 'navara';
if (!['cesium', 'navara'].includes(engineKind))
  throw new Error('Engine must be cesium or navara');
if (!baseUrl || reserved.has(Number(new URL(baseUrl).port)))
  throw new Error('Supply an unreserved --base-url');
const out = path.resolve(
  arg('out') ?? '/private/tmp/installations-navara-smoke.json',
);
const baseOrigin = new URL(baseUrl).origin;
const imageDir = path.dirname(out);
const report = {
  engine: engineKind,
  fixtureId: 'osm:way:980001',
  checks: [],
  runtimeErrors: 0,
  runtimeErrorPaths: [],
  expectedBlockedExternalErrors: 0,
  blockedGoogleTileRequests: 0,
  blockedExternalRequests: 0,
};
let installationRequests = 0;
let installationResponses = 0;
let terrainHeightRequests = 0;
const blockedExternalHosts = new Set();
const installationBoxes = [];
const check = (name, pass, detail = null) => {
  report.checks.push({
    name,
    pass: Boolean(pass),
    ...(detail ? { detail } : {}),
  });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};
const browser = await puppeteer.launch({
  headless: arg('headless') === 'shell' ? 'shell' : true,
  protocolTimeout: 180000,
  args: ['--use-angle=metal'],
});
const osmTileFixture = await sharp({
  create: {
    width: 256,
    height: 256,
    channels: 3,
    background: { r: 32, g: 48, b: 54 },
  },
})
  .png()
  .toBuffer();
const approximateTerrainHeights = await fs.readFile(
  new URL(
    '../node_modules/@cesium/engine/Source/Assets/approximateTerrainHeights.json',
    import.meta.url,
  ),
  'utf8',
);

try {
  const page = await browser.newPage();
  await blockPaidQaMaps(page);
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
  });
  page.on('pageerror', () => report.runtimeErrors++);
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Do not retain or print message text: provider URLs can contain credentials.
    const text = message.text();
    const blockedGoogleFailure =
      text.includes('net::ERR_FAILED') &&
      (report.blockedGoogleTileRequests > 0 ||
        report.blockedExternalRequests > 0);
    const blockedExternalFailure =
      report.blockedExternalRequests > 0 &&
      (text.includes('blocked by CORS policy') ||
        text.includes('net::ERR_FAILED'));
    if (blockedGoogleFailure || blockedExternalFailure) {
      report.expectedBlockedExternalErrors++;
    } else {
      report.runtimeErrors++;
      try {
        report.runtimeErrorPaths.push(
          new URL(message.location()?.url).pathname,
        );
      } catch {
        report.runtimeErrorPaths.push('(no resource URL)');
      }
      const safe = text
        .replace(/https?:\/\/[^\s"'<>]+/g, '[url]')
        .replace(/([?&][^=\s]+)=([^&\s]+)/g, '$1=[redacted]')
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
      console.log(`BROWSER ERROR ${safe.slice(0, 180)}`);
    }
  });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/Assets/approximateTerrainHeights.json')) {
      terrainHeightRequests++;
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: approximateTerrainHeights,
      });
    } else if (url.pathname === '/api/setup/status') {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ready: true }),
      });
    } else if (url.pathname === '/api/military-installations') {
      installationRequests++;
      installationResponses++;
      installationBoxes.push({
        south: url.searchParams.get('south'),
        west: url.searchParams.get('west'),
        north: url.searchParams.get('north'),
        east: url.searchParams.get('east'),
      });
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture),
      });
    } else if (url.pathname === '/api/google/text-search') {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          places: [
            {
              id: 'places-qa-01',
              name: 'Navara QA Candidate',
              latitude: 37.771,
              longitude: -122.419,
              primaryType: 'point_of_interest',
              types: ['point_of_interest'],
            },
          ],
        }),
      });
    } else if (url.hostname === 'tiles.googleapis.com') {
      report.blockedGoogleTileRequests++;
      void request.abort();
    } else if (url.origin !== baseOrigin) {
      report.blockedExternalRequests++;
      blockedExternalHosts.add(url.hostname);
      void request.abort();
    } else {
      void request.continue();
    }
  });

  const url = new URL(baseUrl);
  url.searchParams.set('engine', engineKind);
  url.searchParams.set('look', 'minimal');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(
    (expectedEngine) =>
      window.__godsEyeView?.dataManager &&
      window.__godsEyeView?.engine?.kind === expectedEngine &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 180000 },
    engineKind,
  );
  const ready = await page.evaluate(
    async (imageryDataUrl) => {
      const app = window.__godsEyeView;
      await app.styleManager.initialRestorePromise;
      // Let the normal startup fly-in finish before fixing a deterministic QA view.
      await new Promise((resolve) => setTimeout(resolve, 600));
      while (app.engine.camera.flightActive())
        await new Promise((resolve) => setTimeout(resolve, 100));
      app.engine.camera.cancelFlight();
      if (app.viewer) {
        const unixDays = Date.parse('2026-10-28T19:00:00Z') / 86_400_000;
        const JulianDate = app.viewer.clock.currentTime.constructor;
        app.viewer.clock.currentTime = new JulianDate(
          Math.floor(unixDays) + 2_440_588,
          (unixDays % 1) * 86_400,
        );
        app.viewer.clock.shouldAnimate = false;
        app.viewer.scene.requestRender();
      }
      const { appClock } = await import('/src/time/clock.js');
      appClock.freeze(Date.parse('2026-10-28T19:00:00Z'));
      for (const [id] of app.dataManager.layers)
        if (id !== 'military-installations' && app.dataManager.isEnabled(id))
          await app.dataManager.setEnabled(id, false);
      if (app.mapStackController.isStackAvailable('osm'))
        await app.mapStackController.setStack('osm', { silent: true });
      if (app.viewer) {
        const Cesium =
          window.Cesium ?? (await import('/node_modules/.vite/deps/cesium.js'));
        await Promise.all([
          Cesium.GroundPrimitive.initializeTerrainHeights(),
          Cesium.GroundPolylinePrimitive.initializeTerrainHeights(),
        ]);
        app.viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        app.viewer.imageryLayers.removeAll(true);
        const imagery = await Cesium.SingleTileImageryProvider.fromUrl(
          imageryDataUrl,
          { credit: '© OpenStreetMap contributors' },
        );
        app.viewer.imageryLayers.addImageryProvider(imagery);
      }
      const geo = await import('/src/geo/index.js');
      app.engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(-122.42, 37.77, 35000),
        orientation: {
          heading: 0,
          pitch: geo.math.toRadians(-90),
          roll: 0,
        },
      });
      return {
        map: app.mapStackController.getActiveId(),
        fixtureBounds: {
          west: -122.438,
          east: -122.402,
          south: 37.758,
          north: 37.782,
        },
      };
    },
    `data:image/png;base64,${osmTileFixture.toString('base64')}`,
  );
  check(`${engineKind} startup with keyless OSM stack`, ready.map === 'osm', {
    engine: engineKind,
    map: ready.map,
  });
  if (engineKind === 'cesium')
    check(
      'Cesium ground-height bounds use the packaged local fixture',
      terrainHeightRequests > 0,
      terrainHeightRequests,
    );
  const waitForFrame = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const engine = window.__godsEyeView.engine;
          let remove;
          const timer = setTimeout(() => {
            remove?.();
            reject(new Error('Globe frame was not rendered'));
          }, 10000);
          remove = engine.frames.postRender.addEventListener(() => {
            clearTimeout(timer);
            remove();
            resolve();
          });
          engine.render.request('installations-qa');
        }),
    );
  const waitForCesiumTiles = async () => {
    if (engineKind !== 'cesium') return true;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await page.evaluate(
          () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
        )
      )
        return true;
      await waitForFrame();
      await sleep(100);
    }
    return false;
  };
  await waitForFrame();
  const initialGroundReady = await waitForCesiumTiles();
  if (engineKind === 'cesium')
    check('Cesium base tiles settle before capture', initialGroundReady);
  console.log('WAITING FOR INITIAL MAP PAINT');
  await sleep(1800);

  const canvasRect = await page.evaluate(() => {
    const rect =
      window.__godsEyeView.engine.host.canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const capture = async (name) => {
    console.log(`CAPTURING ${name}`);
    const bytes = await page.screenshot({
      clip: {
        x: Math.max(0, canvasRect.x),
        y: Math.max(0, canvasRect.y),
        width: canvasRect.width,
        height: canvasRect.height,
      },
    });
    await fs.writeFile(path.join(imageDir, `${name}.png`), bytes);
    console.log(`CAPTURED ${name}`);
    return bytes;
  };
  const baselineImage = await capture(`installations-${engineKind}-off`);
  console.log('ENABLING INSTALLATIONS');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('military-installations', true),
  );
  console.log('INSTALLATIONS READY');
  try {
    await page.waitForFunction(
      () => {
        const stats = window.__godsEyeView.dataManager.layers
          .get('military-installations')
          .module.getStats();
        return !stats.loading && stats.count === 1;
      },
      { timeout: 15000 },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const layer = window.__godsEyeView.dataManager.layers.get(
        'military-installations',
      ).module;
      const stats = layer.getStats();
      return {
        count: stats.count,
        loading: stats.loading,
        status: stats.status,
        hasError: Boolean(stats.error),
        hasFailureReason: Boolean(stats.failureReason),
      };
    });
    console.error(
      JSON.stringify({
        phase: 'installation-fixture-load',
        diagnostic,
        installationRequests,
        installationResponses,
        installationBoxes,
      }),
    );
    throw error;
  }
  await waitForFrame();
  const layerGroundReady = await waitForCesiumTiles();
  if (engineKind === 'cesium')
    check('Cesium ground tiles settle with installations', layerGroundReady);
  const osmAttribution = await page.evaluate(() =>
    document.body.innerText.includes('© OpenStreetMap'),
  );
  check(
    'OSM source attribution is visible with mapped records',
    osmAttribution,
  );
  if (engineKind === 'cesium') {
    const imageryProvider = await page.evaluate(() => {
      const provider =
        window.__godsEyeView.viewer.imageryLayers.get(0).imageryProvider;
      return {
        type: provider.constructor.name,
        tileWidth: provider.tileWidth,
        tileHeight: provider.tileHeight,
      };
    });
    check(
      'Cesium receives deterministic local imagery',
      imageryProvider.tileWidth === 256 && imageryProvider.tileHeight === 256,
      imageryProvider,
    );
  }
  await sleep(1800);
  const outlineImage = await capture(`installations-${engineKind}-outline`);
  const center = await page.evaluate(async () => {
    const geo = await import('/src/geo/index.js');
    const position = geo.cartesian3.fromDegrees(-122.42, 37.77, 0);
    const point = window.__godsEyeView.engine.projector.worldToWindow(position);
    return point ? { x: Math.round(point.x), y: Math.round(point.y) } : null;
  });
  assert.ok(center, 'fixture center must project into the active view');
  const changedOutside = (left, right, radius, lowerHalfOnly = false) => {
    const a = sharp(left).ensureAlpha().raw();
    const b = sharp(right).ensureAlpha().raw();
    const [metaA, metaB] = [a.metadata(), b.metadata()];
    return Promise.all([metaA, metaB]).then(([ma, mb]) => {
      assert.equal(ma.width, mb.width);
      assert.equal(ma.height, mb.height);
      return Promise.all([a.toBuffer(), b.toBuffer()]).then(([pa, pb]) => {
        let count = 0;
        for (let y = 0; y < ma.height; y++)
          for (let x = 0; x < ma.width; x++) {
            if (Math.abs(x - center.x) > 180 || Math.abs(y - center.y) > 180)
              continue;
            if (Math.hypot(x - center.x, y - center.y) <= radius) continue;
            if (lowerHalfOnly && y <= center.y + radius) continue;
            const at = (y * ma.width + x) * 4;
            if (
              Math.abs(pa[at] - pb[at]) > 20 ||
              Math.abs(pa[at + 1] - pb[at + 1]) > 20 ||
              Math.abs(pa[at + 2] - pb[at + 2]) > 20
            )
              count++;
          }
        return count;
      });
    });
  };
  const outlinePixels = await changedOutside(baselineImage, outlineImage, 18);
  if (engineKind === 'cesium')
    report.cesiumScene = await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const { scene, terrainProvider } = viewer;
      return {
        globeTilesLoaded: scene.globe.tilesLoaded,
        terrainProvider: terrainProvider.constructor.name,
      };
    });
  check(
    'ordinary outline paints beyond the point marker',
    outlinePixels > 50,
    outlinePixels,
  );

  const probe = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    if (!app.viewer) return null;
    const source = app.viewer.dataSources
      .getByName('military-installations')
      .at(0)
      .entities.getById('osm:way:980001');
    const owner = app.viewer.dataSources
      .getByName('military-installations')
      .at(0);
    const position = source.position.getValue(app.viewer.clock.currentTime);
    const point = source.point.clone();
    point.heightReference = 0;
    const dataSource = new owner.constructor('qa-installation-pick-control');
    await app.viewer.dataSources.add(dataSource);
    dataSource.entities.add({
      id: 'qa-native-pick-probe',
      position,
      point,
    });
    app.viewer.scene.requestRender();
    const screen = app.engine.projector.worldToWindow(position);
    return screen ? { id: 'qa-native-pick-probe', screen } : null;
  });
  let probePick = null;
  if (probe) {
    await waitForFrame();
    probePick = await page.evaluate(({ id, screen }) => {
      const { x, y } = screen;
      const pick = window.__godsEyeView.viewer.scene.pick({ x, y });
      return typeof pick?.id?.id === 'string' ? pick.id.id : null;
    }, probe);
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const source = viewer.dataSources.getByName(
        'qa-installation-pick-control',
      )[0];
      viewer.dataSources.remove(source, true);
      viewer.scene.requestRender();
    }, probe.id);
    await waitForFrame();
  }
  if (engineKind === 'cesium')
    check(
      'Cesium viewer-entity GPU pick control',
      probePick === probe?.id,
      probePick,
    );

  const click = {
    x: Math.round(canvasRect.x + center.x),
    y: Math.round(canvasRect.y + center.y),
  };
  await page.mouse.click(click.x, click.y);
  try {
    await page.waitForFunction(
      async () => {
        const { getSelectedEntityContext } =
          await import('/src/data/contextStore.js');
        return getSelectedEntityContext()?.id === 'osm:way:980001';
      },
      { timeout: 15000 },
    );
  } catch {}
  if (engineKind === 'cesium') {
    await page.waitForFunction(
      () => {
        const { scene, dataSources } = window.__godsEyeView.viewer;
        const source = dataSources.getByName('military-installations')[0];
        const selectedFill = source.entities.values.some((entity) =>
          entity.id.includes(':selected-fill:'),
        );
        let readyGroundPrimitives = 0;
        const visit = (collection) => {
          for (const child of collection._primitives ??
            collection._collectionsArray ??
            []) {
            if (child._primitives || child._collectionsArray) visit(child);
            else if (child.ready === true && child.show === true)
              readyGroundPrimitives++;
          }
        };
        visit(scene.groundPrimitives);
        return (
          scene.globe.tilesLoaded && selectedFill && readyGroundPrimitives >= 2
        );
      },
      { timeout: 30000 },
    );
    await waitForFrame();
  }
  const selectedImage = await capture(`installations-${engineKind}-selected`);
  const fillPixels = await changedOutside(
    outlineImage,
    selectedImage,
    18,
    true,
  );
  check(
    'real pointer selection paints the selected footprint',
    fillPixels > 50,
    fillPixels,
  );
  if (engineKind === 'cesium')
    report.cesiumSelectedGround = await page.evaluate(() => {
      const { dataSources } = window.__godsEyeView.viewer;
      const dataSource = dataSources.getByName('military-installations')[0];
      return {
        entities: dataSource.entities.values
          .filter((entity) => entity.id.includes(':selected-fill:'))
          .map((entity) => ({
            show: entity.show,
            hierarchy: Boolean(entity.polygon.hierarchy.getValue()),
          })),
      };
    });
  const selected = await page.evaluate(async () => {
    const { getSelectedEntityContext } =
      await import('/src/data/contextStore.js');
    return getSelectedEntityContext()?.id ?? null;
  });
  check(
    'selection retains canonical installation identity',
    selected === report.fixtureId,
    selected,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('military-installations')
      .module.searchNearby(),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('military-installations')
        .module.getAnalystRecords()
        .some((record) => record.name === 'Navara QA Candidate'),
    { timeout: 30000 },
  );
  await page
    .waitForFunction(() => document.body.innerText.includes('Google Maps'), {
      timeout: 5000,
    })
    .catch(() => {});
  await waitForFrame();
  const placesAttribution = await page.evaluate(() =>
    document.body.innerText.includes('Google Maps'),
  );
  check(
    'Places candidates retain visible Google Maps attribution',
    placesAttribution,
  );
  check(
    'no unexpected page errors',
    report.runtimeErrors === 0,
    report.runtimeErrors,
  );

  report.images = {
    baseline: path.join(imageDir, `installations-${engineKind}-off.png`),
    outline: path.join(imageDir, `installations-${engineKind}-outline.png`),
    selected: path.join(imageDir, `installations-${engineKind}-selected.png`),
  };
  report.blockedExternalHosts = [...blockedExternalHosts];
  report.pass = report.checks.every((item) => item.pass);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ pass: report.pass, checks: report.checks, out }),
  );
  if (!report.pass) process.exitCode = 1;
} finally {
  await browser.close();
}
