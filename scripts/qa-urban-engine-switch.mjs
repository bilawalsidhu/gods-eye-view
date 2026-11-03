import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { switchGlobe } from './qa-switch-globe.mjs';
import { installTransitFixture } from './fixtures/w2/transit.mjs';
import { installCombinedFixture } from './fixtures/w2/combined.mjs';
const url = new URL(process.argv[2]),
  bus = process.argv.includes('--transit'),
  id = bus ? 'transit' : 'bikeshare';
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    url.port,
  )
)
  throw Error('Supply local keyless preview URL');
url.search = '?engine=navara&welcome=0';
url.hash =
  'v=2&lat=42.3554&lon=-71.0605&alt=2700&pitch=-90&heading=0&map=sentinel2&l=';
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const p = await b.newPage();
  await blockPaidQaMaps(p);
  await p.setViewport({ width: 1280, height: 900 });
  const errors = [];
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message);
  });
  const fx = bus
    ? await installTransitFixture(p)
    : await installCombinedFixture(p);
  fx.setStep?.(9);
  await p.goto(url.href);
  await p.waitForFunction(
    () =>
      window.__godsEyeView?.engine?.kind === 'navara' &&
      document.querySelector('#loading-screen.hidden'),
  );
  await p.evaluate(async (id) => {
    const { dataManager, styleManager, tileset } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Expected keyless preview');
    await styleManager.initialRestorePromise;
    window.qaUrban = dataManager.layers.get(id).module;
    await dataManager.setEnabled(id, true, { origin: 'user' });
  }, id);
  await p.waitForFunction(() => window.qaUrban.getStats().count > 0, {
    timeout: 30000,
  });
  const handle = await p.waitForFunction(
    () => {
      const a = window.__godsEyeView;
      for (const r of window.qaUrban.getDetectableObjects({
        maxCount: 500,
        seed: 0,
      })) {
        const s = a.engine.projector.worldToWindow(r.position);
        if (!s || s.x < 420 || s.x > 860 || s.y < 205 || s.y > 670) continue;
        const pk = a.engine.picker.pick(s);
        if (pk?.id === r.sourceId || pk?.id?.id === r.sourceId)
          return { x: s.x, y: s.y, id: r.sourceId };
      }
      return false;
    },
    { timeout: 30000 },
  );
  const target = await handle.jsonValue();
  await p.mouse.click(target.x, target.y);
  await p.waitForFunction(
    (key) =>
      window.qaUrban
        .getDetectableObjects({ maxCount: 500, seed: 0 })
        .some((r) => r.sourceId === key && r.skipLabel),
    {},
    target.id,
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
  const original = reads();
  const first = await p.evaluate(() =>
    window.qaUrban.getAnalystRecords(500).map((v) => v.id),
  );
  for (const kind of ['cesium', 'navara']) {
    await switchGlobe(p, kind);
    await p.waitForFunction(
      (key) =>
        window.qaUrban
          .getDetectableObjects({ maxCount: 500, seed: 0 })
          .some((r) => r.sourceId === key && r.skipLabel),
      { timeout: 20000 },
      target.id,
    );
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
  }
  assert.deepEqual(errors, []);
  await fx.dispose?.();
  console.log(
    'PASS viewport activation, real pick and original city data across two switches',
  );
} finally {
  await b.close();
}
