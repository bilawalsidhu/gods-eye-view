import { waitForEngine } from './qa-strict-harness.mjs';
import { whenPickable, whenSettled } from './qa/ready.mjs';
import { assertKeylessPreview } from './qa-strict-harness.mjs';
import assert from 'node:assert/strict';
import { installAlprFixture, cameras } from './fixtures/layers/alpr.mjs';
import { firmsFixture, FIRMS_VALID_COUNT } from './fixtures/layers/firms.mjs';
import {
  clickEmptyGround,
  createStrict,
  localPreview,
  waitForCameraAtRest,
} from './qa-strict-harness.mjs';
const url = localPreview(process.argv[2]),
  fire = process.argv.includes('--fires'),
  id = fire ? 'local-firms' : 'alpr-cameras';
url.search = '?engine=navara&welcome=0';
url.hash =
  'v=2&' +
  (fire
    ? 'lat=37.77&lon=-122.42&alt=100000'
    : 'lat=30.262&lon=-97.7431&alt=5500') +
  '&pitch=-90&heading=0&map=sentinel2&l=';
// Records the fixtures produce: the valid FIRMS rows; the ALPR cameras the
// fixture tiles carry around Austin.
const COUNT = fire ? FIRMS_VALID_COUNT : cameras.length;
const strict = createStrict({
  origin: url.origin,
  layers: [id],
  // installAlprFixture answers the camera tiles.
  fixtures: ['https://tiles.dontgetflocked.com/*'],
});
await strict.run({}, async (b) => {
  const p = await b.newPage();
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
  await waitForEngine(p, 'navara');
  await assertKeylessPreview(p);
  await p.evaluate(async (id) => {
    const { dataManager, styleManager } = window.__godsEyeView;

    await styleManager.initialRestorePromise;
    window.qaGround = dataManager.layers.get(id).module;
    await dataManager.setEnabled(id, true, { origin: 'user' });
  }, id);
  await p.waitForFunction(() => window.qaGround?.getStats().count > 0, {
    timeout: 30000,
  });
  // A pickable target in the middle of the view: the camera the engine's
  // own picker returns, or the hottest fire.
  const findTarget = () =>
    p
      .waitForFunction(
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
            if (!s || s.x < 430 || s.x > 850 || s.y < 220 || s.y > 600)
              continue;
            const canvas = a.engine.host.canvas;
            const box = canvas.getBoundingClientRect();
            if (
              !canvas.contains(
                document.elementFromPoint(box.left + s.x, box.top + s.y),
              )
            )
              continue;
            const picked = a.engine.picker.pick(s);
            if (fire || picked?.id === row.id || picked?.id?.id === row.id)
              return { x: box.left + s.x, y: box.top + s.y, id: row.id };
          }
          return false;
        },
        { timeout: 30000 },
        fire,
      )
      .then((handle) => handle.jsonValue())
      .then((xy) =>
        whenPickable(p, xy, (picked, position) => {
          const id = position.id.startsWith('FIRE-')
            ? `firms-${Number(position.id.slice(5))}`
            : position.id;
          return (picked?.id?.id ?? picked?.id) === id;
        }),
      );
  const selected = (id) =>
    p.waitForFunction(
      (id, fire) =>
        fire
          ? window.qaGround.getSelectedInfo()?.frp === 999
          : window.__gevContextStore?.selectedEntityId === id,
      { timeout: 15000 },
      id,
      fire,
    );
  // A click on empty ground (nothing picked there, nothing covering it).
  const clickEmpty = async () => {
    await clickEmptyGround(p, {
      left: 440,
      top: 240,
      right: 840,
      bottom: 600,
      step: 9,
      radius: 6,
    });
    await p.waitForFunction(
      (fire) =>
        fire
          ? !window.qaGround.getSelectedInfo()
          : !window.__gevContextStore?.selectedEntityId,
      { timeout: 15000 },
      fire,
    );
  };
  await whenSettled(p);
  const xy = await findTarget();
  await p.mouse.click(xy.x, xy.y);
  await selected(xy.id);
  await strict.passed(
    p,
    id,
    fire
      ? 'a click on the hottest fire selects it'
      : 'a click on a camera selects it',
    xy,
  );
  // The selection flies the camera to the record (1.9 s, longer on a busy
  // machine); a switch before it lands opens the other engine on a view
  // between the two, where the record can be off screen.
  await waitForCameraAtRest(p);
  const expectedId = fire
    ? await p.evaluate(() => window.qaGround.getSelectedInfo().id)
    : xy.id;
  const before = await p.evaluate(() => ({
    stamp: window.qaGround.getStats().lastUpdate,
    records: window.qaGround.getAnalystRecords(1000).map((v) => v.id),
    reads: window.qaFirmsReads,
  }));
  for (const kind of ['cesium', 'navara']) {
    await whenSettled(p);
    await strict.switchTo(p, kind);
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
    await strict.check(
      p,
      id,
      `same model, ${COUNT} records, the clicked record still selected, no source read, same receipt time`,
      result.count === COUNT,
      { count: result.count },
    );
    if (kind === 'cesium') {
      // Click-picking on Cesium: clear the selection with a click on empty
      // ground, then click the same record again.
      await clickEmpty();
      const again = await findTarget();
      assert.equal(again.id, xy.id);
      await p.mouse.click(again.x, again.y);
      await selected(again.id);
      await strict.passed(
        p,
        id,
        fire
          ? 'a click on empty ground clears the fire; a click on it selects it again'
          : 'a click on empty ground clears the camera; a click on it selects it again',
        again,
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS retained source, stable clicked record on each planet');
});
