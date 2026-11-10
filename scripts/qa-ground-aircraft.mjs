import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { hookRenderErrors, readRenderErrors } from './qa-browserEvidence.mjs';
const url = process.argv[2] || 'http://127.0.0.1:4182';
const out = process.argv[3] || 'qa-artifacts/ground-aircraft';
await fs.mkdir(out, { recursive: true });
const report = { checks: [], errors: [] };
const check = (name, pass) => {
  report.checks.push({ name, pass: !!pass });
  assert.ok(pass, name);
};
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 });
  await hookRenderErrors(page);
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    window.__groundFixture = true;
    const real = window.fetch.bind(window),
      json = (value) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
    window.fetch = (input, init) => {
      const u = new URL(
          typeof input === 'string' ? input : input.url,
          location.href,
        ),
        t = Math.floor(Date.now() / 1000);
      if (u.pathname === '/api/flights')
        return json({
          time: t,
          states: [
            [
              'c00000',
              'GROUND0',
              'Fixture',
              t,
              t,
              -98.2,
              38,
              0,
              window.__groundFixture,
              0,
              90,
              0,
              null,
              0,
              null,
              false,
              0,
            ],
            [
              'c00001',
              'AIR1',
              'Fixture',
              t,
              t,
              -97.8,
              38,
              10000,
              false,
              0,
              0,
              0,
              null,
              10000,
              null,
              false,
              0,
            ],
          ],
        });
      if (u.pathname === '/api/military')
        return json({
          ac: [
            {
              hex: 'bbb101',
              flight: 'MILGROUND',
              lon: -98.2,
              lat: 38.3,
              alt_baro: 'ground',
              gs: 0,
              track: 90,
              t: 'C130',
              seen_pos: 0,
            },
            {
              hex: 'bbb102',
              flight: 'MILAIR',
              lon: -97.8,
              lat: 38.3,
              alt_baro: 20000,
              gs: 0,
              track: 0,
              t: 'C130',
              seen_pos: 0,
            },
          ],
          now: t * 1000,
        });
      if (/^\/api\/adsbdb\//.test(u.pathname)) return json({});
      return real(input, init);
    };
  });
  await page.goto(
    `${url}/?welcome=0#v=2&lat=38&lon=-98&alt=500000&heading=0&pitch=-90&roll=0&style=normal&bloom=0&dm=DENSE&map=osm&l=f.m`,
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    await a.performance.ready;
    for (const id of ['flights', 'military']) {
      a.dataManager.layers.get(id).module.setParams({ models3d: false });
      await a.dataManager.setEnabled(id, true, { origin: 'user' });
      await a.dataManager.layers.get(id).module.update(a.viewer);
    }
  });
  await wait(1800);
  const snapshot = () =>
    page.evaluate(() => {
      const a = window.__godsEyeView,
        r = { sprites: {}, models: [] };
      const visit = (c) => {
        for (let i = 0; i < c.length; i++) {
          const p = c.get(i);
          if (Number.isFinite(p.renderedCount)) {
            for (let j = 0; j < p.length; j++) {
              const b = p.get(j);
              r.sprites[b.id] = { show: b.show, alpha: b.color.alpha };
            }
          } else if (p.activeAnimations && p.modelMatrix) {
            r.models.push({ id: p.id, show: p.show, alpha: p.color?.alpha });
          } else if (typeof p.get === 'function' && Number.isInteger(p.length))
            visit(p);
        }
      };
      visit(a.viewer.scene.primitives);
      for (const id of ['flights', 'military']) {
        const m = a.dataManager.layers.get(id).module;
        r[id] = {
          params: m.getParams(),
          objects: m
            .getDetectableObjects()
            .map((o) => ({ id: o.sourceId, alpha: o.presentationAlpha })),
          search: m.findByQuery(id === 'flights' ? 'GROUND0' : 'MILGROUND')
            ?.icao24,
        };
      }
      return r;
    });
  const mode = async (value) => {
    await page.$$eval(
      '#ground-aircraft-controls [role="radio"]',
      (els, name) =>
        els.find((e) => e.textContent.trim().toLowerCase() === name).click(),
      value,
    );
    await wait(600);
    return snapshot();
  };
  report.dim = await snapshot();
  for (const id of ['flights', 'military']) {
    check(
      `${id}: Dim is the default`,
      report.dim[id].params.groundMode === 'dim',
    );
    check(
      `${id}: ground labels/brackets have 35% opacity`,
      report.dim[id].objects.find(
        (o) => o.id === (id === 'flights' ? 'c00000' : 'bbb101'),
      )?.alpha === 0.35,
    );
  }
  report.show = await mode('show');
  for (const ground of ['c00000', 'bbb101'])
    check(
      `${ground}: actual 2D silhouette dims to 35%`,
      Math.abs(
        report.dim.sprites[ground].alpha / report.show.sprites[ground].alpha -
          0.35,
      ) < 0.01,
    );
  for (const id of ['flights', 'military'])
    check(
      `${id}: Show restores full ground opacity`,
      report.show[id].objects.find(
        (o) => o.id === (id === 'flights' ? 'c00000' : 'bbb101'),
      )?.alpha === 1,
    );
  report.hide = await mode('hide');
  for (const ground of ['c00000', 'bbb101'])
    check(
      `${ground}: Hide suppresses the actual sprite`,
      report.hide.sprites[ground].show === false,
    );
  for (const id of ['flights', 'military']) {
    const ground = id === 'flights' ? 'c00000' : 'bbb101';
    check(
      `${id}: Hide removes grounded map candidates`,
      !report.hide[id].objects.some((o) => o.id === ground),
    );
    check(
      `${id}: hidden ground plane remains searchable`,
      report.hide[id].search === ground,
    );
    check(
      `${id}: airborne contacts stay visible`,
      report.hide[id].objects.some(
        (o) => o.id === (id === 'flights' ? 'c00001' : 'bbb102'),
      ),
    );
  }
  for (const id of ['flights', 'military']) {
    const ground = id === 'flights' ? 'c00000' : 'bbb101';
    await page.evaluate(
      ({ id, ground }) =>
        window.__godsEyeView.dataManager.layers
          .get(id)
          .module.trackById(ground, { origin: 'user' }),
      { id, ground },
    );
    await wait(1000);
    const tracked = (await snapshot())[id];
    check(
      `${id}: tracked ground contact overrides Hide`,
      tracked.objects.some((o) => o.id === ground && o.alpha === 1),
    );
    await page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.layers
          .get(id)
          .module.stopTracking({ origin: 'user' }),
      id,
    );
    await wait(400);
  }
  await page.evaluate(async () => {
    window.__groundFixture = false;
    const a = window.__godsEyeView;
    await a.dataManager.layers.get('flights').module.update(a.viewer);
  });
  await wait(600);
  check(
    'takeoff makes a hidden contact visible automatically',
    (await snapshot()).flights.objects.some((o) => o.id === 'c00000'),
  );
  await page.evaluate(async () => {
    window.__groundFixture = true;
    const a = window.__godsEyeView;
    await a.dataManager.layers.get('flights').module.update(a.viewer);
  });
  await wait(600);
  check(
    'landing hides it automatically',
    (await snapshot()).flights.objects.every((o) => o.id !== 'c00000'),
  );
  await mode('show');
  await page.evaluate(async () => {
    const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
    const a = window.__godsEyeView;
    for (const id of ['flights', 'military'])
      a.dataManager.layers
        .get(id)
        .module.setParams({ models3d: true, models3dMode: 'all' });
    a.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-98, 38.1, 65000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await wait(2500);
  report.modelsShown = await snapshot();
  await mode('dim');
  report.modelsDimmed = await snapshot();
  for (const ground of ['c00000', 'bbb101']) {
    const model = report.modelsDimmed.models.find(
      (m) => m.id === ground && m.show,
    );
    check(
      `${ground}: Dim applies to the visible 3D model or its loading fallback`,
      model
        ? Math.abs(model.alpha - 0.35) < 0.01
        : Math.abs(report.modelsDimmed.sprites[ground].alpha - 0.35) < 0.01,
    );
  }
  await mode('hide');
  await wait(800);
  report.modelsHidden = await snapshot();
  check(
    'Hide releases grounded 3D models in both layers',
    !report.modelsHidden.models.some((m) =>
      ['c00000', 'bbb101'].includes(m.id),
    ),
  );
  for (const airborne of ['c00001', 'bbb102'])
    check(
      `${airborne}: hiding ground traffic preserves airborne rendering`,
      report.modelsHidden.sprites[airborne].show ||
        report.modelsHidden.models.some((m) => m.id === airborne && m.show),
    );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('flights')
      .module.trackById('c00000', { origin: 'user' }),
  );
  await wait(1500);
  const protected3d = await page.evaluate(() => {
    const a = window.__godsEyeView,
      e = a.viewer.trackedEntity;
    return {
      object: a.dataManager.layers
        .get('flights')
        .module.getDetectableObjects()
        .find((o) => o.sourceId === 'c00000')?.presentationAlpha,
      entity: !!e,
    };
  });
  check(
    'tracked grounded aircraft stays visible with 3D enabled and Hide selected',
    protected3d.entity && protected3d.object === 1,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('flights')
      .module.stopTracking({ origin: 'user' }),
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await wait(1000);
  report.restored = await snapshot();
  check(
    'Hide persists across reload for both layers',
    report.restored.flights.params.groundMode === 'hide' &&
      report.restored.military.params.groundMode === 'hide',
  );
  await mode('dim');
  await page.$eval('#pp-toggles', (panel) => {
    if (panel.classList.contains('collapsed'))
      panel.querySelector('.pp-collapse-btn').click();
  });
  await wait(400);
  await page.$eval('#ground-aircraft-controls', (el) =>
    el.scrollIntoView({ block: 'center' }),
  );
  await page.screenshot({ path: `${out}/dim.png` });
  report.errors.push(...(await readRenderErrors(page)));
  check('no browser or render errors', report.errors.length === 0);
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await fs.writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
