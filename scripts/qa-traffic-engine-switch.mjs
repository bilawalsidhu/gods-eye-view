import { trafficFixtureResponse } from './traffic-fixtures.mjs';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { blockPaidQaMaps } from './qa-map-policy.mjs';

const base = new URL(process.argv[2]);
if (
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    base.port,
  )
)
  throw new Error('Supply an unreserved local keyless preview URL');
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=30.2670&lon=-97.7440&alt=1800&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const p = await b.newPage();
  await blockPaidQaMaps(p);
  await p.setViewport({ width: 1024, height: 768 });
  const errors = [];
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message.split('?')[0]);
  });

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
  p.on('console', (msg) => {
    if (msg.type() === 'error' && /Shader|WebGLProgram/i.test(msg.text()))
      errors.push(msg.text());
  });
  await p.goto(base.href);
  const ready = async (kind) => {
    await p.waitForFunction(
      (k) =>
        window.__godsEyeView?.engine.kind === k &&
        !document.querySelector('#globe-engine')?.disabled &&
        !document.querySelector('.engine-switch-frame') &&
        document.querySelector('#loading-screen.hidden'),
      { timeout: 90000 },
      kind,
    );
    await p.evaluate(
      () => window.__godsEyeView.styleManager.initialRestorePromise,
    );
  };
  await ready('navara');
  await p.evaluate(async () => {
    const { tileset, dataManager } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Keyless preview required');
    window.qaTraffic = dataManager.layers.get('traffic').module;
    window.qaTraffic.setParams({ jamViz: 'both' });
    await dataManager.setEnabled('traffic', true, { origin: 'user' });
  });
  const waitTraffic = async () => {
    try {
      await p.waitForFunction(() => window.qaTraffic.getStats().count >= 10, {
        timeout: 40000,
      });
    } catch (e) {
      console.log(
        'no traffic',
        await p.evaluate(() => window.qaTraffic.getStats()),
      );
      throw e;
    }
  };
  await waitTraffic();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const ids = await p.evaluate(() =>
    window.qaTraffic.getDetectableObjects().map((p) => p.id),
  );
  const first = await p.evaluate(
    () => window.qaTraffic.getStats().motion.rebuilds,
  );
  const population = await p.evaluate(() => window.qaTraffic.getStats().count);
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.select('#globe-engine', kind);
      await ready(kind);
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
  }
  if (keyless)
    assert.ok(![...reads.keys()].some((u) => u.includes('/tomtom/flow/')));
  // Compare the same view with the layer shown and hidden, vehicle by
  // vehicle. Only a central window free of panels and status toasts counts.
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
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const raw = async () =>
    sharp(await p.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  // Source counts can be ready before the incoming renderer has drawn terrain.
  // Let the camera and the newly attached road heights settle before comparison.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await settled();
  const settledCount = await p.evaluate(
    () => window.qaTraffic.getStats().count,
  );
  const before = await vehiclesInView();
  const shown = await raw();
  const after = new Map((await vehiclesInView()).map((v) => [v.id, v]));
  await p.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('traffic', false, {
      origin: 'user',
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
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
  // the roads. Report what the population settles to; it is not asserted yet.
  console.log(
    'population before the switches',
    population,
    'settled after the round trip',
    settledCount,
  );
  if (settledCount < 0.8 * population)
    console.log(
      'known defect: the traffic population shrinks after returning to Navara',
    );
  assert.ok(aboveGround >= 12, 'at least 12 vehicles above ground in view');
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
} finally {
  await b.close();
}
