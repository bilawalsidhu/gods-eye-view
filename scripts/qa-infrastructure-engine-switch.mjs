import { whenPickable, whenSettled } from './qa/ready.mjs';
import { fromDegrees } from '../src/geo/cartesian3.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=41.5340&lon=-90.5070&alt=20000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
// Every geometry of the bundled files (a Multi* feature counts each part),
// read from the files this checkout builds.
const geometries = (name) =>
  readFileSync(
    new URL(`../src/data/local_data/${name}/${name}.geojsonl`, import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.trim())
    .reduce((sum, line) => {
      const { type, coordinates } = JSON.parse(line).geometry;
      return sum + (type.startsWith('Multi') ? coordinates.length : 1);
    }, 0);
const DATACENTERS = geometries('datacenters');
const DAMS = geometries('dams');
const strict = createStrict({
  origin: base.origin,
  layers: ['local-dams', 'local-datacenters'],
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
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
    window.qaCleared = 0;
    window.addEventListener('gev:entity-selection-cleared', () => {
      window.qaCleared++;
    });
  });
  await p.goto(base.href);
  await waitForEngine(p, 'navara');
  const ids = ['local-datacenters', 'local-dams'];
  const dataset = await p.evaluate(async (ids) => {
    const { dataManager } = window.__godsEyeView;

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
  // The bundled files are fixed: every record is loaded.
  assert.deepEqual(
    dataset.map((d) => d.count),
    [DATACENTERS, DAMS],
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
    await whenPickable(
      p,
      screen,
      (picked) => picked?.id === 'local-datacenters:342664739',
    );
    await p.mouse.click(screen.x, screen.y);
    await p.waitForFunction(
      () => window.qaSelections.at(-1) === 'local-datacenters:342664739',
      { timeout: 15000 },
    );
  };
  // A dam in view, clicked where its record is.
  const dam = await p.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('local-dams')
      .module.getAnalystRecords(5000)
      .find((r) => r.name === 'Arsenal Power Dam'),
  );
  assert.ok(dam);
  const clickDam = async () => {
    const screen = await p.evaluate(
      (world) => {
        const { engine } = window.__godsEyeView;
        const at = engine.projector.worldToWindow(world, {});
        const box = engine.host.canvas.getBoundingClientRect();
        window.qaSelections = [];
        return { x: box.left + at.x, y: box.top + at.y };
      },
      fromDegrees(dam.lon, dam.lat),
    );
    await whenPickable(
      p,
      screen,
      (picked) => picked?.id === 'local-dams:-12841971',
    );
    await p.mouse.click(screen.x, screen.y);
    await p
      .waitForFunction(
        () => window.qaSelections.at(-1) === 'local-dams:-12841971',
        { timeout: 15000 },
      )
      .catch(async (error) => {
        console.log(
          'dam click',
          JSON.stringify(screen),
          JSON.stringify(
            await p.evaluate(({ x, y }) => {
              const { engine } = window.__godsEyeView;
              const box = engine.host.canvas.getBoundingClientRect();
              const id = engine.picker.pick({
                x: x - box.left,
                y: y - box.top,
              })?.id;
              return {
                selections: window.qaSelections,
                cleared: window.qaCleared,
                pick: String(id?.id ?? id),
                hit: document.elementFromPoint(x, y)?.tagName,
              };
            }, screen),
          ),
        );
        throw error;
      });
  };
  const start = fromDegrees(-90.507, 41.534, 20000);
  const home = async () => {
    await p.evaluate((destination) => {
      const { camera, render } = window.__godsEyeView.engine;
      camera.cancelFlight();
      camera.setView({
        destination,
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      render.request('qa-home');
    }, start);
    await whenSettled(p);
  };
  const counts = { ...reads };
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.evaluate(() => {
        window.qaSelections = [];
      });
      await strict.switchTo(p, kind);
      await p.waitForFunction(
        () => window.qaSelections.includes('local-datacenters:342664739'),
        { timeout: 15000 },
      );
    }
    await whenSettled(p);
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
    assert.deepEqual(
      reads,
      counts,
      'Do not reload bundled data on scene handoff',
    );
    await strict.passed(
      p,
      ids,
      'same model, every bundled record, bounded LOD stems, no file read again',
      result.map((r) => r.count),
    );
    if (
      kind !== 'navara' ||
      (await p.evaluate(() => window.qaSelections.length))
    )
      await strict.passed(
        p,
        'local-datacenters',
        'the clicked datacenter stays selected across the switch',
      );
    // Click-picking on this engine: a dam, then the datacenter again, each
    // from the starting view (a selection flies the camera to it).
    await home();
    await clickDam();
    await strict.passed(p, 'local-dams', 'a click on a dam selects it');
    await home();
    await clickSite();
    await strict.passed(
      p,
      'local-datacenters',
      'a click on the datacenter selects it',
    );
  }
  assert.equal(counts.datacenters, 1);
  assert.equal(counts.dams, 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS complete bundled datasets, bounded stems, retained selection and one read per file',
  );
});
