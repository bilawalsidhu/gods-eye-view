import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCountMarkers } from './countMarkers.js';
import { addCellCamera, createCameraCell } from '../../data/cctvCellCounts.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { horizonFrom } from '../../geo/horizon.js';

const W = 800;
const H = 600;
const A = 6378137;
// Screen x = W/2 + ecefY/30, y = H/2 - ecefZ/30 (as the view-thinning fixture).
const project = (p) => ({ x: W / 2 + p.y / 30, y: H / 2 - p.z / 30 });
const lonFor = (x) => (Math.asin(((x - W / 2) * 30) / A) * 180) / Math.PI;
const matrix = new Float64Array([
  0,
  0,
  0,
  0,
  2 / (30 * W),
  0,
  0,
  0,
  0,
  2 / (30 * H),
  0,
  0,
  0,
  0,
  0,
  1,
]);

function cellAt(key, x, count, height = 0) {
  const cell = createCameraCell(key);
  for (let i = 0; i < count; i++)
    addCellCamera(cell, { lon: lonFor(x), lat: 0, absoluteHeightM: height });
  return cell;
}

let painter;
function makeCtx() {
  return {
    labels: [],
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    roundRect() {},
    stroke() {},
    fill() {},
    drawImage() {},
    fillText(text, x, y) {
      this.labels.push({ text, x, y, alpha: this.globalAlpha });
    },
  };
}
function paint(overrides = {}) {
  const ctx = makeCtx();
  painter({
    ctx,
    width: W,
    height: H,
    dpr: 1,
    viewProjectionMatrix: matrix,
    occluder: { isPointVisible: () => true },
    overlapsHardUi: () => false,
    ...overrides,
  });
  return ctx.labels;
}
function counts(refresh = () => {}, keyholeAlpha) {
  return createCountMarkers(
    (_lane, paintFn) => {
      painter = paintFn;
      return { requestPaint() {}, setActive() {}, unregister() {} };
    },
    'counts',
    refresh,
    keyholeAlpha,
  );
}

beforeEach(() => {
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        measureText: (text) => ({
          width: text.length * 7,
          actualBoundingBoxAscent: 4,
          actualBoundingBoxDescent: 4,
        }),
      }),
    }),
  };
});
afterEach(() => {
  delete globalThis.document;
});
test('a count on ground below the ellipsoid stays painted while its mounts are above the horizon', () => {
  const m = counts();
  m.update([cellAt('a', 400, 2, -20)], project, () => -30);
  const eye = fromDegrees(-0.009, 0, 30); // about 1 km away, 30 m above the ellipsoid
  const horizon = horizonFrom(eye);
  assert.equal(horizon.isPointVisible(fromDegrees(lonFor(400), 0, -20)), true);
  assert.equal(paint({ occluder: horizon }).length, 1);
});

test('a lone camera clear of the HUD keeps its icon when the count beside it is hidden', async () => {
  const hud = { overlapsHardUi: (rect) => rect.x < 200 };
  for (const paintedFirst of [true, false]) {
    const cells = [cellAt('a', 200, 2), cellAt('b', 234, 1)];
    const m = counts(() => m.update(cells, project));
    if (paintedFirst) paint(hud);
    m.update(cells, project);
    const labels = paint(hud);
    await Promise.resolve();
    assert.ok(!cells[1].absorbed || labels.length > 0);
    // Moving the HUD at rest also changes whether the lone icon is needed.
    paint();
    await Promise.resolve();
    assert.equal(cells[1].absorbed, true);
    paint(hud);
    await Promise.resolve();
    assert.equal(cells[1].absorbed, false);
    m.dispose();
  }
});

test('a count stays visible when a lone camera would move it under the HUD', async () => {
  const cells = [cellAt('a', 200, 2), cellAt('b', 234, 1)];
  const hud = { overlapsHardUi: (rect) => rect.x + rect.w > 225 };
  const m = counts(() => m.update(cells, project));
  paint(hud);
  m.update(cells, project);
  assert.equal(paint(hud)[0]?.text, '2');
  assert.equal(cells[1].absorbed, false);
  await Promise.resolve();
  paint(hud);
  await Promise.resolve();

  paint();
  await Promise.resolve();
  assert.equal(cells[1].absorbed, true);
  assert.equal(paint()[0]?.text, '3');
  m.dispose();
});

test('a restored count includes the lone camera it still covers at the HUD edge', async () => {
  const cells = [cellAt('a', 200, 2), cellAt('b', 206, 1)];
  const hud = { overlapsHardUi: (rect) => rect.x + rect.w > 221 };
  const scratch = {};
  const update = () =>
    m.update(cells, (p) => Object.assign(scratch, project(p)));
  const m = counts(update);
  update();
  assert.equal(Math.round(paint()[0].x), 202);

  paint(hud);
  await Promise.resolve();
  const [marker] = paint(hud);
  assert.equal(marker?.text, '3');
  assert.equal(Math.round(marker.x), 200);
  assert.equal(cells[1].absorbed, true);
  assert.ok(m.pickedCell({ x: 206, y: 300 }).parts.includes(cells[1]));

  paint();
  await Promise.resolve();
  assert.equal(Math.round(paint()[0].x), 202);
  m.dispose();
});

test('counts fade with the Scope keyhole like the callouts', () => {
  const m = counts(undefined, (_x, _y, keyhole) => keyhole.alpha);
  m.update([cellAt('a', 400, 2)], project);
  assert.equal(paint({ keyhole: { alpha: 0.25 } })[0].alpha, 0.25);
  assert.deepEqual(paint({ keyhole: { alpha: 0 } }), []);
  assert.equal(m.pickedCell({ x: 400, y: 300 }), null);
  assert.equal(paint()[0].alpha, 1);
});
