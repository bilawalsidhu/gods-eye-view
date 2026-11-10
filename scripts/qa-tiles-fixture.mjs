import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as geo from '../src/geo/index.js';
import {
  assertKeylessPreview,
  createStrict,
  localPreview,
  openPage,
  TILES_FIXTURE_PATH,
  tilesFixtureRoutes,
  waitForCameraAtRest,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
const { extras: fixture } = JSON.parse(
  readFileSync(new URL('./fixtures/tiles3d/tileset.json', import.meta.url)),
);
base.search = `?engine=navara&welcome=0&qaTileset=${encodeURIComponent(TILES_FIXTURE_PATH)}`;
base.hash = `v=2&lat=${fixture.origin.lat}&lon=${fixture.origin.lon}&alt=1100&heading=0&pitch=-90&roll=0&map=photoreal&l=`;
let releaseTiles;
let pendingTiles;
const holdTiles = () => {
  pendingTiles = new Promise((resolve) => {
    releaseTiles = resolve;
  });
};
holdTiles();
const routes = tilesFixtureRoutes(base.origin).map((route) => ({
  ...route,
  async respond(request) {
    if (route.pattern.endsWith('.glb')) await pendingTiles;
    return route.respond(request);
  },
}));
routes.push({
  pattern: `${base.origin}/api/overpass/status`,
  respond: () => ({
    contentType: 'application/json',
    body: '{"configured":true}',
  }),
});
const strict = createStrict({
  origin: base.origin,
  layers: ['osm-places'],
  routes,
});

await strict.run({}, async (browser) => {
  const { page, errors } = await openPage(browser, { shaderErrors: true });
  await page.setCacheEnabled(false);
  let readsBefore = { ...strict.ledger.routes };
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  for (const kind of ['navara', 'cesium']) {
    if (kind === 'cesium') {
      readsBefore = { ...strict.ledger.routes };
      holdTiles();
      await strict.pick(page, kind, { settle: false });
    }
    try {
      await page.waitForFunction(
        (kind) => {
          const engine = window.__godsEyeView?.engine;
          return (
            engine?.kind === kind &&
            engine.maps.photorealActive() &&
            !engine.surface.tilesLoaded()
          );
        },
        { timeout: 90000 },
        kind,
      );
      await strict.passed(
        page,
        'osm-places',
        'tilesLoaded is false while GLBs are held',
      );
    } finally {
      releaseTiles();
    }
    await waitForEngine(page, kind);
    await page.evaluate(
      async (destination) => {
        const { engine, styleManager } = window.__godsEyeView;
        styleManager.orbitController.stop();
        engine.camera.cancelFlight();
        await engine.maps.setTerrain({ kind: 'ellipsoid' });
        engine.camera.setView({
          destination,
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        engine.render.request('qa-tiles-fixture');
      },
      geo.cartesian3.fromDegrees(fixture.origin.lon, fixture.origin.lat, 1100),
    );
    await loaded(page);
    await waitForCameraAtRest(page);
    for (const route of routes.slice(0, 5))
      assert.ok(
        strict.ledger.routes[route.pattern] > (readsBefore[route.pattern] ?? 0),
        `${kind} intercepted ${new URL(route.pattern).pathname}`,
      );
    await strict.passed(
      page,
      'osm-places',
      'tilesLoaded becomes true; all five files served by same-origin routes',
    );

    const heights = await page.evaluate(
      ({ probes, clampStart }) => {
        const { surface } = window.__godsEyeView.engine;
        return {
          sampled: Object.fromEntries(
            Object.entries(probes).map(([id, p]) => [
              id,
              surface.sampleHeight(p.cartographic),
            ]),
          ),
          clamped: surface.clampToHeight(clampStart),
        };
      },
      {
        probes: fixture.probes,
        clampStart: geo.cartesian3.fromDegrees(
          fixture.probes.roof.lon,
          fixture.probes.roof.lat,
          fixture.probes.roof.height + 300,
        ),
      },
    );
    for (const [id, p] of Object.entries(fixture.probes))
      assert.ok(
        Math.abs(heights.sampled[id] - p.height) <= 0.5,
        `${kind} ${id}: ${JSON.stringify(heights)}`,
      );
    assert.ok(
      Math.abs(heights.sampled.block50 - heights.sampled.plate - 50) <= 0.5,
    );
    assert.ok(
      heights.clamped &&
        geo.cartesian3.distance(
          heights.clamped,
          fixture.probes.roof.position,
        ) <= 0.5,
    );
    await strict.passed(
      page,
      'osm-places',
      'known plate, 50 m, 200 m and sloping roof heights; clamp lands on roof',
      heights,
    );

    const drapes = [];
    for (const surface of ['tiles', 'terrain']) {
      if (surface === 'terrain') {
        await page.evaluate(async () => {
          const { engine, mapStackController } = window.__godsEyeView;
          await mapStackController.setStack('osm');
          await engine.maps.setTerrain({ kind: 'ellipsoid' });
        });
        await loaded(page);
      }
      const p = fixture.probes.block50;
      const position = geo.cartesian3.fromDegrees(
        p.lon,
        p.lat,
        surface === 'tiles' ? p.height : 0,
      );
      const baseline = await pixels(page, position);
      for (const drape of ['tiles', 'terrain']) {
        await page.evaluate(
          ({ lon, lat, drape }) => {
            const { engine } = window.__godsEyeView;
            const set = engine.ground.createSet({
              id: 'qa-drape',
              kind: 'cell',
              drape,
              pickable: false,
            });
            set.replace([
              {
                west: lon - 0.0003,
                east: lon + 0.0003,
                south: lat - 0.0003,
                north: lat + 0.0003,
                fill: [1, 0, 1, 1],
              },
            ]);
            set.commit();
            window.qaDrape = set;
          },
          { ...p, drape },
        );
        try {
          await page.waitForFunction(
            () => {
              window.__godsEyeView.engine.render.request('qa-drape');
              return window.qaDrape.ready();
            },
            { timeout: 30000 },
          );
          const rgb = await pixels(page, position);
          const drawn = rgb[0] > 180 && rgb[1] < 80 && rgb[2] > 180;
          assert.equal(
            drawn,
            surface === drape,
            `${kind} ${drape} on ${surface}: ${rgb}`,
          );
          if (surface !== drape)
            assert.ok(
              rgb.every((v, i) => Math.abs(v - baseline[i]) < 15),
              'other surface stays unchanged',
            );
          drapes.push({ surface, drape, baseline, rgb });
        } finally {
          await page.evaluate(() => {
            window.qaDrape.destroy();
            delete window.qaDrape;
          });
        }
      }
    }
    await strict.passed(
      page,
      'osm-places',
      'drape tiles and terrain draw only on their respective surface (pixels)',
      drapes,
    );
    await page.evaluate(() =>
      window.__godsEyeView.mapStackController.setStack('photoreal'),
    );
    await loaded(page);
    await waitForCameraAtRest(page);
    await checkPoints(page, kind);
    await assertKeylessPreview(page);
    console.log(
      `PASS ${kind} fixture heights, clamp, drapes, tilesLoaded and surface-points budget`,
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(
    Object.keys(strict.ledger.external).filter((host) =>
      /google|gstatic|cesium\.com/i.test(host),
    ),
    [],
  );
});

async function loaded(page) {
  await page.waitForFunction(
    () => {
      const { engine } = window.__godsEyeView;
      engine.render.request('qa-tiles-fixture');
      return engine.surface.tilesLoaded();
    },
    { polling: 100, timeout: 90000 },
  );
}

// Read actual canvas pixels during postRender; Cesium discards them afterwards.
async function pixels(page, position) {
  return page.evaluate(async (position) => {
    const { engine } = window.__godsEyeView;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 5;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    for (let frame = 0; frame < 2; frame++)
      await new Promise((resolve) => {
        const off = engine.frames.postRender.addEventListener(() => {
          off();
          const point = engine.projector.worldToWindow(position);
          const scale = engine.host.canvas.width / engine.host.size().width;
          context.drawImage(
            engine.host.canvas,
            Math.round(point.x * scale) - 2,
            Math.round(point.y * scale) - 2,
            5,
            5,
            0,
            0,
            5,
            5,
          );
          resolve();
        });
        engine.render.request('qa-drape-pixels');
      });
    const data = context.getImageData(0, 0, 5, 5).data;
    return [0, 1, 2].map(
      (channel) =>
        data.reduce(
          (sum, value, i) => sum + (i % 4 === channel ? value : 0),
          0,
        ) / 25,
    );
  }, position);
}

async function checkPoints(page, kind) {
  await page.evaluate(async (points) => {
    const { engine, viewer, dataManager } = window.__godsEyeView;
    const layer = dataManager.layers.get('osm-places').module;
    layer.setResults([], null);
    await dataManager.setEnabled('osm-places', true);
    // Reattach this real layer once so its mover commits can be observed.
    layer.detachRenderer();
    const createSet = engine.movers.createSet;
    const sampleHeight = engine.surface.sampleHeight;
    const target =
      engine.kind === 'cesium'
        ? viewer.scene._picking._pickOffscreenView.pickFramebuffer
        : engine.extensions.navara.view._renderer;
    const method = engine.kind === 'cesium' ? 'begin' : 'render';
    const render = target[method];
    if (typeof render !== 'function')
      throw new Error('Missing pick-render counter hook');
    const stats = (window.qaPoints = {
      passes: [],
      positions: [],
      samples: 0,
      renders: 0,
    });
    let pass = null,
      passStart = 0,
      sampling = false;
    target[method] = function (...args) {
      if (sampling) {
        pass.renders++;
        stats.renders++;
      }
      return render.apply(this, args);
    };
    engine.surface.sampleHeight = function (...args) {
      if (!pass) {
        passStart = performance.now();
        pass = {
          samples: 0,
          renders: 0,
          ms: 0,
          startsMs: [],
          cameraEstimate: !points.some(
            (p) =>
              Math.abs(p.cartographic.longitude - args[0].longitude) < 1e-10 &&
              Math.abs(p.cartographic.latitude - args[0].latitude) < 1e-10,
          ),
        };
        stats.passes.push(pass);
        // A placement callback samples synchronously, without yielding.
        queueMicrotask(() => {
          pass = null;
        });
      }
      pass.samples++;
      stats.samples++;
      const start = performance.now();
      pass.startsMs.push(start - passStart);
      sampling = true;
      try {
        return sampleHeight.apply(this, args);
      } finally {
        sampling = false;
        pass.ms += performance.now() - start;
      }
    };
    engine.movers.createSet = function (options) {
      const set = createSet.call(this, options);
      if (options.id !== 'osm-places') return set;
      const write = set.set,
        commit = set.commit;
      const positions = [];
      set.set = function (index, fields) {
        if (fields.position) positions[index] = { ...fields.position };
        return write.call(this, index, fields);
      };
      set.commit = function () {
        const result = commit.call(this);
        stats.positions = positions.map((p) => ({ ...p }));
        return result;
      };
      return set;
    };
    window.qaRestorePoints = () => {
      engine.surface.sampleHeight = sampleHeight;
      engine.movers.createSet = createSet;
      target[method] = render;
    };
    layer.attachRenderer(viewer, { engine });
    layer.setResults(
      points.map((p, i) => ({ id: String(i), lon: p.lon, lat: p.lat })),
      { kind: 'fixture', label: 'Roof points', area: 'Austin' },
    );
  }, fixture.points);
  try {
    const expected = fixture.points.map((p) =>
      geo.cartesian3.fromDegrees(p.lon, p.lat, p.height + 2),
    );
    await page.waitForFunction(
      (expected) => {
        const positions = window.qaPoints.positions;
        return (
          positions.length === expected.length &&
          positions.every(
            (p, i) =>
              Math.hypot(
                p.x - expected[i].x,
                p.y - expected[i].y,
                p.z - expected[i].z,
              ) <= 0.5,
          )
        );
      },
      { polling: 100, timeout: 30000 },
      expected,
    );
    const result = await page.evaluate(() => ({
      ...window.qaPoints,
      drawn: window.__godsEyeView.engine.movers
        .list()
        .find((s) => s.id === 'osm-places'),
    }));
    assert.equal(result.drawn.count, fixture.points.length);
    assert.equal(result.drawn.shown, true);
    assert.ok(
      result.samples >= fixture.points.length && result.passes.length > 1,
    );
    assert.ok(
      result.passes.every((p) => p.samples <= 16 && p.renders <= 16),
      JSON.stringify(result.passes),
    );
    // The 4 ms limit is checked between points: one expensive sample (and
    // its initial camera estimate) may finish after the deadline.
    assert.ok(
      result.passes.every((p) =>
        p.startsMs.slice(p.cameraEstimate ? 2 : 1).every((ms) => ms < 4),
      ),
      JSON.stringify(result.passes),
    );
    if (kind === 'cesium')
      assert.ok(
        result.renders >= fixture.points.length,
        'count actual offscreen pick renders',
      );
    else assert.equal(result.renders, 0, 'tile sampling uses CPU rays');
    await strict.passed(
      page,
      'osm-places',
      '40 roof points committed at surface + 2 m; 16 samples/pick renders and 4 ms soft budget per pass',
      result,
    );
  } finally {
    await page.evaluate(async () => {
      window.qaRestorePoints();
      const { dataManager } = window.__godsEyeView;
      await dataManager.setEnabled('osm-places', false);
      dataManager.layers.get('osm-places').module.setResults([], null);
    });
  }
}
