#!/usr/bin/env node
/**
 * Cape Town transmission pilot browser gate.
 * Run: node scripts/qa-transmission.mjs --url http://localhost:4181
 * Uses the real bundled OSM pack, with one explicitly synthetic earthquake
 * fixture to verify coexistence. Captures regional/close views, interaction,
 * filter restoration, unloads, heap and driven frame intervals. No keys needed.
 * Uses the live keyless basemap and terrain; availability is required.
 */
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
const opt = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const url = opt('--url', 'http://localhost:4181');
const out = opt('--out', 'qa-artifacts/transmission');
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 1440, height: 960 },
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--js-flags=--expose-gc',
  ],
});
const report = {
  checks: [],
  imagery: 'live keyless basemap',
  terrain: 'live terrain',
  hazard: 'synthetic earthquake fixture, not a real event',
};
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, detail ?? '');
  assert.ok(pass, name);
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  const errors = [];
  let packRequests = 0;
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.endsWith('/transmission/cape-town.geojson'))
      packRequests++;
  });
  // Shim only the hazard feed; leave Cesium's worker and tile requests untouched.
  await page.evaluateOnNewDocument(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const target = new URL(
        typeof input === 'string' ? input : input.url,
        location.href,
      );
      if (
        target.hostname === 'earthquake.usgs.gov' &&
        target.pathname.endsWith('/all_day.geojson')
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  id: 'qa-transmission-quake',
                  properties: {
                    mag: 4.2,
                    place: 'QA fixture — synthetic Cape Town event',
                    time: Date.now(),
                    url: 'https://earthquake.usgs.gov/',
                  },
                  geometry: { type: 'Point', coordinates: [18.53, -33.93, 10] },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return originalFetch(input, init);
    };
  });
  await page.goto(
    `${url}/?welcome=0#lat=-33.915&lon=18.645&alt=125000&pitch=-90&map=osm&v=2&l=`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(() => {
    localStorage.removeItem('gev:layer-state:v2');
  });
  await page.waitForFunction(
    () => window.__godsEyeView.viewer.scene.globe.show,
    { timeout: 30000 },
  );
  await page.evaluate(async () => {
    const { holdContinuousRender } = await import('/src/renderGovernor.js');
    holdContinuousRender('qa-transmission');
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.viewer.scene.globe._surface._tilesToRender.length >
      0,
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const { releaseContinuousRender } = await import('/src/renderGovernor.js');
    releaseContinuousRender('qa-transmission');
  });
  check(
    'pack is not requested before enable',
    packRequests === 0,
    packRequests,
  );
  const camera = async (lon, lat, height) => {
    await page.evaluate(
      async ({ lon, lat, height }) => {
        const C = await import('/node_modules/.vite/deps/cesium.js');
        const v = window.__godsEyeView.viewer;
        v.camera.cancelFlight();
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, height),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        v.camera.moveEnd.raiseEvent();
        v.scene.requestRender();
      },
      { lon, lat, height },
    );
    await delay(700);
  };
  const stats = () =>
    page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('transmission')
        .module.getStats(),
    );
  const enabled = async (value) =>
    page.evaluate(
      (value) =>
        window.__godsEyeView.dataManager.setEnabled('transmission', value, {
          origin: 'user',
        }),
      value,
    );
  const filters = async (params) => {
    await page.evaluate(
      (params) =>
        window.__godsEyeView.dataManager.setLayerParams(
          'transmission',
          params,
          { origin: 'user' },
        ),
      params,
    );
    await delay(800);
  };
  await camera(18.645, -33.915, 125000);
  report.globe = await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    return {
      show: v.scene.globe.show,
      tiles: v.scene.globe.tilesLoaded,
      tilesToRender: v.scene.globe._surface._tilesToRender.length,
      terrain: v.terrainProvider.constructor.name,
    };
  });
  check(
    'basemap has rendered terrain tiles',
    report.globe.tilesToRender > 0,
    report.globe,
  );
  report.renderer = await page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  const heap = () =>
    page.evaluate(() => {
      globalThis.gc?.();
      return performance.memory?.usedJSHeapSize ?? null;
    });
  const frames = () =>
    page.evaluate(async () => {
      const v = window.__godsEyeView.viewer;
      const samples = [];
      let previous;
      const remove = v.scene.postRender.addEventListener(() => {
        const now = performance.now();
        if (previous) samples.push(now - previous);
        previous = now;
      });
      for (let i = 0; i < 90; i++) {
        v.camera.rotateRight(0.00001);
        v.scene.requestRender();
        await new Promise(requestAnimationFrame);
      }
      remove();
      samples.sort((a, b) => a - b);
      return {
        frames: samples.length,
        p50Ms: samples[Math.floor(samples.length * 0.5)],
        p95Ms: samples[Math.floor(samples.length * 0.95)],
      };
    });
  report.heapBefore = await heap();
  report.framesOff = await frames();
  const start = performance.now();
  check('layer enable succeeds', await enabled(true));
  report.loadMs = performance.now() - start;
  await delay(2500);
  let s = await stats();
  check(
    'known counts match pack',
    s.lineCount === 367 && s.substationCount === 57 && s.unknownCount === 0,
    s,
  );
  check(
    'regional geometry is bounded and visible',
    s.displayedCount > 0 && s.displayedCount <= 600 && s.entityCount > 0,
    s.entityCount,
  );
  const linePoint = await page.evaluate(async () => {
    const C = await import('/node_modules/.vite/deps/cesium.js');
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      if (ds.name !== 'transmission') continue;
      for (const e of ds.entities.values) {
        if (!e.polyline || !e.id.startsWith('transmission:')) continue;
        const positions = e.polyline.positions.getValue(C.JulianDate.now());
        for (let j = 1; j < positions.length; j++) {
          const mid = C.Cartesian3.midpoint(
            positions[j - 1],
            positions[j],
            new C.Cartesian3(),
          );
          const p = C.SceneTransforms.worldToWindowCoordinates(v.scene, mid);
          if (!p || p.x < 400 || p.x > 1150 || p.y < 180 || p.y > 800) continue;
          const picked = v.scene.pick(p)?.id;
          if (picked?.polyline && picked.id.startsWith('transmission:'))
            return { x: p.x, y: p.y, id: picked.id };
        }
      }
    }
    return null;
  });
  check(
    'ground-clamped lines render and are pickable',
    Boolean(linePoint),
    linePoint,
  );
  await page.mouse.click(linePoint.x, linePoint.y);
  await delay(400);
  check(
    'line click selects the picked OSM record',
    (await stats()).selectedId === linePoint.id.split(':')[1],
  );
  await page.screenshot({ path: `${out}/line-selected.png` });
  await page.mouse.click(380, 700);
  const row = '[data-layer-id="transmission"]';
  // Open the normal data-layer panel using its application-owned controller.
  await page.click('[data-collapse-target="data-panel"]');
  await page.$eval(row, (el) => el.scrollIntoView({ block: 'center' }));
  await delay(500);
  await page.screenshot({ path: `${out}/regional.png` });
  report.heapOn = await heap();
  report.framesOn = await frames();
  await page.click(`${row} [data-chip-id="unknown"]`);
  await delay(800);
  s = await stats();
  check(
    'unknown chip reflects its pressed state',
    await page.$eval(
      `${row} [data-chip-id="unknown"]`,
      (el) => el.getAttribute('aria-pressed') === 'true',
    ),
  );
  check('optional unknown records are separate', s.unknownCount === 418, s);
  check(
    'dense view reports omitted detail',
    s.displayedCount <= 600 && s.omittedCount > 0,
    s.omittedCount,
  );
  await filters({ voltage: '400000' });
  s = await stats();
  check(
    'voltage filter preserves tagged substation values',
    s.lineCount === 87 && s.substationCount === 9 && s.unknownCount === 418,
    s,
  );
  await filters({ voltage: 'all' });
  await page.click('[data-collapse-target="data-panel"]');
  await camera(18.52, -33.92, 13000);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('earthquakes', true, {
      origin: 'user',
    }),
  );
  await delay(2000);
  check(
    'hazard layer remains enabled beside transmission',
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.isEnabled('earthquakes'),
    ),
  );
  // Click a real rendered substation through Cesium's hit path.
  const point = await page.evaluate(async () => {
    const C = await import('/node_modules/.vite/deps/cesium.js');
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      if (ds.name !== 'transmission') continue;
      for (const entity of ds.entities.values) {
        if (!entity.point) continue;
        const position = entity.position.getValue(C.JulianDate.now());
        const p = C.SceneTransforms.worldToWindowCoordinates(v.scene, position);
        if (p && p.x > 400 && p.x < 1200 && p.y > 150 && p.y < 800) {
          const picked = v.scene.pick(p)?.id;
          if (picked?.point && picked.id.startsWith('transmission:'))
            return { x: p.x, y: p.y, id: picked.id };
        }
      }
    }
    return null;
  });
  check(
    'a rendered substation is available for selection',
    Boolean(point),
    point,
  );
  await page.mouse.click(point.x, point.y);
  await delay(700);
  check(
    'map click selects source record',
    (await stats()).selectedId === point.id.split(':')[1],
    (await stats()).selectedId,
  );
  await page.screenshot({ path: `${out}/close-selected.png` });
  await camera(-97, 30, 150000);
  await delay(300);
  s = await stats();
  check(
    'outside coverage is explicit',
    s.outsideCoverage && s.displayedCount === 0,
    s,
  );
  await camera(18.64, -33.9, 5000000);
  s = await stats();
  check(
    'global zoom releases detailed geometry',
    s.zoomedOut && s.displayedCount === 0 && s.entityCount === 1,
    s,
  );
  await enabled(false);
  s = await stats();
  check(
    'disable releases rendered entities',
    s.entityCount === 0 && s.displayedCount === 0,
    s,
  );
  await enabled(true);
  await delay(500);
  check('re-enable uses cached pack', packRequests === 1, packRequests);
  await enabled(false);
  report.heapAfterDisable = await heap();
  report.pageErrors = errors;
  check('no page exceptions', errors.length === 0, errors);
  await writeFile(
    `${out}/results.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  await page.goto('about:blank');
  await page.goto(
    `${url}/?welcome=0#lat=-33.915&lon=18.645&alt=125000&pitch=-90&map=osm&v=2&l=5&lo=5.u.1_5.v.400`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => window.__godsEyeView?.dataManager?.isEnabled('transmission'),
    { timeout: 90000 },
  );
  check(
    'shared filters restore in the real app',
    await page.evaluate(() => {
      const p = window.__godsEyeView.dataManager.layers
        .get('transmission')
        .module.getParams();
      return p.showUnknown && p.voltage === '400000';
    }),
  );
} finally {
  await writeFile(
    `${out}/results.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  await browser.close();
}
