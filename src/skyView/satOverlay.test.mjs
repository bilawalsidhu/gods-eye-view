import assert from 'node:assert/strict';
import test from 'node:test';
import { SATELLITE_CLASSES } from '../data/satelliteClass.js';
import { STATE } from './satCore.js';
import {
  ARROW_INSET_PX,
  COMPASS_BAND_PX,
  LABEL_BUDGET,
  SHADOW_COLOR,
  STALE_COLOR,
  boxesOverlap,
  drawSatellites,
  edgeArrow,
  geoBeltPoints,
  hitTest,
  lookAtView,
  passArcRuns,
  placeLabels,
  satelliteModel,
  skyClassColor,
  skyClassLabel,
} from './satOverlay.js';
import { makeView, projectAzEl } from './skyMath.js';

const W = 1280;
const H = 800;
const view = makeView({ azDeg: 180, elDeg: 45, fovDeg: 70 });

function obj(index, azDeg, elDeg, extra = {}) {
  return {
    index,
    name: `SAT-${index}`,
    azDeg,
    elDeg,
    state: STATE.VISIBLE,
    klass: 'visual',
    set: 'core',
    stale: false,
    ...extra,
  };
}

test('class colours come from satelliteClass.js; "other" uses its fallback', () => {
  for (const klass of Object.keys(SATELLITE_CLASSES))
    assert.equal(skyClassColor(klass), SATELLITE_CLASSES[klass].color);
  assert.equal(skyClassColor('other'), SATELLITE_CLASSES.visual.color);
  assert.equal(skyClassLabel('other'), 'ACTIVE');
  assert.equal(skyClassLabel('comms'), 'STARLINK');
  assert.equal(skyClassLabel('station'), 'STATION');
});

test('dense scripted case: 400 objects in a 12 x 8 deg patch -> no two labels overlap, all inside the canvas', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const objects = [];
  for (let i = 0; i < 400; i++)
    objects.push(
      obj(i, 174 + rand() * 12, 41 + rand() * 8, {
        set: i % 3 ? 'active' : 'core',
        klass: i % 3 ? 'other' : 'visual',
      }),
    );
  const model = satelliteModel({
    objects,
    view,
    width: W,
    height: H,
    selectedIndex: 17,
  });
  assert.equal(model.dots.length, 400);
  assert.ok(model.labels.length >= 10, `labels ${model.labels.length}`);
  assert.equal(model.labels[0].index, 17, 'selected placed first');
  for (let i = 0; i < model.labels.length; i++) {
    const a = model.labels[i].box;
    assert.ok(
      a.x >= 0 &&
        a.y >= 0 &&
        a.x + a.w <= W &&
        a.y + a.h <= H - COMPASS_BAND_PX,
    );
    for (let j = i + 1; j < model.labels.length; j++)
      assert.ok(
        !boxesOverlap(a, model.labels[j].box),
        `labels ${i} and ${j} overlap`,
      );
  }
});

test('label rules: selected + every core VISIBLE + at most the label budget of others; none for bright-sky/shadow', () => {
  const objects = [];
  // well separated grid so nothing collides
  for (let i = 0; i < 40; i++)
    objects.push(
      obj(i, 150 + (i % 8) * 8, 25 + Math.floor(i / 8) * 8, {
        set: i < 5 ? 'core' : 'active',
        klass: i < 5 ? 'visual' : 'other',
        state:
          i === 1
            ? STATE.SUNLIT_BRIGHT_SKY
            : i === 2
              ? STATE.SHADOW
              : STATE.VISIBLE,
      }),
    );
  const model = satelliteModel({
    objects,
    view,
    width: W,
    height: H,
    selectedIndex: 2,
  });
  const labelled = new Set(model.labels.map((l) => l.index));
  assert.ok(labelled.has(2), 'selected shadow object labelled');
  assert.ok(!labelled.has(1), 'bright-sky object not labelled');
  for (const i of [0, 3, 4]) assert.ok(labelled.has(i), `core ${i}`);
  const others = [...labelled].filter((i) => i >= 5);
  assert.equal(others.length, LABEL_BUDGET);
  assert.match(model.labels.find((l) => l.index === 0).text, /^SAT-0 \d+°$/);
});

