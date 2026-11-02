import puppeteer from 'puppeteer';
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
  'v=2&lat=55.3241&lon=10.7995&alt=25000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
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
  let routeReads = 0,
    release;
  await p.setRequestInterception(true);
  p.on('request', async (req) => {
    const u = new URL(req.url());
    const json = (v) =>
      req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(v),
      });
    if (u.pathname === '/api/terrain/heights') {
      const cells = (u.searchParams.get('points') ?? '').split(';');
      return json({ results: cells.map(() => ({ ellipsoid: 34 })) });
    }
    if (u.pathname !== '/api/route') return req.continue();
    routeReads++;
    const [a, b] = u.searchParams
      .get('coords')
      .split(';')
      .map((p) => p.split(',').map(Number));
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (routeReads === 1)
      await new Promise((resolve) => {
        release = resolve;
      });
    return json({
      ok: true,
      geometry: [a, mid, b],
      distanceM: 9000,
      durationS: 800,
      steps: [a, mid, b].map(([lon, lat], i) => ({
        lon,
        lat,
        instruction: 'Route step ' + i,
        distanceM: 3000,
        durationS: 120,
      })),
    });
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
    window.qaRoute = dataManager.layers.get('directions').module;
    await dataManager.setEnabled('directions', true, { origin: 'user' });
  });
  for (const [letter, x] of [
    ['a', 480],
    ['b', 645],
  ]) {
    await p.evaluate((l) => window.qaRoute.setParams({ arm: l }), letter);
    await p.mouse.click(x, 440);
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  assert.equal(routeReads, 1);
  await p.select('#globe-engine', 'cesium');
  await ready('cesium');
  release();
  await p.waitForFunction(() => window.qaRoute.getStats().count === 3);
  await p.waitForFunction(() => {
    window.qaRoute.setParams({ step: 1 });
    return window.qaRoute.getRowControls().list.items[1]?.active;
  });
  const transfer = async (kind) => {
    await p.select('#globe-engine', kind);
    await ready(kind);
    assert.equal(
      await p.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers.get('directions').module ===
          window.qaRoute,
      ),
      true,
    );
    assert.equal(routeReads, 1);
  };
  await transfer('navara');
  assert.equal(
    await p.evaluate(
      () => window.qaRoute.getRowControls().list.items[1].active,
    ),
    true,
  );
  await p.evaluate(() => window.qaRoute.setParams({ fly: true }));
  await p.waitForFunction(
    () =>
      window.qaRoute.getRowControls().chips.find((c) => c.id === 'fly')?.active,
  );
  const pos = () =>
    p.evaluate(() => window.__godsEyeView.engine.camera.pose().position);
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  let progress = await p.evaluate(() => window.qaRoute.getFlightProgress());
  for (const kind of ['cesium', 'navara']) {
    const before = await pos();
    await transfer(kind);
    await p.waitForFunction(
      () =>
        window.qaRoute.getRowControls().chips.find((c) => c.id === 'fly')
          ?.active,
    );
    const at = await pos();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const next = await pos();
    const resumed = await p.evaluate(() => window.qaRoute.getFlightProgress());
    assert.equal(resumed.motionId, progress.motionId);
    assert.ok(resumed.traveledM > progress.traveledM);
    progress = resumed;
    console.log(kind, 'moved', d(at, next), 'handoff', d(at, before));
    assert.ok(d(at, next) > 1, 'dolly advances after switch to ' + kind);
  }
  await p.evaluate(() => window.qaRoute.setParams({ clear: true }));
  assert.equal(await p.evaluate(() => window.qaRoute.getStats().count), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS route delivery during handoff, A/B clicks, step selection, ongoing FLY, clear and single route request',
  );
} finally {
  await b.close();
}
