import { whenSettled } from './qa/ready.mjs';
import assert from 'node:assert/strict';
import { fromDegrees } from '../src/geo/cartesian3.js';
import {
  clickEmptyGround,
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';
import { installTransitFixture } from './fixtures/layers/transit.mjs';
import {
  combinedPayloads,
  installCombinedFixture,
} from './fixtures/layers/combined.mjs';
const url = localPreview(process.argv[2]),
  bus = process.argv.includes('--transit'),
  id = bus ? 'transit' : 'bikeshare';
// Boston, where the fixtures put the city's stations and vehicles. Transit
// starts outside every feed region (central Vermont) and is approached.
const CITY = { lat: 42.3554, lon: -71.0605, alt: 2700 };
const start = bus ? { lat: 44.2, lon: -72.6, alt: 2700 } : CITY;
url.search = '?engine=navara&welcome=0';
url.hash = `v=2&lat=${start.lat}&lon=${start.lon}&alt=${start.alt}&pitch=-90&heading=0&map=sentinel2&l=`;
// Every station of the bikeshare fixture reports 7 bikes and 13 docks; the
// transit fixture has 12 fresh vehicles (and one stale, dropped).
const STATIONS = combinedPayloads.bikes.length;
const VEHICLES = 12;
const strict = createStrict({
  origin: url.origin,
  layers: [id],
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
  await p.setViewport({ width: 1280, height: 900 });
  const fx = bus
    ? await installTransitFixture(p)
    : await installCombinedFixture(p);
  fx.setStep?.(9);
  await p.goto(url.href);
  await waitForEngine(p, 'navara');
  await p.evaluate(async (id) => {
    const { dataManager, styleManager } = window.__godsEyeView;

    await styleManager.initialRestorePromise;
    window.qaUrban = dataManager.layers.get(id).module;
    await dataManager.setEnabled(id, true, { origin: 'user' });
  }, id);
  const vehicleReads = () =>
    fx.requests.filter((path) => path.startsWith('/api/transit/vehicles/'))
      .length;
  if (bus) {
    // Outside every feed region the layer waits and reads no feed.
    await whenSettled(p);
    const outside = await p.evaluate(() => window.qaUrban.getStats());
    await strict.check(
      p,
      'transit',
      'outside every feed region: no vehicles, no feed read, asks to move to a covered region',
      outside.count === 0 &&
        outside.status === 'zoom-in' &&
        vehicleReads() === 0,
      { stats: outside, reads: vehicleReads() },
    );
    // Approach the city: the MBTA feed turns on and its vehicles arrive.
    await p.evaluate(
      (destination) => {
        const { camera, render } = window.__godsEyeView.engine;
        camera.setView({
          destination,
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        render.request('qa-approach');
      },
      fromDegrees(CITY.lon, CITY.lat, CITY.alt),
    );
    await p.waitForFunction(
      (n) =>
        window.qaUrban.getStats().count === n &&
        window.qaUrban.getStats().feeds?.includes('mbta'),
      { timeout: 30000 },
      VEHICLES,
    );
    await strict.check(
      p,
      'transit',
      `approaching Boston from outside turns on the MBTA feed: ${VEHICLES} vehicles`,
      vehicleReads() > 0,
      { reads: vehicleReads() },
    );
  }
  await p.waitForFunction(() => window.qaUrban.getStats().count > 0, {
    timeout: 30000,
  });
  // A station or vehicle the engine's own picker returns, uncovered.
  const findTarget = (key = null) =>
    p
      .waitForFunction(
        (key) => {
          const a = window.__godsEyeView;
          const canvas = a.engine.host.canvas;
          const box = canvas.getBoundingClientRect();
          for (const r of window.qaUrban.getDetectableObjects({
            maxCount: 500,
            seed: 0,
          })) {
            if (key && r.sourceId !== key) continue;
            const s = a.engine.projector.worldToWindow(r.position);
            if (!s || s.x < 420 || s.x > 860 || s.y < 205 || s.y > 600)
              continue;
            if (
              !canvas.contains(
                document.elementFromPoint(box.left + s.x, box.top + s.y),
              )
            )
              continue;
            const pk = a.engine.picker.pick(s);
            if (pk?.id === r.sourceId || pk?.id?.id === r.sourceId)
              return { x: box.left + s.x, y: box.top + s.y, id: r.sourceId };
          }
          return false;
        },
        { timeout: 30000 },
        key,
      )
      .then((handle) => handle.jsonValue());
  const selected = (key) =>
    p.waitForFunction(
      (key) =>
        window.qaUrban
          .getDetectableObjects({ maxCount: 500, seed: 0 })
          .some((r) => r.sourceId === key && r.skipLabel),
      { timeout: 20000 },
      key,
    );
  // A click on empty ground (nothing picked around it, nothing covering it).
  const clickEmpty = async () => {
    await clickEmptyGround(p, {
      left: 440,
      top: 230,
      right: 840,
      bottom: 600,
      step: 9,
      radius: 8,
    });
    await p.waitForFunction(
      () =>
        !window.qaUrban
          .getDetectableObjects({ maxCount: 500, seed: 0 })
          .some((r) => r.skipLabel),
      { timeout: 15000 },
    );
  };
  const target = await findTarget();
  await p.mouse.click(target.x, target.y);
  await selected(target.id);
  await strict.passed(
    p,
    id,
    bus ? 'a click on a vehicle selects it' : 'a click on a station selects it',
    target,
  );
  const reads = () =>
    fx.requests.filter((path) =>
      bus
        ? path.includes('/transit/trail/')
        : path.includes('station_information'),
    ).length;
  if (bus)
    await p.waitForFunction(
      () => window.qaUrban.getDetectableObjects({ maxCount: 500 }).length > 0,
    );
  let original = reads();
  const first = await p.evaluate(() =>
    window.qaUrban.getAnalystRecords(500).map((v) => v.id),
  );
  const checkData = async () => {
    const stats = await p.evaluate(() => window.qaUrban.getStats());
    if (bus) {
      await strict.check(
        p,
        'transit',
        `${VEHICLES} fresh vehicles (the stale one dropped)`,
        stats.count === VEHICLES,
        stats.count,
      );
      return;
    }
    const rows = await p.evaluate(() =>
      window.qaUrban.getAnalystRecords(1000).map((r) => ({
        bikes: r.bikesAvailable,
        docks: r.docksAvailable,
        renting: r.renting,
      })),
    );
    await strict.check(
      p,
      'bikeshare',
      `${STATIONS} stations, each with 7 bikes and 13 docks available and renting`,
      stats.count === STATIONS &&
        rows.length === STATIONS &&
        rows.every((r) => r.bikes === 7 && r.docks === 13 && r.renting),
      { count: stats.count, rows: rows.length, sample: rows[0] },
    );
  };
  await checkData();
  for (const kind of ['cesium', 'navara']) {
    await strict.switchTo(p, kind);
    await selected(target.id);
    const v = await p.evaluate(
      (id) => ({
        same:
          window.qaUrban ===
          window.__godsEyeView.dataManager.layers.get(id).module,
        stats: window.qaUrban.getStats(),
        ids: window.qaUrban.getAnalystRecords(500).map((v) => v.id),
      }),
      id,
    );
    console.log(kind, id, v.stats.count, target.id, reads());
    assert.ok(v.same);
    assert.deepEqual(v.ids, first);
    assert.equal(reads(), original);
    await strict.passed(
      p,
      id,
      'same model, same records, the clicked object still selected, no source read again',
    );
    await checkData();
    if (kind === 'cesium') {
      // Click-picking on Cesium: clear with a click on empty ground, then
      // click the same object again.
      await clickEmpty();
      const again = await findTarget(target.id);
      await p.mouse.click(again.x, again.y);
      await selected(target.id);
      await strict.passed(
        p,
        id,
        'a click on empty ground clears the selection; a click on the object selects it again',
        again,
      );
      // Selecting a vehicle again reads its trail again.
      original = reads();
    }
  }
  assert.deepEqual(errors, []);
  await fx.dispose?.();
  console.log(
    'PASS viewport activation, real pick and original city data across two switches',
  );
});
