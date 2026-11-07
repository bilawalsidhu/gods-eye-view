import assert from 'node:assert/strict';
import test from 'node:test';
import { azDelta, drawOverlay, overlayModel } from './overlay.js';
import { makeView } from './skyMath.js';

const W = 1200;
const H = 800;

test('looking north at the horizon: N label at the screen centre on the horizon line', () => {
  const model = overlayModel({
    view: makeView({ azDeg: 0, elDeg: 0, fovDeg: 100 }),
    width: W,
    height: H,
  });
  const n = model.cardinals.find((c) => c.label === 'N');
  assert.ok(Math.abs(n.x - W / 2) < 1e-6);
  assert.ok(Math.abs(n.y - H / 2) < 1e-6);
  const labels = model.cardinals.map((c) => c.label).sort();
  assert.deepEqual(labels, ['N', 'NE', 'NW']);
  assert.ok(
    model.cardinals.find((c) => c.label === 'NE').x > W / 2,
    'east is to the right',
  );
  assert.ok(model.horizon.length > 10);
  assert.equal(model.ground, null, 'real horizon: no painted ground');
});

test('looking up, the horizon leaves the view and only the compass strip remains', () => {
  const model = overlayModel({
    view: makeView({ azDeg: 90, elDeg: 80, fovDeg: 60 }),
    width: W,
    height: H,
  });
  assert.equal(model.cardinals.length, 0);
  assert.ok(model.compass.length > 0);
  const centre = model.compass.reduce((best, t) =>
    Math.abs(t.x - W / 2) < Math.abs(best.x - W / 2) ? t : best,
  );
  assert.equal(centre.azDeg, 90);
  assert.equal(centre.label, 'E');
});

test('flat horizon paints the ground below the horizon and a sky gradient until nautical dusk', () => {
  const day = overlayModel({
    view: makeView({ azDeg: 180, elDeg: 10, fovDeg: 70 }),
    width: W,
    height: H,
    flatHorizon: true,
    sunAltDeg: 30,
  });
  assert.ok(day.ground.length > 4);
  assert.ok(
    day.horizon.every((p) => p.y > H / 2),
    'horizon below centre when looking up 10 deg',
  );
  assert.equal(day.gradient.alpha, 0.92);
  const night = overlayModel({
    view: makeView({ elDeg: 10 }),
    width: W,
    height: H,
    flatHorizon: true,
    sunAltDeg: -30,
  });
  assert.equal(night.gradient, null, 'night: the skybox shows instead');
  const realDusk = overlayModel({
    view: makeView({ elDeg: 10 }),
    width: W,
    height: H,
    sunAltDeg: -4,
  });
  assert.ok(realDusk.wash.alpha > 0);
  assert.equal(realDusk.gradient, null);
});

test('alt/az grid only when asked', () => {
  const view = makeView({ azDeg: 45, elDeg: 40, fovDeg: 90 });
  assert.equal(overlayModel({ view, width: W, height: H }).grid.length, 0);
  const grid = overlayModel({ view, width: W, height: H, grid: true }).grid;
  assert.ok(grid.some((l) => l.kind === 'alt' && l.value === 45));
  assert.ok(grid.some((l) => l.kind === 'az' && l.value === 30));
});

test('compass strip ticks are in order and cover the horizontal fov', () => {
  const model = overlayModel({
    view: makeView({ azDeg: 350, elDeg: 0, fovDeg: 60 }),
    width: W,
    height: H,
  });
  const xs = model.compass.map((t) => t.x);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1]);
  assert.ok(model.compass.some((t) => t.label === 'N'));
  assert.equal(azDelta(10, 350), 20);
  assert.equal(azDelta(350, 10), -20);
});

test('drawOverlay paints without throwing on a recording context', () => {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (target, key) =>
        key in target
          ? target[key]
          : key === 'createLinearGradient'
            ? () => ({ addColorStop: () => {} })
            : (...args) => calls.push([key, args.length]),
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    },
  );
  const model = overlayModel({
    view: makeView({ elDeg: 5 }),
    width: W,
    height: H,
    flatHorizon: true,
    grid: true,
    sunAltDeg: -3,
  });
  drawOverlay(ctx, model, { width: W, height: H });
  assert.ok(calls.some(([k]) => k === 'fillText'));
  assert.equal(calls[0][0], 'clearRect');
});