test('dot styles by state, stale greying, terrain dimming, below-horizon and class filter', () => {
  const objects = [
    obj(0, 180, 40, { klass: 'station' }),
    obj(1, 185, 40, { state: STATE.SUNLIT_BRIGHT_SKY }),
    obj(2, 190, 40, { state: STATE.SHADOW }),
    obj(3, 175, 40, { stale: true }),
    obj(4, 170, 40),
    obj(5, 165, -1),
    obj(6, 160, 40, { klass: 'nav' }),
  ];
  const model = satelliteModel({
    objects,
    view,
    width: W,
    height: H,
    occlusion: (az, el) =>
      az === 170 ? 'terrain' : el < 0 ? 'below' : 'clear',
    classesOn: new Set(['station', 'visual']),
  });
  const dot = (i) => model.dots.find((d) => d.index === i);
  assert.equal(dot(0).kind, 'filled');
  assert.equal(dot(0).color, SATELLITE_CLASSES.station.color);
  assert.equal(dot(1).kind, 'ring');
  assert.equal(dot(2).kind, 'hollow');
  assert.equal(dot(2).color, SHADOW_COLOR);
  assert.equal(dot(3).color, STALE_COLOR);
  assert.ok(dot(3).alpha < 1);
  assert.equal(dot(4).dimmed, true);
  assert.ok(dot(4).alpha < 0.4);
  assert.ok(
    !model.labels.some((l) => l.index === 4),
    'no label behind terrain',
  );
  assert.equal(dot(5), undefined, 'below the horizon');
  assert.equal(dot(6), undefined, 'class chip off');
  const p = projectAzEl(180, 40, view, W, H);
  assert.ok(Math.abs(dot(0).x - p.x) < 1e-9 && Math.abs(dot(0).y - p.y) < 1e-9);
});

test('edge arrow for an off-screen selected object points the right way', () => {
  const v = makeView({ azDeg: 0, elDeg: 20, fovDeg: 60 });
  // Looking north 20 deg up, a point due east at 20 deg lies right and a
  // little up along the great circle from the view centre.
  const right = edgeArrow(90, 20, v, W, H);
  assert.ok(
    Math.cos(right.angle) > 0.9 && Math.sin(right.angle) < 0,
    `${right.angle}`,
  );
  assert.ok(Math.abs(right.x - (W - ARROW_INSET_PX)) < 1);
  const left = edgeArrow(270, 20, v, W, H);
  assert.ok(
    Math.cos(left.angle) < -0.9 && Math.sin(left.angle) < 0,
    `${left.angle}`,
  );
  assert.ok(Math.abs(left.x - ARROW_INSET_PX) < 1);
  // safe rectangle: panel on the left, toolbar on top
  const safe = edgeArrow(270, 20, v, W, H, { left: 340, top: 210 });
  assert.ok(Math.abs(safe.x - 340) < 1, `left edge of the safe area ${safe.x}`);
  const safeUp = edgeArrow(0, 85, v, W, H, { left: 340, top: 210 });
  assert.ok(Math.abs(safeUp.y - 210) < 1, `top of the safe area ${safeUp.y}`);
  const tiny = edgeArrow(270, 20, v, 300, 300, { left: 260 });
  assert.ok(
    Math.abs(tiny.x - ARROW_INSET_PX) < 1,
    'falls back on a narrow screen',
  );
  const up = edgeArrow(0, 85, v, W, H);
  assert.ok(Math.abs(up.angle + Math.PI / 2) < 0.05, `up ${up.angle}`);
  assert.ok(up.y < H / 2);
  const model = satelliteModel({
    objects: [obj(9, 90, 20)],
    view: v,
    width: W,
    height: H,
    selectedIndex: 9,
  });
  assert.equal(model.dots.length, 0);
  assert.equal(model.arrow.index, 9);
  assert.equal(model.arrow.text, 'SAT-9');
  assert.equal(
    satelliteModel({ objects: [obj(9, 90, 20)], view: v, width: W, height: H })
      .arrow,
    null,
    'no arrow when not selected',
  );
});

test('GEO belt: overhead at the equator, ~55.3 deg due south from Houston', () => {
  const eq = geoBeltPoints(0, 0);
  assert.ok(Math.max(...eq.map((p) => p[1])) > 89.9);
  const houston = geoBeltPoints(29.7604, -95.3698);
  const top = houston.reduce((a, b) => (b[1] > a[1] ? b : a));
  assert.ok(Math.abs(top[1] - 55.3) < 0.3, `max el ${top[1]}`);
  assert.ok(Math.abs(top[0] - 180) < 0.5, `az ${top[0]}`);
  assert.ok(houston.every((p) => p[1] > -1));
  const model = satelliteModel({
    objects: [],
    view: makeView({ azDeg: 180, elDeg: 40, fovDeg: 90 }),
    width: W,
    height: H,
    geoBelt: houston,
  });
  assert.ok(model.belt.length >= 1 && model.belt[0].length > 10);
});

