import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { installAlprFixture } from './fixtures/w2/alpr.mjs';
import { firmsFixture } from './fixtures/w2/firms.mjs';
import { switchGlobe } from './qa-switch-globe.mjs';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
const url = new URL(process.argv[2]),
  fire = process.argv.includes('--fires'),
  id = fire ? 'local-firms' : 'alpr-cameras';
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    url.port,
  )
)
  throw Error('Supply local keyless preview URL');
url.search = '?engine=navara&welcome=0';
url.hash =
  'v=2&' +
  (fire
    ? 'lat=37.77&lon=-122.42&alt=100000'
    : 'lat=30.262&lon=-97.7431&alt=5500') +
  '&pitch=-90&heading=0&map=sentinel2&l=';
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const p = await b.newPage();
  await blockPaidQaMaps(p);
  await p.setViewport({ width: 1280, height: 900 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await installAlprFixture(p);
  await p.evaluateOnNewDocument((data) => {
    window.qaFirmsReads = 0;
    const fetch = window.fetch.bind(window);
    window.fetch = (input, opt) => {
      if (
        new URL(input.url ?? input, location.href).pathname === '/api/firms'
      ) {
        window.qaFirmsReads++;
        return Promise.resolve(Response.json(data));
      }
      return fetch(input, opt);
    };
  }, firmsFixture());
  await p.goto(url.href);
  await p.waitForFunction(
    () =>
      window.__godsEyeView?.engine.kind === 'navara' &&
      document.querySelector('#loading-screen.hidden'),
  );
  await p.evaluate(async (id) => {
    const { dataManager, styleManager, tileset } = window.__godsEyeView;
    if (window.__GOOGLE_MAPS_API_KEY__ || tileset)
      throw Error('Keyless preview required');
    await styleManager.initialRestorePromise;
    window.qaGround = dataManager.layers.get(id).module;
    await dataManager.setEnabled(id, true, { origin: 'user' });
  }, id);
  await p.waitForFunction(() => window.qaGround?.getStats().count > 0, {
    timeout: 30000,
  });
  const target = await p.waitForFunction(
    (fire) => {
      const a = window.__godsEyeView,
        m = window.qaGround;
      const points = fire
        ? m
            .getDetectableObjects({ maxCount: 1000 })
            .filter((v) => v.id === m.getAnalystRecords(1)[0]?.id)
        : [...window.__gevContextStore.entities.values()]
            .filter((v) => v.layerId === 'alpr-cameras')
            .map((v) => ({
              id: v.id,
              position:
                v.entity.gevAlprCanvasPosition ||
                v.entity.gevDisplayPosition?.(),
            }));
      for (const row of points) {
        if (!row.position) continue;
        const s = a.engine.projector.worldToWindow(row.position);
        if (!s || s.x < 430 || s.x > 850 || s.y < 220 || s.y > 730) continue;
        const picked = a.engine.picker.pick(s);
        if (fire || picked?.id === row.id || picked?.id?.id === row.id)
          return { x: s.x, y: s.y, id: row.id };
      }
      return false;
    },
    { timeout: 30000 },
    fire,
  );
  const xy = await target.jsonValue();
  await new Promise(r=>setTimeout(r,1000));
  await p.mouse.click(xy.x, xy.y);
  await p.waitForFunction(
    (id,fire) => fire ? window.qaGround.getSelectedInfo()?.frp === 999 : window.__gevContextStore?.selectedEntityId === id,
    {},
    xy.id, fire,
  );
  await new Promise((r) => setTimeout(r, 1600));
  const expectedId = fire ? await p.evaluate(()=>window.qaGround.getSelectedInfo().id) : xy.id;
  const before = await p.evaluate(() => ({
    stamp: window.qaGround.getStats().lastUpdate,
    records: window.qaGround.getAnalystRecords(1000).map((v) => v.id),
    reads: window.qaFirmsReads,
  }));
  for (const kind of ['cesium', 'navara']) {
    await switchGlobe(p, kind);
    const result = await p.evaluate(
      (id) => ({
        same:
          window.qaGround ===
          window.__godsEyeView.dataManager.layers.get(id).module,
        selected: window.__gevContextStore.selectedEntityId,
        record: window.qaGround.getSelectedInfo?.()?.id,
        stamp: window.qaGround.getStats().lastUpdate,
        records: window.qaGround.getAnalystRecords(1000).map((v) => v.id),
        reads: window.qaFirmsReads,
        count: window.qaGround.getStats().count,
      }),
      id,
    );
    console.log(kind, id, result.selected, result.count, result.records.length);
    assert.ok(result.same && result.count);
    assert.equal(result.selected, expectedId);
    if (fire) assert.equal(result.record, expectedId);
    assert.equal(result.reads, before.reads);
    assert.deepEqual(result.records, before.records);
    assert.equal(result.stamp, before.stamp);
  }
  assert.deepEqual(errors, []);
  console.log('PASS retained source, stable clicked record on each planet');
} finally {
  await b.close();
}
