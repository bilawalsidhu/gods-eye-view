import { whenSettled } from './qa/ready.mjs';
import { trafficFixtureResponse } from './traffic-fixtures.mjs';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';
import { STRICT_TILE_HOSTS } from './qa-map-policy.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=30.2670&lon=-97.7440&alt=1800&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
// The scenario answers the Sentinel-2 host itself (a fixed dark ground) and
// the OpenFreeMap road tiles from its fixtures; the disk cache keeps the
// other tile hosts.
// The fixed fixture gives 1 093 vehicles and 35 congestion corridors with
// flow and 618 simulated vehicles without it; the bands allow 5%.
const BAND = process.argv.includes('--simulation')
  ? { vehicles: [587, 649], corridors: [0, 0] }
  : { vehicles: [1038, 1148], corridors: [33, 37] };
const strict = createStrict({
  origin: base.origin,
  layers: ['traffic'],
  fixtures: ['https://tiles.maps.eox.at/*', 'https://tiles.openfreemap.org/*'],
  tileHosts: STRICT_TILE_HOSTS.filter((host) => host !== 'tiles.maps.eox.at'),
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b, { shaderErrors: true });

  const keyless = process.argv.includes('--simulation');
  const reads = new Map();
  // A uniform dark Sentinel-2 tile: live imagery is bright and blurry at this
  // altitude, so white 2 px vehicles on it gave anything from 14 to 300
  // changed pixels. A fixed dark ground makes every drawn vehicle visible.
  const ground = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 28, g: 32, b: 30 },
    },
  })
    .jpeg()
    .toBuffer();
  await p.setRequestInterception(true);
  p.on('request', async (req) => {
    const u = new URL(req.url());
    if (u.hostname === 'tiles.maps.eox.at')
      return req.respond({
        status: 200,
        contentType: 'image/jpeg',
        headers: { 'access-control-allow-origin': '*' },
        body: ground,
      });
    if (
      u.hostname === 'tiles.openfreemap.org' ||
      u.pathname.startsWith('/api/tomtom/')
    ) {
      reads.set(u.href, (reads.get(u.href) || 0) + 1);
      if (keyless && u.pathname === '/api/tomtom/status')
        return req.respond({
          status: 200,
          contentType: 'application/json',
          body: '{"hasKey":false}',
        });
      const response = trafficFixtureResponse(req);
      if (response) return req.respond(response);
      throw Error('unrecognized traffic URL: ' + u.pathname);
    }
    return req.continue();
  });
  await p.goto(base.href);
  await waitForEngine(p, 'navara');
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;

    window.qaTraffic = dataManager.layers.get('traffic').module;
    window.qaTraffic.setParams({ jamViz: 'both' });
    await dataManager.setEnabled('traffic', true, { origin: 'user' });
  });
  const waitTraffic = async () => {
    try {
      // Vehicles, and with flow the congestion corridors, which the layer
      // publishes again once the next globe has attached.
      await p.waitForFunction(
        (keyless) => {
          const stats = window.qaTraffic.getStats();
          return stats.count >= 10 && (keyless || stats.heatLines > 0);
        },
        { timeout: 40000 },
        keyless,
      );
    } catch (e) {
      console.log(
        'no traffic',
        await p.evaluate(() => window.qaTraffic.getStats()),
      );
      throw e;
    }
  };
  await waitTraffic();
  // The view compared before and after the switches: a central window free of
  // panels and status toasts.
  const region = { left: 310, top: 160, right: 810, bottom: 660 };
  // Each vehicle in the window with its window position and its height above
  // the terrain Navara draws there. A vehicle below that terrain is hidden by
  // the depth test, so it cannot be expected in the picture.
  const vehiclesInView = () =>
    p.evaluate((r) => {
      const { engine } = window.__godsEyeView;
      const a = 6378137,
        f = 1 / 298.257223563,
        e2 = f * (2 - f);
      const rows = [];
      for (const o of window.qaTraffic.getDetectableObjects()) {
        const w = engine.projector.worldToWindow(o.position);
        if (!w || w.x < r.left || w.y < r.top || w.x >= r.right) continue;
        if (w.y >= r.bottom) continue;
        const { x, y, z } = o.position;
        const longitude = Math.atan2(y, x),
          ring = Math.hypot(x, y);
        let latitude = Math.atan2(z, ring * (1 - e2)),
          height = 0;
        for (let i = 0; i < 6; i++) {
          const n = a / Math.sqrt(1 - e2 * Math.sin(latitude) ** 2);
          height = ring / Math.cos(latitude) - n;
          latitude = Math.atan2(z, ring * (1 - (e2 * n) / (n + height)));
        }
        const ground = engine.surface.terrainHeight({
          longitude,
          latitude,
          height: 0,
        });
        rows.push({
          id: o.id,
          x: w.x,
          y: w.y,
          clearance: Number.isFinite(ground) ? height - ground : null,
        });
      }
      return rows;
    }, region);
  const settled = async () => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const loading = await p.evaluate(
        () => window.qaTraffic.getStats().loading,
      );
      const rows = await vehiclesInView();
      if (!loading && rows.length >= 12) return rows;
      if (Date.now() > deadline)
        throw Error(
          'traffic did not settle with 12 vehicles in view: ' +
            JSON.stringify({ loading, inView: rows.length }),
        );
      await whenSettled(p);
    }
  };
  // The population once roads, heights and dots have settled. Source counts
  // can be ready before the renderer has drawn terrain, so the camera and the
  // attached road heights are sampled after drawn frames on either engine.
  const settledPopulation = async () => {
    await whenSettled(p);
    await settled();
    return p.evaluate(() => window.qaTraffic.getStats().count);
  };
  const population = await settledPopulation();
  const buriedBefore = (await vehiclesInView()).filter(
    (v) => v.clearance != null && v.clearance <= -1,
  ).length;
  const ids = await p.evaluate(() =>
    window.qaTraffic.getDetectableObjects().map((p) => p.id),
  );
  const first = await p.evaluate(
    () => window.qaTraffic.getStats().motion.rebuilds,
  );
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.switchTo(p, kind);
    }
    await waitTraffic();
    const check = await p.evaluate(() => {
      const { dataManager } = window.__godsEyeView;
      const mod = dataManager.layers.get('traffic').module;
      return {
        same: mod === window.qaTraffic,
        ...mod.getStats(),
        params: mod.getParams(),
        ids: mod.getDetectableObjects().map((p) => p.id),
      };
    });
    console.log(
      kind,
      check.mode,
      check.count,
      check.flowBuckets,
      check.heatLines,
      check.motion,
    );
    assert.equal(check.same, true);
    assert.equal(check.params.jamViz, 'both');
    assert.equal(check.error, null);
    assert.equal(
      check.motion.rebuilds,
      first,
      'traffic population was cleared',
    );
    assert.ok(
      check.ids.some((id) => ids.includes(id)),
      'original moving vehicles survived',
    );
    if (!keyless)
      assert.ok(check.heatLines > 0, 'congestion corridors are published');
    if (keyless) assert.equal(check.flowBuckets.sim, check.count);
    else assert.ok(check.flowBuckets.slow + check.flowBuckets.jam > 0);
    await strict.check(
      p,
      'traffic',
      keyless
        ? `same module, parameters and vehicle ids; ${BAND.vehicles.join('-')} simulated vehicles, no flow`
        : `same module, parameters and vehicle ids; ${BAND.vehicles.join('-')} vehicles with flow, ${BAND.corridors.join('-')} congestion corridors`,
      check.count >= BAND.vehicles[0] &&
        check.count <= BAND.vehicles[1] &&
        check.heatLines >= BAND.corridors[0] &&
        check.heatLines <= BAND.corridors[1],
      { count: check.count, corridors: check.heatLines },
    );
  }
  if (keyless)
    assert.ok(![...reads.keys()].some((u) => u.includes('/tomtom/flow/')));

  // Compare the same view with the layer shown and hidden, vehicle by
  // vehicle.
  const raw = async () =>
    sharp(await p.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  const settledCount = await settledPopulation();
  const before = await vehiclesInView();
  const shown = await raw();
  const after = new Map((await vehiclesInView()).map((v) => [v.id, v]));
  // Read again once the comparison is taken: the population used to fall
  // seconds after the return, once the incoming globe republished the roads.
  const finalCount = await p.evaluate(() => window.qaTraffic.getStats().count);
  await p.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('traffic', false, {
      origin: 'user',
    }),
  );
  await whenSettled(p);
  const hidden = await raw();
  const { width, height } = shown.info;
  const scale = width / 1024;
  const changed = (x, y) => {
    const i = (y * width + x) * 3;
    let d = 0;
    for (let c = 0; c < 3; c++)
      d += Math.abs(shown.data[i + c] - hidden.data[i + c]);
    return d > 90;
  };
  const near = new Set();
  const visible = { drawn: 0, missing: [] };
  let buried = 0,
    unclear = 0;
  for (const v of before) {
    const later = after.get(v.id);
    if (!later) continue;
    // The screenshot falls between the two projections.
    const cx = (v.x + later.x) / 2,
      cy = (v.y + later.y) / 2;
    let hit = false;
    for (let dy = -8; dy <= 8; dy++)
      for (let dx = -8; dx <= 8; dx++) {
        const x = Math.round((cx + dx) * scale),
          y = Math.round((cy + dy) * scale);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        near.add(y * width + x);
        if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4 && changed(x, y)) hit = true;
      }
    if (v.clearance == null || Math.abs(v.clearance) < 1) unclear++;
    else if (v.clearance < 0) buried++;
    else if (hit) visible.drawn++;
    else visible.missing.push(v);
  }
  let stray = 0,
    area = 0;
  for (let y = Math.round(region.top * scale); y < region.bottom * scale; y++)
    for (
      let x = Math.round(region.left * scale);
      x < region.right * scale;
      x++
    ) {
      area++;
      if (!near.has(y * width + x) && changed(x, y)) stray++;
    }
  const aboveGround = visible.drawn + visible.missing.length;
  console.log(
    'vehicles in view',
    JSON.stringify({
      aboveGround,
      drawn: visible.drawn,
      belowTerrain: buried,
      withinOneMetre: unclear,
      strayChangedPixels: stray,
      area,
    }),
  );
  if (visible.missing.length)
    console.log('not drawn', JSON.stringify(visible.missing.slice(0, 10)));
  if (buried)
    console.log(
      'vehicles below the drawn terrain, hidden by the depth test:',
      buried,
    );
  // The checks after each switch run before the incoming globe republishes
  // the roads; these compare what the population settles to.
  console.log(
    'population before the switches',
    population,
    'settled after the round trip',
    settledCount,
    'after the comparison',
    finalCount,
    'below the drawn terrain before the switches',
    buriedBefore,
  );
  for (const count of [settledCount, finalCount])
    assert.ok(
      count >= 0.8 * population && count <= 1.25 * population,
      `the population after the round trip (${count}) stays within 80-125% of the ${population} before it`,
    );
  assert.ok(aboveGround >= 12, 'at least 12 vehicles above ground in view');
  await strict.check(
    p,
    'traffic',
    'after the round trip the population stays at 80-125% and at least 90% of the vehicles above ground in view are drawn where the layer places them',
    visible.drawn >= 0.9 * aboveGround &&
      [settledCount, finalCount].every(
        (count) => count >= 0.8 * population && count <= 1.25 * population,
      ),
    { population, settledCount, finalCount, aboveGround, drawn: visible.drawn },
  );
  assert.ok(
    visible.drawn >= 0.9 * aboveGround,
    'at least 90% of vehicles above the ground are drawn where the layer places them',
  );
  // Live mode adds congestion lines along roads; only the simulation must
  // change nothing but the vehicles.
  if (keyless)
    assert.ok(stray < 0.002 * area, 'hiding the layer changes only vehicles');
  assert.deepEqual(errors, []);
  console.log(
    'PASS kept the traffic module, parameters, flow and vehicle identities across both globes; vehicles in view are drawn where the layer places them',
  );
});