test('hit test and animated look-at (shortest way round, eased, exact at the end)', () => {
  const model = {
    dots: [
      { index: 1, x: 100, y: 100 },
      { index: 2, x: 108, y: 100 },
    ],
  };
  assert.equal(hitTest(model, 106, 100), 2);
  assert.equal(hitTest(model, 300, 300), null);
  assert.equal(hitTest(null, 0, 0), null);
  const from = makeView({ azDeg: 350, elDeg: 10, fovDeg: 50 });
  const to = { azDeg: 10, elDeg: 60 };
  const mid = lookAtView(from, to, 0.5);
  assert.ok(mid.azDeg > 350 || mid.azDeg < 10, `through north: ${mid.azDeg}`);
  assert.deepEqual(
    { az: lookAtView(from, to, 1).azDeg, el: lookAtView(from, to, 1).elDeg },
    { az: 10, el: 60 },
  );
  assert.equal(lookAtView(from, to, 0).azDeg, 350);
  assert.equal(lookAtView(from, to, 1).fovDeg, 50, 'fov kept');
});

test('placeLabels drops what cannot fit; drawSatellites paints without throwing', () => {
  const placed = placeLabels(
    [
      { index: 0, x: 5, y: 5, r: 2, text: 'A', color: '#fff' },
      { index: 1, x: 5, y: 5, r: 2, text: 'B', color: '#fff' },
      { index: 2, x: 5, y: 5, r: 2, text: 'C', color: '#fff' },
      { index: 3, x: 5, y: 5, r: 2, text: 'D', color: '#fff' },
      { index: 4, x: 5, y: 5, r: 2, text: 'E', color: '#fff' },
    ],
    200,
    200,
  );
  assert.ok(placed.length < 5);
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (t, k) => (k in t ? t[k] : (...args) => calls.push([k, ...args])),
      set: (t, k, v) => ((t[k] = v), true),
    },
  );
  const model = satelliteModel({
    objects: [obj(1, 180, 45), obj(2, 40, 20)],
    view,
    width: W,
    height: H,
    selectedIndex: 2,
    geoBelt: geoBeltPoints(29.76, -95.37),
  });
  drawSatellites(ctx, model);
  drawSatellites(ctx, null);
  assert.ok(calls.some(([k]) => k === 'arc'));
  assert.ok(calls.some(([k]) => k === 'fillText'));
});

test('include filter (selected always drawn) and the pass arc split by lighting', () => {
  const objects = [
    obj(1, 180, 45, { estMag: 3 }),
    obj(2, 185, 45, { estMag: 9, klass: 'other' }),
  ];
  const include = (o) => o.estMag <= 5.5;
  let model = satelliteModel({ objects, view, width: W, height: H, include });
  assert.deepEqual(
    model.dots.map((d) => d.index),
    [1],
  );
  model = satelliteModel({
    objects,
    view,
    width: W,
    height: H,
    include,
    selectedIndex: 2,
  });
  assert.deepEqual(model.dots.map((d) => d.index).sort(), [1, 2]);
  // arc: shadow -> sunlit -> shadow, every point in front of the camera
  const rows = [];
  for (let k = 0; k <= 30; k++)
    rows.push([
      150 + 2 * k,
      30 + k * 0.5,
      k >= 10 && k < 20 ? 1 : 0,
      k * 10_000,
    ]);
  const runs = passArcRuns(rows, view, W, H);
  assert.deepEqual(
    runs.map((r) => r.sunlit),
    [false, true, false],
  );
  assert.equal(runs[0].points.length, 10);
  assert.equal(runs[1].points.length, 11, 'joined to the previous run');
  const p = projectAzEl(170, 35, view, W, H);
  assert.ok(Math.abs(runs[1].points[1].x - p.x) < 1e-6);
  model = satelliteModel({ objects, view, width: W, height: H, passArc: rows });
  assert.equal(model.arc.length, 3);
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, k) => (k in _t ? _t[k] : (...a) => calls.push([k, a])),
      set: (t, k, v) => ((t[k] = v), true),
    },
  );
  drawSatellites(ctx, model);
  assert.ok(calls.some(([k]) => k === 'lineTo'));
  assert.deepEqual(passArcRuns(null, view, W, H), []);
});
