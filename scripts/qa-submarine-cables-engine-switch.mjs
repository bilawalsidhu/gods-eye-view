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
  'v=2&lat=55.3241&lon=10.7995&alt=25000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
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
      await p.select('#globe-engine', kind);
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
    assert.equal(check.count, 2629);
    assert.ok(check.referenceLabelCount <= 160);
    assert.equal(check.error, null);
    if (kind === 'navara') {
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
    }
  }
  assert.equal(reads.length, 2, JSON.stringify(reads));
  assert.deepEqual(errors, []);
  console.log(
    'PASS full bundled cable dataset, bounded labels, landing-point fly-to and one read per file',
  );
} finally {
  await b.close();
}
