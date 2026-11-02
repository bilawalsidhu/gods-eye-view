import { fromDegrees } from '../src/geo/cartesian3.js';
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
  'v=2&lat=41.5340&lon=-90.5070&alt=20000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
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
  const reads = { datacenters: 0, dams: 0 };
  p.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    for (const name of Object.keys(reads))
      if (path.includes(name) && path.endsWith('.geojsonl')) reads[name]++;
  });
  await p.evaluateOnNewDocument(() => {
    window.qaSelections = [];
    window.addEventListener('gev:entity-selected', ({ detail }) => {
      if (detail?.layerId?.startsWith('local-'))
        window.qaSelections.push(detail.id);
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
  const ids = ['local-datacenters', 'local-dams'];
  const dataset = await p.evaluate(async (ids) => {
    const { dataManager, tileset } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Keyless preview required');
    window.qaSites = [];
    const records = [];
    for (const id of ids) {
      if (!(await dataManager.setEnabled(id, true, { origin: 'user' })))
        throw Error(id + ' did not enable');
      const mod = dataManager.layers.get(id).module;
      window.qaSites.push(mod);
      const all = mod.getAnalystRecords(Infinity);
      records.push({
        count: mod.getStats().count,
        total: all.length,
        name: all[0]?.name,
      });
    }
    return records;
  }, ids);
  assert.ok(
    dataset[0].count >= 4351 && dataset[1].count >= 704,
    JSON.stringify(dataset),
  );
  const record = await p.evaluate(() =>
    window.qaSites[0]
      .getAnalystRecords(5000)
      .find((r) => r.name === 'Geneseo Communications Inc'),
  );
  assert.ok(record);
  const clickSite = async () => {
    const screen = await p.evaluate(
      (world) => {
        const { engine } = window.__godsEyeView;
        const at = engine.projector.worldToWindow(world, {});
        const box = engine.host.canvas.getBoundingClientRect();
        return { x: box.left + at.x, y: box.top + at.y };
      },
      fromDegrees(record.lon, record.lat),
    );
    await p.mouse.click(screen.x, screen.y);
    await p.waitForFunction(
      () => window.qaSelections.at(-1) === 'local-datacenters:342664739',
      { timeout: 15000 },
    );
  };
  const counts = { ...reads };
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.evaluate(() => {
        window.qaSelections = [];
      });
      await p.select('#globe-engine', kind);
      await ready(kind);
      await p.waitForFunction(
        () => window.qaSelections.includes('local-datacenters:342664739'),
        { timeout: 15000 },
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
    const result = await p.evaluate(
      (ids) =>
        ids.map((id, i) => {
          const mod = window.__godsEyeView.dataManager.layers.get(id).module;
          return {
            same: mod === window.qaSites[i],
            lod: mod.getLodDiagnostics(),
            count: mod.getStats().count,
            error: mod.getStats().error,
            name: mod.getAnalystRecords(1)[0].name,
          };
        }),
      ids,
    );
    console.log(kind, JSON.stringify(result));
    for (const [i, layer] of result.entries()) {
      assert.ok(
        layer.same &&
          !layer.error &&
          layer.lod.active > 0 &&
          layer.lod.active <= layer.lod.budgetLimit,
      );
      assert.equal(layer.count, dataset[i].count);
      assert.equal(layer.name, dataset[i].name);
    }
    if (
      kind === 'navara' &&
      !(await p.evaluate(() => window.qaSelections.length))
    )
      await clickSite();
    assert.deepEqual(
      reads,
      counts,
      'Do not reload bundled data on scene handoff',
    );
  }
  assert.equal(counts.datacenters, 1);
  assert.equal(counts.dams, 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS complete bundled datasets, bounded stems, retained selection and one read per file',
  );
} finally {
  await b.close();
}
