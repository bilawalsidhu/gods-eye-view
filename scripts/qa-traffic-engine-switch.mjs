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
  await p.setRequestInterception(true);
  p.on('request', async (req) => {
    const u = new URL(req.url());
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
  const pixels = async () =>
    sharp(await p.screenshot())
      .extract({ left: 360, top: 255, width: 330, height: 260 })
      .removeAlpha()
      .raw()
      .toBuffer();
  // Source counts can be ready before the incoming renderer has drawn terrain.
  // Let the camera and the newly attached road heights settle before comparison.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const shown = await pixels();
  await p.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('traffic', false, {
      origin: 'user',
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  const hidden = await pixels();
  let visible = 0;
  for (let i = 0; i < shown.length; i += 3) {
    if (
      shown[i] +
        shown[i + 1] +
        shown[i + 2] -
        (hidden[i] + hidden[i + 1] + hidden[i + 2]) >
      110
    )
      visible++;
  }
  console.log('changed traffic pixels', visible);
  assert.ok(visible > 15, 'changing the layer changes the rendered streets');
  assert.deepEqual(errors, []);
  console.log(
    'PASS retained traffic population and flow, real geography and stable identities across both globes',
  );
} finally {
  await b.close();
}