test('viewProjector (one camera basis per redraw) is bit-identical to projectAzEl', async () => {
  const { viewProjector } = await import('./overlay.js');
  const { enuFromAzEl, projectAzEl } = await import('./skyMath.js');
  for (const view of [
    { azDeg: 145, elDeg: 52, fovDeg: 60, rollDeg: 0 },
    { azDeg: 10, elDeg: 89, fovDeg: 100, rollDeg: 0 },
    { azDeg: 300, elDeg: 5, fovDeg: 25, rollDeg: 12 },
  ]) {
    for (const [w, h] of [
      [1280, 800],
      [412, 915],
    ]) {
      const project = viewProjector(view, w, h);
      for (let az = 0; az < 360; az += 7)
        for (let el = -10; el <= 90; el += 9)
          assert.deepEqual(
            project(enuFromAzEl(az, el)),
            projectAzEl(az, el, view, w, h),
          );
    }
  }
});

test('grid culling: every grid segment that crosses the canvas is still drawn', async () => {
  const { visibleRuns } = await import('./overlay.js');
  const { viewProjector } = await import('./overlay.js');
  const { enuFromAzEl } = await import('./skyMath.js');
  const hits = (a, b, w, h) => {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (const [p, q] of [
      [-dx, a.x],
      [dx, w - a.x],
      [-dy, a.y],
      [dy, h - a.y],
    ]) {
      if (p === 0) {
        if (q < 0) return false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
        if (t0 > t1) return false;
      }
    }
    return true;
  };
  let checked = 0;
  for (const [azDeg, elDeg, fovDeg, w, h] of [
    [145, 52, 60, W, H],
    [10, 5, 100, 412, 915],
    [250, 85, 30, W, H],
  ]) {
    const view = makeView({ azDeg, elDeg, fovDeg });
    const project = viewProjector(view, w, h);
    const points = [];
    for (let az = 0; az <= 360; az += 2) points.push(enuFromAzEl(az, 30));
    const runs = visibleRuns(points, project, w, h);
    const key = (a, b) => `${a.x.toFixed(4)},${a.y.toFixed(4)},${b.x},${b.y}`;
    const drawn = new Set();
    for (const run of runs)
      for (let i = 1; i < run.length; i++) drawn.add(key(run[i - 1], run[i]));
    let prev = null;
    for (const d of points) {
      const p = project(d);
      if (prev && p && hits(prev, p, w, h)) {
        assert.ok(drawn.has(key(prev, p)), 'visible grid segment kept');
        checked++;
      }
      prev = p;
    }
    // and nothing far outside is drawn
    for (const run of runs)
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1];
        const b = run[i];
        assert.ok(
          !(
            (a.x < -20 && b.x < -20) ||
            (a.y < -20 && b.y < -20) ||
            (a.x > w + 20 && b.x > w + 20) ||
            (a.y > h + 20 && b.y > h + 20)
          ),
        );
      }
  }
  assert.ok(checked > 20);
});

test('drawOverlay with a text sprite cache draws no glyphs and sets no font', async () => {
  const { createTextSprites } = await import('./textSprites.js');
  const calls = [];
  const fontSets = [];
  const sprite = () => ({
    getContext: () => ({
      measureText: (t) => ({
        width: t.length * 7,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: t.length * 7,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
      }),
      setTransform() {},
      strokeText() {},
      fillText() {},
    }),
  });
  const text = createTextSprites(() => sprite());
  const ctx = new Proxy(
    {},
    {
      get: (target, key) =>
        key in target
          ? target[key]
          : key === 'createLinearGradient'
            ? () => ({ addColorStop: () => {} })
            : (...args) => calls.push([key, args.length]),
      set: (target, key, value) => {
        if (key === 'font') fontSets.push(value);
        target[key] = value;
        return true;
      },
    },
  );
  const model = overlayModel({
    view: makeView({ azDeg: 0, elDeg: 5, fovDeg: 100 }),
    width: W,
    height: H,
  });
  drawOverlay(ctx, model, { width: W, height: H, text, ratio: 2 });
  assert.ok(!calls.some(([k]) => k === 'fillText' || k === 'strokeText'));
  assert.equal(fontSets.length, 0);
  const blits = calls.filter(([k]) => k === 'drawImage').length;
  assert.ok(blits >= 3, `${blits} label blits`);
});
