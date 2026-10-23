#!/usr/bin/env node
/**
 * Real-app SPC smoke gate (Node 24+, running dev server required).
 *   node scripts/qa-spc-outlooks.mjs --url http://localhost:4173
 *   node scripts/qa-spc-outlooks.mjs --fixtures
 * Live mode uses the actual bounded NOAA proxy; fixtures prove UI/rendering only.
 * Exercises Esri/OSM, all products, selectors, picking, share restoration and cleanup.
 * Fixture mode also checks selector text bounds at desktop/mobile widths in en/es/ru.
 * Attempts Google 3D only when configured; --require-photoreal makes absence fail.
 * Software WebGL is not real-GPU visual sign-off. Evidence: qa-artifacts/spc/browser/.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const value = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const url = value('--url', 'http://localhost:4173');
const fixtures = args.includes('--fixtures');
const output = 'qa-artifacts/spc/browser';
await fs.mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: !args.includes('--headful'),
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const errors = [],
  results = [];
const resourceFailures = [],
  consoleErrors = [];
page.on('response', (response) => {
  if (response.status() < 400) return;
  const u = new URL(response.url());
  resourceFailures.push({
    host: u.host,
    path: u.pathname,
    status: response.status(),
  });
});
page.on('requestfailed', (request) => {
  const u = new URL(request.url());
  resourceFailures.push({
    host: u.host,
    path: u.pathname,
    error: request.failure()?.errorText,
  });
});
page.on('console', (message) => {
  if (message.type() === 'error')
    consoleErrors.push(
      message
        .text()
        .replace(/https?:\/\/\S+/g, '<url>')
        .slice(0, 400),
    );
});
page.on('pageerror', (error) => errors.push(error.message));
const record = (name, detail) => {
  results.push({ name, detail });
  console.log(`PASS ${name}: ${JSON.stringify(detail)}`);
};
const compact = (time) =>
  new Date(time).toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');
function fixture(product) {
  const now = Date.now(),
    tornado = product.endsWith('tornado');
  const inner = {
    type: 'Feature',
    properties: {
      objectid: tornado ? 2 : 1,
      dn: tornado ? 5 : 3,
      label: tornado ? '0.05' : 'MRGL',
      issue: compact(now - 3600_000),
      valid: compact(now - 1800_000),
      expire: compact(now + 3600_000),
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-102, 30],
          [-96, 30],
          [-96, 36],
          [-102, 36],
          [-102, 30],
        ],
        [
          [-100, 32],
          [-100, 34],
          [-98, 34],
          [-98, 32],
          [-100, 32],
        ],
      ],
    },
  };
  return {
    type: 'FeatureCollection',
    fetchedAt: now,
    features: tornado
      ? [
          {
            type: 'Feature',
            properties: {
              objectid: 1,
              dn: 2,
              label: '0.02',
              issue: inner.properties.issue,
              valid: inner.properties.valid,
              expire: inner.properties.expire,
            },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-103, 29],
                  [-95, 29],
                  [-95, 37],
                  [-103, 37],
                  [-103, 29],
                ],
                inner.geometry.coordinates[0],
              ],
            },
          },
          inner,
        ]
      : [inner],
  };
}
const layerId = 'severe-weather-outlooks';
try {
  // Intercept page fetches only. CDP-wide request interception can stall Cesium
  // module-worker startup in newer Chromium/Puppeteer releases.
  await page.evaluateOnNewDocument(
    ({ fixtures, products }) => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, options) => {
        const target = new URL(
          typeof input === 'string' ? input : input.url,
          location.href,
        );
        if (target.origin === location.origin) {
          if (target.pathname === '/api/openai/hud-summary')
            return Response.json({ summary: '' });
          if (target.pathname === '/api/google/nearby-places')
            return Response.json({ places: [] });
          const product = target.pathname.split('/').at(-1);
          if (
            fixtures &&
            target.pathname.startsWith('/api/spc-outlooks/') &&
            products[product]
          )
            return Response.json({
              ...products[product],
              fetchedAt: Date.now(),
            });
        }
        return original(input, options);
      };
    },
    {
      fixtures,
      products: Object.fromEntries(
        [
          'day1-categorical',
          'day1-tornado',
          'day2-categorical',
          'day2-tornado',
        ].map((product) => [product, fixture(product)]),
      ),
    },
  );
  await page.goto(`${url}/?welcome=0#v=2&l=`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager && window.__godsEyeView?.styleManager,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90_000 },
  );
  await page.evaluate(() => {
    window.__spcRenderErrors = [];
    window.__godsEyeView.viewer.scene.renderError.addEventListener(
      (_scene, error) => window.__spcRenderErrors.push(error.message),
    );
  });
  assert.equal(
    await page.evaluate(
      async (id) =>
        window.__godsEyeView.dataManager.setEnabled(id, true, {
          origin: 'user',
        }),
      layerId,
    ),
    true,
  );
  await page.waitForFunction(
    (id) =>
      !window.__godsEyeView.dataManager.layers.get(id).module.getStats()
        .loading,
    {},
    layerId,
  );
  const read = () =>
    page.evaluate((id) => {
      const app = window.__godsEyeView,
        module = app.dataManager.layers.get(id).module;
      const source = [...Array(app.viewer.dataSources.length)]
        .map((_, i) => app.viewer.dataSources.get(i))
        .find((s) => s.name === id);
      return {
        params: module.getParams(),
        stats: module.getStats(),
        entities: source?.entities.values.length || 0,
        controls: module.getRowControls(),
      };
    }, layerId);
  let state = await read();
  assert.ok(
    ['ready', 'empty'].includes(state.stats.status),
    state.controls.summary.status,
  );
  record(fixtures ? 'fixture source (not live NOAA)' : 'live NOAA proxy', {
    status: state.stats.status,
    count: state.stats.count,
  });

  for (const map of ['esri-imagery', 'osm']) {
    await page.evaluate(
      async (id) =>
        window.__godsEyeView.styleManager._setMapStack(id, {
          syncShare: false,
        }),
      map,
    );
    assert.equal(
      await page.evaluate(() =>
        window.__godsEyeView.styleManager.mapStackController.getActiveId(),
      ),
      map,
    );
    await page.evaluate(async () => {
      const moduleText = await (
        await fetch('/src/layers/spc/rendering.js')
      ).text();
      const dependency = moduleText.match(
        /import\s+\*\s+as\s+Cesium\s+from\s+["']([^"']+)["']/,
      )?.[1];
      if (!dependency)
        throw new Error('Cannot resolve application Cesium module');
      const C = await import(dependency);
      const viewer = window.__godsEyeView.viewer;
      window.__spcQaCesium = C;
      window.__godsEyeView.styleManager.runImmediateNavigation(
        'weather',
        () => {
          viewer.camera.cancelFlight();
          viewer.camera.setView({
            destination: C.Cartesian3.fromDegrees(-98, 34, 2_000_000),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
        },
      );
      viewer.scene.requestRender();
    });
    // Wait for real ground primitive readiness, not just entity registration.
    if (state.entities) {
      const deadline = Date.now() + Number(value('--render-timeout', '60000'));
      while (true) {
        const readiness = await page.evaluate(() => {
          const viewer = window.__godsEyeView.viewer;
          viewer.scene.requestRender();
          const source = [...Array(viewer.dataSources.length)]
            .map((_, i) => viewer.dataSources.get(i))
            .find((s) => s.name === 'severe-weather-outlooks');
          const primitives = (
            source?._groundPrimitives?._collectionsArray || []
          ).flatMap((collection) =>
            [...Array(collection.length)].map((_, i) => collection.get(i)),
          );
          return {
            states: primitives.map((primitive) => ({
              ready: primitive.ready,
              show: primitive.show,
            })),
          };
        });
        if (
          readiness.states.length &&
          readiness.states.every((value) => value.ready && value.show)
        )
          break;
        assert.ok(
          Date.now() < deadline,
          `Ground geometry not ready: ${JSON.stringify(readiness)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await page.screenshot({
      path: `${output}/${fixtures ? 'fixture' : 'live'}-${map}.png`,
    });
    record(`ground rendering on ${map}`, {
      entities: state.entities,
      softwareWebGL: true,
    });
    if (fixtures) {
      const picked = await page.evaluate(() => {
        const app = window.__godsEyeView,
          viewer = app.viewer,
          C = window.__spcQaCesium;
        const pickAt = (lon, lat) => {
          const point = C.SceneTransforms.worldToWindowCoordinates(
            viewer.scene,
            C.Cartesian3.fromDegrees(lon, lat),
          );
          const id = viewer.scene.pick(point)?.id?.id || '';
          const rect = viewer.scene.canvas.getBoundingClientRect();
          return { id, x: point.x + rect.left, y: point.y + rect.top };
        };
        return { fill: pickAt(-101, 31), hole: pickAt(-99, 33) };
      });
      assert.match(picked.fill.id, /^spc:/);
      assert.ok(
        !picked.hole.id.startsWith('spc:'),
        'interior risk-band hole must remain unfilled',
      );
      await page.mouse.click(picked.fill.x, picked.fill.y);
      const selected = await read();
      assert.ok(selected.controls.summary.result);
      record(`actual map picking and unfilled hole on ${map}`, {
        risk: selected.controls.summary.result.lines[0].text,
      });
    }
  }

  const card = `[data-card-id="${layerId}"]`;
  for (const day of ['day1', 'day2'])
    for (const type of ['categorical', 'tornado']) {
      await page.click(`${card} [data-chip-id="${day}"]`);
      await page.click(`${card} [data-chip-id="${type}"]`);
      await page.waitForFunction(
        (id, d, t) => {
          const module = window.__godsEyeView.dataManager.layers.get(id).module;
          return (
            module.getParams().day === d &&
            module.getParams().type === t &&
            !module.getStats().loading
          );
        },
        { timeout: 30_000 },
        layerId,
        day,
        type,
      );
      state = await read();
      assert.ok(
        ['ready', 'empty'].includes(state.stats.status),
        state.controls.summary.status,
      );
      assert.equal(
        state.controls.legend.length,
        type === 'categorical' ? 6 : 7,
      );
      record(`${day}-${type} selector`, { count: state.stats.count });
      if (fixtures && day === 'day1' && type === 'tornado') {
        await page.waitForFunction(
          () => {
            const viewer = window.__godsEyeView.viewer;
            viewer.scene.requestRender();
            const source = [...Array(viewer.dataSources.length)]
              .map((_, i) => viewer.dataSources.get(i))
              .find((item) => item.name === 'severe-weather-outlooks');
            const primitives = (
              source?._groundPrimitives?._collectionsArray || []
            ).flatMap((collection) =>
              [...Array(collection.length)].map((_, i) => collection.get(i)),
            );
            return (
              primitives.length &&
              primitives.every((primitive) => primitive.ready && primitive.show)
            );
          },
          { timeout: 60_000, polling: 100 },
        );
        await page.waitForFunction(
          () => {
            const viewer = window.__godsEyeView.viewer;
            const C = window.__spcQaCesium;
            viewer.scene.requestRender();
            const point = C.SceneTransforms.worldToWindowCoordinates(
              viewer.scene,
              C.Cartesian3.fromDegrees(-101, 31),
            );
            return viewer.scene
              .pick(point)
              ?.id?.id?.startsWith('spc:day1-tornado:2:0');
          },
          { timeout: 30_000, polling: 100 },
        );
        const nested = await page.evaluate(async () => {
          const viewer = window.__godsEyeView.viewer;
          const C = window.__spcQaCesium;
          const source = [...Array(viewer.dataSources.length)]
            .map((_, i) => viewer.dataSources.get(i))
            .find((item) => item.name === 'severe-weather-outlooks');
          const entities = source.entities.values;
          const higher = entities.find(
            (entity) => entity.id === 'spc:day1-tornado:2:0',
          );
          const lowerHole = entities.find(
            (entity) => entity.id === 'spc:day1-tornado:1:0:ring:1',
          );
          const higherEdge = entities.find(
            (entity) => entity.id === 'spc:day1-tornado:2:0:ring:0',
          );
          const pickAt = (lon, lat) => {
            const point = C.SceneTransforms.worldToWindowCoordinates(
              viewer.scene,
              C.Cartesian3.fromDegrees(lon, lat),
            );
            return viewer.scene.pick(point)?.id?.id || '';
          };
          viewer.scene.requestRender();
          return {
            higher: higher?.polygon.material.color
              .getValue()
              .toCssColorString(),
            edgeOrder:
              higherEdge?.polyline.zIndex.getValue() >
              lowerHole?.polyline.zIndex.getValue(),
            innerPick: pickAt(-101, 31),
            outerPick: pickAt(-102.5, 31),
            holePick: pickAt(-99, 33),
          };
        });
        assert.equal(nested.higher, 'rgba(189,153,138,0.7)');
        assert.equal(nested.edgeOrder, true);
        assert.match(nested.innerPick, /^spc:day1-tornado:2:0/);
        assert.match(nested.outerPick, /^spc:day1-tornado:1:0/);
        assert.ok(!nested.holePick.startsWith('spc:'));
        await page.screenshot({ path: `${output}/fixture-nested-tornado.png` });
        record('nested 2%/5% tornado bands and unfilled hole', nested);
      }
    }
  if (state.stats.count) {
    await page.waitForSelector(`${card} .data-row-list-item`, {
      visible: true,
      timeout: 10_000,
    });
    await page.click(`${card} .data-row-list-item`);
    state = await read();
    assert.ok(state.controls.summary.result);
    assert.match(state.controls.summary.result.lines[1].text, /UTC/);
    assert.match(
      state.controls.summary.actions[0].href,
      /^https:\/\/www\.spc\.noaa\.gov\//,
    );
    record('accessible forecast selection', {
      hazard: state.controls.summary.result.label,
    });
  }
  await page.waitForFunction(
    () => location.hash.includes('5.d.2') && location.hash.includes('5.t.t'),
    { timeout: 10_000 },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView?.dataManager?.isEnabled(id) &&
      !window.__godsEyeView.dataManager.layers.get(id).module.getStats()
        .loading,
    { timeout: 90_000 },
    layerId,
  );
  state = await read();
  assert.deepEqual(state.params, { day: 'day2', type: 'tornado' });
  record('share-link restoration', state.params);

  const google = await page.evaluate(async () => {
    const manager = window.__godsEyeView.styleManager;
    try {
      await manager._setMapStack('photoreal', { syncShare: false });
    } catch {
      /* reported below */
    }
    const active = manager.mapStackController.getActiveId();
    const app = window.__godsEyeView;
    const tileset = app.mapStackController.getImageryHostTileset();
    return { active, tilesLoaded: Boolean(tileset?.tilesLoaded) };
  });
  if (google.active === 'photoreal') {
    // A selected stack alone is not evidence that its Google mesh loaded.
    await page
      .waitForFunction(
        () =>
          window.__godsEyeView.mapStackController.getImageryHostTileset()
            ?.tilesLoaded,
        {
          timeout: 60_000,
        },
      )
      .catch(() => {});
    google.tilesLoaded = await page.evaluate(() =>
      Boolean(
        window.__godsEyeView.mapStackController.getImageryHostTileset()
          ?.tilesLoaded,
      ),
    );
    if (google.tilesLoaded) {
      await page.screenshot({ path: `${output}/google-photoreal.png` });
      record('Google 3D tiles loaded', google);
    }
  }
  if (!google.tilesLoaded) {
    results.push({
      name: 'Google photoreal rendering',
      unverified: true,
      detail: google,
    });
    console.log(
      'NOT VERIFIED Google photoreal rendering: no loaded Google mesh',
    );
    assert.ok(
      !args.includes('--require-photoreal'),
      'Google photoreal rendering required',
    );
  }
  await page.evaluate(
    async (id) =>
      window.__godsEyeView.dataManager.setEnabled(id, false, {
        origin: 'user',
      }),
    layerId,
  );
  state = await read();
  assert.equal(state.entities, 0);
  assert.equal(state.stats.count, 0);
  assert.equal(state.controls.summary.result, undefined);
  assert.deepEqual(errors, []);
  record('disable clears polygons and selection; no page errors', {});
  if (fixtures) {
    for (const locale of ['en', 'es', 'ru']) {
      await page.setViewport({ width: 1440, height: 1000 });
      const target = new URL(url);
      target.searchParams.set('welcome', '0');
      target.searchParams.set('lang', locale);
      target.hash =
        'v=2&lat=37&lon=-98&alt=5000000&heading=0&pitch=-90&map=esri-imagery&l=5&lo=5.d.2_5.t.t';
      await page.goto(target.href, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForSelector(`${card} .rail-card-setting`, {
        visible: true,
        timeout: 90_000,
      });
      await page.waitForFunction(
        () =>
          document
            .getElementById('loading-screen')
            ?.classList.contains('hidden'),
        { timeout: 90_000 },
      );
      await page.evaluate(() => document.fonts.ready);
      for (const width of [1440, 480]) {
        await page.setViewport({ width, height: 1000 });
        const settings = await page.evaluate(
          (selector) =>
            [
              ...document.querySelectorAll(`${selector} .rail-card-setting`),
            ].map((setting) => {
              const label = setting.querySelector('.rail-card-setting-label');
              const chips = setting.querySelector('.rail-card-chips');
              const text = document.createRange();
              text.selectNodeContents(label);
              const bounds = text.getBoundingClientRect();
              const controls = chips.getBoundingClientRect();
              const box = setting.getBoundingClientRect();
              return {
                label: label.textContent,
                labelBottom: bounds.bottom,
                controlsTop: controls.top,
                labelLeft: bounds.left,
                labelRight: bounds.right,
                left: box.left,
                right: box.right,
                width: box.width,
                overflow: setting.scrollWidth - setting.clientWidth,
                buttonsFit: [...chips.querySelectorAll('button')].every(
                  (button) => {
                    const b = button.getBoundingClientRect();
                    return (
                      b.left >= box.left - 1 &&
                      b.right <= box.right + 1 &&
                      button.scrollWidth <= button.clientWidth + 1
                    );
                  },
                ),
              };
            }),
          card,
        );
        assert.equal(settings.length, 2);
        for (const setting of settings) {
          const context = `${locale}/${width}: ${JSON.stringify(setting)}`;
          assert.ok(setting.width > 0, context);
          assert.ok(
            setting.labelBottom <= setting.controlsTop + 1,
            `Label overlaps selectors: ${context}`,
          );
          assert.ok(
            setting.labelLeft >= setting.left - 1 &&
              setting.labelRight <= setting.right + 1,
            context,
          );
          assert.ok(
            setting.overflow <= 1 && setting.buttonsFit,
            `Selector overflows card: ${context}`,
          );
        }
        await page.$eval(`${card} [data-chip-id="tornado"]`, (button) =>
          button.scrollIntoView({ block: 'center' }),
        );
        await page.screenshot({
          path: `${output}/layout-${locale}-${width}.png`,
        });
        record(`SPC selector layout ${locale}/${width}`, {
          labels: settings.map((setting) => setting.label),
        });
      }
    }
    assert.deepEqual(errors, []);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  console.log('Resource failures', JSON.stringify(resourceFailures));
  console.log('Console errors', JSON.stringify(consoleErrors));
  console.log(
    'Workers',
    page.workers().map((worker) => worker.url().replace(/\?.*$/, '')),
  );
  console.log(
    'Render diagnostics',
    JSON.stringify(
      await page
        .evaluate(() => {
          const app = window.__godsEyeView,
            viewer = app?.viewer;
          if (!viewer) return { viewer: false };
          const source = [...Array(viewer.dataSources.length)]
            .map((_, i) => viewer.dataSources.get(i))
            .find((s) => s.name === 'severe-weather-outlooks');
          return {
            renderErrors: window.__spcRenderErrors,
            loop: viewer.useDefaultRenderLoop,
            sourceShow: source?.show,
            dataDisplayReady: viewer.dataSourceDisplay.ready,
            groundDetails: source?._groundPrimitives?._collectionsArray?.map(
              (collection) =>
                [...Array(collection.length)].map((_, i) => ({
                  type: collection.get(i).constructor.name,
                  ready: collection.get(i).ready,
                  show: collection.get(i).show,
                })),
            ),
            entities: source?.entities.values.length,
            cameraHeight: viewer.camera.positionCartographic.height,
          };
        })
        .catch((e) => ({ error: e.message })),
      null,
      2,
    ),
  );
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
} finally {
  await fs.writeFile(
    `${output}/${fixtures ? 'fixture' : 'live'}-report.json`,
    JSON.stringify(
      { fixtures, results, errors, success: !process.exitCode },
      null,
      2,
    ),
  );
  await browser.close();
}
