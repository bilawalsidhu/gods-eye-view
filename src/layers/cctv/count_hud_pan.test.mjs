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

function cellAt(key, x, count, height = 0, y = H / 2) {
  const cell = createCameraCell(key);
  for (let i = 0; i < count; i++)
    addCellCamera(cell, {
      lon: lonFor(x),
      lat: (Math.asin(((H / 2 - y) * 30) / A) * 180) / Math.PI,
      absoluteHeightM: height,
    });
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

// 75 counts in five staggered rows, no lone cameras and no active camera,
// pan right 7 CSS px per frame for 60 frames past a left HUD rail. Counts must
// still hide and reappear at the rail, but the paint must not start a full
// view pass on almost every frame: the motion timer passes the view every
// 250 ms, about 4 times in these 60 frames at 60 Hz.
test('a pan past the HUD edge does not pass the view on every frame', async () => {
  const run = async (hud) => {
    const cells = [];
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 15; col++)
        cells.push(
          cellAt(
            `r${row}c${String(col).padStart(2, '0')}`,
            30 + col * 50 + row * 10,
            2,
            0,
            120 + row * 60,
          ),
        );
    let refreshes = 0;
    let hiddenFrames = 0;
    const m = counts(() => refreshes++);
    m.update(cells, project);
    for (let f = 0; f < 60; f++) {
      const panned = matrix.slice();
      panned[12] = (2 * (f * 7)) / W;
      const labels = paint({ ...hud, viewProjectionMatrix: panned });
      if (labels.length < 75) hiddenFrames++;
      await Promise.resolve();
    }
    m.dispose();
    return { refreshes, hiddenFrames };
  };
  const control = await run({});
  const withHud = await run({ overlapsHardUi: (rect) => rect.x < 150 });
  assert.equal(control.refreshes, 0);
  assert.ok(withHud.hiddenFrames > 0, 'the HUD hides no count');
  assert.ok(
    withHud.refreshes <= 4,
    `${withHud.refreshes} full view passes from paint in 60 frames`,
  );
});
