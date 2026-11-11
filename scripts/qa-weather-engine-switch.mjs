import { whenFramesDrawn, whenTilesLoaded } from './qa/ready.mjs';
import { fromDegrees } from '../src/geo/cartesian3.js';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=43.6500&lon=-79.3800&alt=46000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
const strict = createStrict({
  origin: base.origin,
  layers: [
    'weather-radar',
    'weather-satellite',
    'weather-lightning',
    'weather-cyclones',
  ],
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
  const times = ['2026-11-02T12:00:00.000Z', '2026-11-02T12:05:00.000Z'];
  const ids = ['weather-radar', 'weather-satellite', 'weather-lightning'];
  const images = new Map(),
    reads = new Map();
  let bulletin = '10',
    cycloneReads = 0;
  function advisory() {
    const forecast = bulletin === '10';
    const storm = {
      id: 'al012026',
      name: 'QA storm',
      basin: 'AL',
      classification: 'TS',
      position: { longitude: -79.38, latitude: 43.65 },
      advisoryNumber: bulletin,
      issuedAt: times[1],
      positionAt: times[1],
      windKt: 40,
      pressureHpa: 1000,
      movement: { directionDegrees: 45, speedKt: 10 },
      advisoryUrl: null,
      outlookUrl: null,
      geometryStatus: forecast ? 'current' : 'pending',
      geometryAdvisoryNumber: forecast ? bulletin : null,
      track: forecast
        ? {
            type: 'LineString',
            coordinates: [
              [-79.38, 43.65],
              [-79.31, 43.68],
            ],
          }
        : null,
      cone: forecast
        ? {
            type: 'Polygon',
            coordinates: [
              [
                [-79.35, 43.63],
                [-79.28, 43.63],
                [-79.28, 43.7],
                [-79.35, 43.63],
              ],
            ],
          }
        : null,
      forecastPoints: forecast
        ? [
            {
              tauHours: 24,
              position: { longitude: -79.31, latitude: 43.68 },
              windKt: 50,
              gustKt: 60,
            },
          ]
        : [],
    };
    return {
      schemaVersion: 1,
      source: 'QA NOAA',
      attribution: 'NOAA fixture',
      coverage: 'Atlantic',
      fetchedAt: Date.parse(times[1]),
      stale: false,
      unavailable: false,
      reason: null,
      storms: [storm],
    };
  }
  await p.setRequestInterception(true);
  p.on('request', async (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/api/cyclones') {
      cycloneReads++;
      return req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(advisory()),
      });
    }
    if (!url.pathname.startsWith('/api/weather/')) return req.continue();
    const product = url.searchParams.get('product');
    if (url.pathname.endsWith('manifest')) {
      reads.set(product, (reads.get(product) || 0) + 1);
      return req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          product,
          times,
          latest: times.at(-1),
          maxLevel: 6,
          tileSize: 256,
          tilingScheme: 'geographic',
          bounds: { west: -130, south: 20, east: -50, north: 60 },
          display: { credit: 'QA weather observations' },
        }),
      });
    }
    const image = url.pathname.endsWith('image');
    const width = image
      ? Number(
          (
            url.searchParams.get('size') ||
            (product === 'clouds' ? '2048' : '4096')
          ).split('x')[0],
        )
      : 256;
    const previous = url.searchParams.get('time') === times[0];
    const color =
      product === 'lightning'
        ? previous
          ? '#ff00ff'
          : '#00ffff'
        : product === 'radar'
          ? '#ff0000'
          : '#ffffff';
    const key = width + color;
    if (!images.has(key))
      images.set(
        key,
        sharp({
          create: {
            width,
            height: image ? width / 2 : width,
            channels: 4,
            background: color,
          },
        })
          .png()
          .toBuffer(),
      );
    return req.respond({
      status: 200,
      contentType: 'image/png',
      body: await images.get(key),
    });
  });
  p.on('console', (msg) => {
    if (msg.type() === 'error' && /Shader|WebGLProgram/.test(msg.text()))
      console.log('GPU', msg.text().slice(0, 3000));
  });
  await p.goto(base.href);
  await waitForEngine(p, 'navara');
  const waitTime = (ids, time) =>
    p.waitForFunction(
      (ids, time) =>
        ids.every(
          (id) =>
            window.__godsEyeView?.dataManager.layers
              .get(id)
              .module.getDiagnostics().time === time,
        ),
      { timeout: 50000 },
      ids,
      time,
    );
  const sample = async () => {
    const handle = await p.waitForFunction(
      (ids) => {
        const { engine, dataManager } = window.__godsEyeView;
        engine.render.request('qa-weather-imagery');
        const active = ids.filter((id) => dataManager.isEnabled(id));
        return (
          active.length > 0 &&
          active.every((id) => {
            const state = dataManager.layers.get(id).module.getDiagnostics();
            return (
              state.time && !state.loading && !state.hidden && !state.error
            );
          }) &&
          engine.imagery
            .list()
            .filter(
              (layer) =>
                layer.id.startsWith('weather-') &&
                layer.shown &&
                layer.alpha > 0,
            ).length >= active.length
        );
      },
      { polling: 100, timeout: 50000 },
      ids,
    );
    await handle.dispose();
    // A staged frame can be current before the newly shown layer has painted.
    await whenFramesDrawn(p);
    await whenTilesLoaded(p);
    await whenFramesDrawn(p);
    const crop = await sharp(await p.screenshot())
      .extract({ left: 535, top: 388, width: 12, height: 12 })
      .removeAlpha()
      .raw()
      .toBuffer();
    return [0, 1, 2].map(
      (i) =>
        crop.reduce((n, v, k) => n + (k % 3 === i ? v : 0), 0) /
        (crop.length / 3),
    );
  };
  await p.evaluate(() => {

  });
  for (const id of [ids[1], ids[0], ids[2]]) {
    await p.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.setEnabled(id, true, {
          origin: 'user',
        }),
      id,
    );
    await waitTime([id], times[1]);
    const latest = await sample();
    if (id === ids[1])
      assert.ok(
        Math.min(...latest) > 150,
        'satellite must paint bright clouds',
      );
    if (id === ids[0])
      assert.ok(
        latest[0] > latest[1] + 50,
        'radar must paint red over satellite',
      );
    if (id === ids[2])
      assert.ok(
        latest[2] > latest[0] + 50,
        'lightning must paint cyan over radar',
      );
    await strict.passed(p, id, 'latest frame paints in stacking order', latest);
    console.log('latest', id, latest);
  }
  await p.evaluate((ids) => {
    window.qaWeather = ids.map((id) =>
      window.__godsEyeView.dataManager.layers.get(id),
    );
    window.qaWeather[0].module.setParams({ step: -1 });
  }, ids);
  await waitTime(ids, times[0]);
  const polls = [...reads.entries()];
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.switchTo(p, kind);
    }
    await waitTime(ids, times[0]);
    const state = await p.evaluate(
      (ids) =>
        ids.map((id, i) => {
          const entry = window.__godsEyeView.dataManager.layers.get(id);
          const d = entry.module.getDiagnostics();
          return {
            same: entry === window.qaWeather[i],
            mode: d.clock.mode,
            target: d.clock.target,
            error: d.error,
            time: d.time,
          };
        }),
      ids,
    );
    for (const product of state)
      assert.deepEqual(product, {
        same: true,
        mode: 'history',
        target: times[0],
        error: null,
        time: times[0],
      });
    const rgb = await sample();
    console.log(kind, rgb);
    assert.ok(
      rgb[0] > rgb[1] + 15 && rgb[2] > rgb[1] + 15,
      kind + ' lightning must draw magenta above radar',
    );
    assert.deepEqual(
      [...reads.entries()],
      polls,
      'A globe change must not refetch the observation manifest',
    );
    await strict.passed(
      p,
      ids,
      'same entry, shared history clock on the earlier frame, no manifest refetch, lightning above radar',
      rgb,
    );
    console.log(
      'PASS',
      kind,
      'common clock, all three frames, visible lightning',
    );
  }
  // Exercise the raised intersection branch without contacting a tile provider.
  await p.evaluate(() => {
    const maps = window.__godsEyeView.engine.maps;
    const actual = maps.photorealActive.bind(maps);
    maps.photorealActive = () => true;
    window.qaRestoreSurface = () => {
      maps.photorealActive = actual;
    };
    window.__godsEyeView.engine.render.request('qa-raised-weather');
  });
  const raised = await sample();
  assert.ok(
    raised[0] > raised[1] + 15 && raised[2] > raised[1] + 15,
    'raised weather must remain visible',
  );
  await p.evaluate(() => window.qaRestoreSurface());
  await p.evaluate(async (ids) => {
    const manager = window.__godsEyeView.dataManager;
    for (const id of ids)
      await manager.setEnabled(id, false, { origin: 'user' });
    await manager.setEnabled('weather-cyclones', true, { origin: 'user' });
    window.qaStorm = manager.layers.get('weather-cyclones').module;
  }, ids);
  const click = async (lon, lat, insideCone) => {
    const hit = await p.waitForFunction(
      ({ lon, lat, base, insideCone }) => {
        const { engine } = window.__godsEyeView;
        const longitude = (lon * Math.PI) / 180,
          latitude = (lat * Math.PI) / 180;
        const height =
          engine.surface.terrainHeight({ longitude, latitude, height: 0 }) ?? 0;
        const xy = engine.projector.worldToWindow(
          {
            x: base.x + height * Math.cos(latitude) * Math.cos(longitude),
            y: base.y + height * Math.cos(latitude) * Math.sin(longitude),
            z: base.z + height * Math.sin(latitude),
          },
          {},
        );
        if (!xy) return false;
        const canvas = engine.host.canvas,
          rect = canvas.getBoundingClientRect();
        const x = rect.left + xy.x,
          y = rect.top + xy.y;
        if (document.elementFromPoint(x, y) !== canvas) return false;
        const id = engine.picker.pick(xy)?.id;
        if (
          String(id?.id ?? id).startsWith('cyclone:al012026:cone:') !==
          insideCone
        )
          return false;
        return [x, y];
      },
      { timeout: 30000 },
      { lon, lat, base: fromDegrees(lon, lat), insideCone },
    );
    await p.mouse.click(...(await hit.jsonValue()));
    await hit.dispose();
  };
  const before = cycloneReads;
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.select('#globe-engine', kind);
      await waitForEngine(p, kind);
    }
    await p.waitForFunction(
      () =>
        window.__godsEyeView.dataManager.layers.get('weather-cyclones')
          .module === window.qaStorm &&
        window.qaStorm.getDiagnostics().selectedId === 'al012026',
    );
    const d = await p.evaluate(() => window.qaStorm.getDiagnostics());
    assert.deepEqual(
      [d.storms, d.tracks, d.cones, d.forecastPoints],
      [1, 1, 1, 1],
      kind,
    );
    await click(-79.43, 43.59, false);
    await p.waitForFunction(
      () => window.qaStorm.getDiagnostics().selectedId === null,
    );
    await click(-79.3, 43.643, true);
    await p.waitForFunction(
      () => window.qaStorm.getDiagnostics().selectedId === 'al012026',
    );
    assert.equal(cycloneReads, before);
    await strict.passed(
      p,
      'weather-cyclones',
      'storm, track, cone and forecast point; clicks outside and inside the cone deselect and select; no refetch',
    );
    console.log('PASS', kind, 'pick advisory cone and retain selected storm');
  }
  bulletin = '11';
  const next = await p.evaluate(async () => {
    await window.qaStorm.update();
    return window.qaStorm.getDiagnostics();
  });
  assert.deepEqual(
    [
      next.storms,
      next.tracks,
      next.cones,
      next.forecastPoints,
      next.selectedId,
    ],
    [1, 0, 0, 0, 'al012026'],
  );
  console.log(
    'PASS advisory 11 removes expired geometry while retaining the storm',
  );
  assert.deepEqual(errors, []);
});
