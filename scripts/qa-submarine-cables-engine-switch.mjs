import { fromDegrees } from '../src/geo/cartesian3.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStrict, localPreview } from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=55.3241&lon=10.7995&alt=25000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
const CABLES = 'telegeography-submarine-cables';
// Cables plus landing points in the bundled TeleGeography files.
const FEATURES = ['cable-geo', 'landing-point-geo']
  .map(
    (name) =>
      JSON.parse(
        readFileSync(
          new URL(
            `../src/data/local_data/telegeography_submarine_cables/${name}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ).features.length,
  )
  .reduce((a, b) => a + b, 0);
const strict = createStrict({
  origin: base.origin,
  layers: ['telegeography-submarine-cables'],
});
await strict.run({ args: ['--use-angle=metal', '--enable-gpu'] }, async (b) => {
  const p = await b.newPage();
  await p.setViewport({ width: 1024, height: 768 });
  const errors = [];
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message.split('?')[0]);
  });
  const reads = [];
  p.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (/\/(cable-geo|landing-point-geo).*\.json$/.test(path)) reads.push(path);
  });
  p.on('console', (msg) => {
    if (msg.type() === 'error' && /Shader|WebGLProgram/i.test(msg.text()))
      errors.push(msg.text());
  });
  await p.goto(base.href);
  const ready = async (kind) => {
    await p.waitForFunction(
      (k) =>
        window.__godsEyeView?.engine?.kind === k &&
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
    const { dataManager, tileset } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Keyless preview required');
    window.qaCables = dataManager.layers.get(
      'telegeography-submarine-cables',
    ).module;
    await dataManager.setEnabled(window.qaCables.id, true, { origin: 'user' });
  });
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.pick(p, kind);
      await ready(kind);
    }
    await p.waitForFunction(
      () => window.qaCables.getStats().referenceLabelCount > 0,
      { timeout: 90000 },
    );
    const check = await p.evaluate(() => {
      const { dataManager } = window.__godsEyeView;
      const mod = dataManager.layers.get(
        'telegeography-submarine-cables',
      ).module;
      return { same: mod === window.qaCables, ...mod.getStats() };
    });
    console.log(kind, check);
    assert.equal(check.same, true);
    assert.equal(check.count, FEATURES);
    assert.ok(check.referenceLabelCount <= 160);
    assert.equal(check.error, null);
    await strict.passed(
      p,
      CABLES,
      `same model, all ${FEATURES} cables and landing points of the bundled files, at most 160 labels`,
      { count: check.count, labels: check.referenceLabelCount },
    );
    {
      // Click-picking on this engine, from the starting view: a click on a
      // landing point flies the camera to it.
      await p.evaluate(
        (destination) => {
          const { camera, render } = window.__godsEyeView.engine;
          camera.cancelFlight();
          camera.setView({
            destination,
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          render.request('qa-home');
        },
        fromDegrees(10.7995, 55.3241, 25000),
      );
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const screen = await p.evaluate(
        (world) => {
          const { engine } = window.__godsEyeView;
          const at = engine.projector.worldToWindow(world, {});
          const rect = engine.host.canvas.getBoundingClientRect();
          return { x: rect.left + at.x, y: rect.top + at.y };
        },
        fromDegrees(10.799480647390464, 55.324102015186114),
      );
      await p.mouse.click(screen.x, screen.y);
      await p.waitForFunction(
        () => {
          const c = window.__godsEyeView.engine.camera.pose();
          return (
            Math.abs(c.cartographic.height - 6500) < 80 &&
            Math.abs(c.pitch + (52 * Math.PI) / 180) < 0.03
          );
        },
        { timeout: 20000 },
      );
      await strict.passed(
        p,
        CABLES,
        'a click on a landing point flies the camera to it',
      );
    }
  }
  await strict.check(
    p,
    CABLES,
    'each bundled file read once',
    reads.length === 2,
    reads,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS full bundled cable dataset, bounded labels, landing-point fly-to and one read per file',
  );
});
