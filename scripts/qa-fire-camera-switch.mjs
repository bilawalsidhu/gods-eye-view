import assert from 'node:assert/strict';
import { installAlprFixture, cameras } from './fixtures/w2/alpr.mjs';
import { firmsFixture, FIRMS_VALID_COUNT } from './fixtures/w2/firms.mjs';
import { createStrict, localPreview } from './qa-strict-harness.mjs';
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
await strict.run({ args: ['--use-angle=metal', '--enable-gpu'] }, async (b) => {
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
  await p.waitForFunction(
    () =>
      window.__godsEyeView?.engine?.kind === 'navara' &&
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
      .then((handle) => handle.jsonValue());
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
    const handle = await p.waitForFunction(
      () => {
        const { engine } = window.__godsEyeView;
        const canvas = engine.host.canvas;
        const box = canvas.getBoundingClientRect();
        for (let y = 240; y < 600; y += 9)
          for (let x = 440; x < 840; x += 9) {
            if (
              !canvas.contains(
                document.elementFromPoint(box.left + x, box.top + y),
              )
            )
              continue;
            let free = true;
            for (const [dx, dy] of [
              [0, 0],
              [6, 0],
              [-6, 0],
              [0, 6],
              [0, -6],
            ])
              if (engine.picker.pick({ x: x + dx, y: y + dy })) free = false;
            if (free) return { x: box.left + x, y: box.top + y };
          }
        return false;
      },
      { timeout: 15000 },
    );
    const at = await handle.jsonValue();
    await p.mouse.click(at.x, at.y);
    await p.waitForFunction(
      (fire) =>
        fire
          ? !window.qaGround.getSelectedInfo()
          : !window.__gevContextStore?.selectedEntityId,
      { timeout: 15000 },
      fire,
    );
  };
  const xy = await findTarget();
  await new Promise((r) => setTimeout(r, 1000));
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
  await new Promise((r) => setTimeout(r, 1600));
  const expectedId = fire
    ? await p.evaluate(() => window.qaGround.getSelectedInfo().id)
    : xy.id;
  const before = await p.evaluate(() => ({
    stamp: window.qaGround.getStats().lastUpdate,
    records: window.qaGround.getAnalystRecords(1000).map((v) => v.id),
    reads: window.qaFirmsReads,
  }));
  for (const kind of ['cesium', 'navara']) {
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
