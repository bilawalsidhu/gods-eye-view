import { whenSettled } from './qa/ready.mjs';
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
  'v=2&lat=55.3241&lon=10.7995&alt=25000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
const strict = createStrict({ origin: base.origin, layers: ['directions'] });
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
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
  await waitForEngine(p, 'navara');
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;

    window.qaRoute = dataManager.layers.get('directions').module;
    await dataManager.setEnabled('directions', true, { origin: 'user' });
  });
  for (const [letter, x] of [
    ['a', 480],
    ['b', 645],
  ]) {
    await p.evaluate((l) => window.qaRoute.setParams({ arm: l }), letter);
    await p.mouse.click(x, 440);
    await whenSettled(p);
  }
  assert.equal(routeReads, 1);
  await strict.passed(
    p,
    'directions',
    'A and B set by clicks on the globe; one route request',
  );
  await strict.switchTo(p, 'cesium');
  release();
  await p.waitForFunction(() => window.qaRoute.getStats().count === 3);
  await p.waitForFunction(() => {
    window.qaRoute.setParams({ step: 1 });
    return window.qaRoute.getRowControls().list.items[1]?.active;
  });
  await strict.passed(
    p,
    'directions',
    'the route asked for on Navara arrives on Cesium; a step is selectable',
  );
  const transfer = async (kind) => {
    const flying = await p.evaluate(() =>
      Boolean(window.qaRoute.getFlightProgress()),
    );
    if (flying) {
      // A running dolly owns the camera; verify its handoff before asking for rest.
      await strict.pick(p, kind, { settle: false });
      await p.waitForFunction(
        (kind) =>
          window.__godsEyeView?.engine?.kind === kind &&
          !document.querySelector('#globe-engine[aria-busy="true"]') &&
          window.qaRoute.getFlightProgress()?.traveledM > 0,
        {},
        kind,
      );
    } else await strict.switchTo(p, kind);
    assert.equal(
      await p.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers.get('directions').module ===
          window.qaRoute,
      ),
      true,
    );
    assert.equal(routeReads, 1);
    await strict.passed(
      p,
      'directions',
      'same model; the switch requests no route',
    );
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
  await p.waitForFunction(() => window.qaRoute.getFlightProgress()?.traveledM > 0);
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
    await p.waitForFunction(
      ({ at, traveledM }) => {
        const next = window.__godsEyeView.engine.camera.pose().position;
        return (
          window.qaRoute.getFlightProgress()?.traveledM > traveledM &&
          Math.hypot(next.x - at.x, next.y - at.y, next.z - at.z) > 1
        );
      },
      {},
      { at, traveledM: progress.traveledM },
    );
    const next = await pos();
    const resumed = await p.evaluate(() => window.qaRoute.getFlightProgress());
    assert.equal(resumed.motionId, progress.motionId);
    assert.ok(resumed.traveledM > progress.traveledM);
    progress = resumed;
    console.log(kind, 'moved', d(at, next), 'handoff', d(at, before));
    assert.ok(d(at, next) > 1, 'dolly advances after switch to ' + kind);
    await strict.passed(
      p,
      'directions',
      'FLY continues with the same motion and advances',
      { moved: d(at, next) },
    );
  }
  await p.evaluate(() => window.qaRoute.setParams({ clear: true }));
  assert.equal(await p.evaluate(() => window.qaRoute.getStats().count), 0);
  // CLEAR releases the camera: the route's motion ends, the camera stays
  // where it is, and a wheel zoom by the person moves it and is kept.
  await waitForEngine(p, 'navara');
  const released = await p.evaluate(() => ({
    motion: window.qaRoute.getFlightProgress(),
    fly: window.qaRoute.getRowControls().chips.find((c) => c.id === 'fly')
      ?.active,
  }));
  const still = await pos();
  await whenSettled(p);
  const later = await pos();
  const height = () =>
    p.evaluate(() => window.__godsEyeView.engine.camera.height());
  const beforeZoom = await height();
  await p.mouse.move(512, 300);
  for (let i = 0; i < 4; i++) {
    await p.mouse.wheel({ deltaY: -240 });
    await whenSettled(p);
  }
  await whenSettled(p);
  const zoomed = await height();
  await whenSettled(p);
  const kept = await height();
  await strict.check(
    p,
    'directions',
    'CLEAR removes the route and releases the camera: no route motion, the camera stays put, a wheel zoom moves it and is kept',
    released.motion === null &&
      !released.fly &&
      d(still, later) < 1 &&
      zoomed < beforeZoom * 0.95 &&
      Math.abs(kept - zoomed) < 0.02 * zoomed,
    { released, drift: d(still, later), beforeZoom, zoomed, kept },
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS route delivery during handoff, A/B clicks, step selection, ongoing FLY, clear and single route request',
  );
});
