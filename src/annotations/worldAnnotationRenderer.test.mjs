// The world renderer draws each mark through the draw port, in sets of its
// own: a hidden mark has its sets hidden on sync and shown again; a fading
// mark takes its new colours in place; every kind draws what it drew as
// entities, draped and clamped to terrain and tiles alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';
import { createWorldAnnotationRenderer } from './worldAnnotationRenderer.js';

/**
 * A viewer with a fake draw port, frame and query bound; `emit()` runs the
 * frame's postRender listeners.
 */
function viewer(t, { heights = () => null } = {}) {
  const draw = fakeDrawPort();
  const frames = new Set();
  const v = { requests: 0 };
  const frame = {
    on(phase, cb) {
      if (phase !== 'postRender') return () => {};
      frames.add(cb);
      return () => frames.delete(cb);
    },
    requestRender() {
      v.requests += 1;
    },
  };
  const query = { sampleHeightNow: (point) => heights(point) };
  const unbind = bindRenderer(v, { draw, frame, query });
  t.after(unbind);
  return {
    v,
    draw,
    frames,
    emit: () => [...frames].forEach((cb) => cb()),
  };
}

const marks = () => [
  {
    id: 'route',
    type: 'route',
    color: 'amber',
    alpha: 1,
    anchor: { lat: 0, lon: 0 },
    path: [
      { lat: 0, lon: 0 },
      { lat: 0.01, lon: 0.01 },
    ],
  },
  {
    id: 'area',
    type: 'area',
    color: 'green',
    alpha: 1,
    anchor: { lat: 0.005, lon: 0.005 },
    ring: [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0],
    ],
  },
];

/** The live sets a mark draws into. */
const setsOf = (draw, anno) =>
  [...draw.sets.values()].filter(
    (record) =>
      !record.disposed && record.spec.id.startsWith(`${anno._draw.prefix}:`),
  );

test('each mark draws in sets of its own; a hidden one has them hidden on sync, and back when shown', (t) => {
  const { v, draw } = viewer(t);
  const renderer = createWorldAnnotationRenderer(v);
  const [route, area] = marks();
  const other = {
    ...area,
    id: 'other',
    anchor: { lat: 0.025, lon: 0.025 },
    ring: [
      [0.02, 0.02],
      [0.03, 0.02],
      [0.03, 0.03],
      [0.02, 0.02],
    ],
  };
  for (const anno of [route, area, other]) renderer.add(anno);
  for (const anno of [route, area, other])
    assert.ok(setsOf(draw, anno).length > 0, anno.id);
  const shown = (anno) => setsOf(draw, anno).map((record) => record.show);

  route.hidden = true;
  area.hidden = true;
  renderer.sync();
  assert.ok(
    shown(route).every((show) => show === false),
    'the line is off',
  );
  assert.ok(
    shown(area).every((show) => show === false),
    'the area is off',
  );
  assert.ok(
    shown(other).every((show) => show === true),
    'a visible mark stays',
  );

  route.hidden = false;
  renderer.sync();
  assert.ok(
    shown(route).every((show) => show === true),
    'the line is back',
  );
  const areaSets = setsOf(draw, area);
  renderer.remove(area);
  assert.ok(
    areaSets.every((record) => record.disposed),
    'a removed mark lets its sets go',
  );
  renderer.sync();
  renderer.destroy();
  assert.equal(
    [...draw.sets.values()].filter((record) => !record.disposed).length,
    0,
  );
});

test('a fading mark takes its new colours in place, its pulses with them', (t) => {
  const { v, draw } = viewer(t);
  const renderer = createWorldAnnotationRenderer(v);
  const [route, area] = marks();
  renderer.add(route);
  renderer.add(area);
  const line = () => [...setsOf(draw, route)[0].items.values()][0];
  const fill = () =>
    setsOf(draw, area)
      .find((r) => r.kind === 'shapes')
      .items.get('fill:0');
  assert.ok(Math.abs(line().style.color[3] - 0.95) < 1e-9);
  assert.ok(Math.abs(fill().fill[3] - 0.2) < 1e-9);
  route.alpha = 0.5;
  area.alpha = 0.5;
  renderer.sync();
  assert.ok(Math.abs(line().style.color[3] - 0.475) < 1e-9, 'fading');
  assert.ok(Math.abs(fill().fill[3] - 0.1) < 1e-9);
  assert.deepEqual(
    [fill().animate.from, fill().animate.to].map((a) => Math.round(a * 1000)),
    [60, 100],
    'its pulse swings between 60% and all of its alpha',
  );
  route.alpha = 0;
  renderer.sync();
  assert.equal(line().style.color[3], 0, 'faded out: nothing painted');
  renderer.destroy();
});

test('every kind draws as it did: draped on terrain and tiles alike, pulses', (t) => {
  const { v, draw } = viewer(t);
  const renderer = createWorldAnnotationRenderer(v);
  const [route, area] = marks();
  const synth = { ...area, id: 'synth', synthesized: true };
  for (const anno of [route, area, synth]) renderer.add(anno);
  const items = (anno, kind) => [
    ...(setsOf(draw, anno)
      .find((r) => r.kind === kind)
      ?.items.values() ?? []),
  ];
  for (const record of [...draw.sets.values()])
    assert.equal(record.spec.clampTo, 'both');

  const [flow] = items(route, 'lines');
  assert.equal(flow.mode, 'draped');
  assert.equal(flow.widthPx, 9);
  assert.deepEqual(
    { ...flow.style, color: undefined },
    { kind: 'flow', color: undefined, repeat: 64, duty: 0.46, speed: 0.55 },
  );

  const [areaFill] = items(area, 'shapes');
  assert.equal(areaFill.height, 'clampGround');
  assert.equal(areaFill.animate.property, 'alpha');
  assert.ok(Math.abs(areaFill.animate.periodMs - (2 * Math.PI) / 0.005) < 1e-9);
  const [areaLine] = items(area, 'lines');
  assert.deepEqual(
    [areaLine.widthPx, areaLine.style.kind, areaLine.style.power],
    [6, 'glow', 0.35],
  );
  const [synthLine] = items(synth, 'lines');
  assert.deepEqual(
    [synthLine.style.kind, synthLine.style.length],
    ['dash', 24],
  );
  assert.ok(
    Math.abs(items(synth, 'shapes')[0].fill[3] - 0.1) < 1e-9,
    'an approximate area is fainter',
  );
  renderer.destroy();
});

test('a building waits for its ground probes, then draws a pulsing column, a cage and a draped base', async (t) => {
  const { v, draw, emit, frames } = viewer(t, { heights: () => 150 });
  const renderer = createWorldAnnotationRenderer(v);
  const ring = [
    [0, 0],
    [0.001, 0],
    [0.001, 0.001],
    [0, 0.001],
    [0, 0],
  ];
  const anno = {
    id: 'b',
    type: 'area',
    color: 'amber',
    alpha: 1,
    footprintKind: 'building',
    buildingHeight: 40,
    anchor: { lon: 0.0005, lat: 0.0005, height: 200 },
    ring,
  };
  const done = renderer.add(anno);
  assert.equal(frames.size, 1, 'probing on the frames');
  assert.equal(
    setsOf(draw, anno).length,
    0,
    'nothing until its ground is known',
  );
  for (let i = 0; i < 8; i++) emit();
  assert.equal((await done).status, 'installed');
  assert.equal(frames.size, 0, 'done probing');
  const shapes = [
    ...setsOf(draw, anno)
      .find((r) => r.kind === 'shapes')
      .items.values(),
  ];
  const volume = shapes.find((s) => s.id === 'volume:0');
  assert.equal(volume.extrudeHeight, 150 + 40 + 24);
  assert.equal(volume.geometry.rings[0][0].height, 147);
  assert.equal(volume.height, 'absolute');
  const cage = shapes.find((s) => s.id === 'cage:0');
  assert.equal(cage.outlineOnly, true);
  assert.ok(cage.geometry.rings[0].length <= 14);
  const [base] = setsOf(draw, anno)
    .find((r) => r.kind === 'lines')
    .items.values();
  assert.deepEqual(
    [base.mode, base.widthPx, base.style.kind, base.style.power],
    ['draped', 3, 'glow', 0.25],
  );
  renderer.destroy();
});

test('each kind paints the alphas it painted as entities, at full alpha', (t) => {
  const { v, draw } = viewer(t, { heights: () => 150 });
  const renderer = createWorldAnnotationRenderer(v);
  const [route, area] = marks();
  const synth = { ...area, id: 'synth', synthesized: true };
  const ring = Array.from({ length: 40 }, (_, i) => [
    0.0005 + 0.0004 * Math.cos((i / 40) * 2 * Math.PI),
    0.0005 + 0.0004 * Math.sin((i / 40) * 2 * Math.PI),
  ]);
  const building = {
    id: 'b',
    type: 'area',
    color: 'amber',
    alpha: 1,
    footprintKind: 'building',
    buildingHeight: 40,
    anchor: { lon: 0.0005, lat: 0.0005, height: 200 },
    ring,
  };
  for (const anno of [route, area, synth]) renderer.add(anno);
  renderer.add(building, { sampledGroundHeight: 150 });
  const items = (anno, kind) => [
    ...(setsOf(draw, anno)
      .find((r) => r.kind === kind)
      ?.items.values() ?? []),
  ];
  const alpha = (c) => Math.round(c[3] * 1000) / 1000;
  assert.equal(alpha(items(route, 'lines')[0].style.color), 0.95);
  assert.equal(alpha(items(area, 'lines')[0].style.color), 1);
  assert.equal(alpha(items(synth, 'lines')[0].style.color), 0.95);
  const [volume, cage] = items(building, 'shapes');
  assert.equal(alpha(volume.fill), 0.45);
  assert.equal(alpha(cage.outline), 0.32);
  assert.equal(
    Math.round(cage.animate.from * 1000) / 1000,
    0.192,
    'the cage pulses too',
  );
  assert.equal(cage.geometry.rings[0].length, 14, 'decimated to 14');
  assert.equal(alpha(items(building, 'lines')[0].style.color), 0.7);
  renderer.destroy();
});

test('a mark removed and added again draws afresh; two renderers on one viewer keep apart', (t) => {
  const { v, draw } = viewer(t);
  const first = createWorldAnnotationRenderer(v);
  const second = createWorldAnnotationRenderer(v);
  const [route, area] = marks();
  first.add(route);
  const prefix = route._draw.prefix;
  first.remove(route);
  assert.doesNotThrow(() => first.add(route));
  assert.notEqual(route._draw.prefix, prefix, 'fresh sets');
  assert.doesNotThrow(() => second.add(area));
  assert.ok(
    !area._draw.prefix.startsWith(
      route._draw.prefix.split(':').slice(0, 2).join(':') + ':',
    ),
  );
  // Added again as another kind, its old sets go.
  const kinds = () =>
    setsOf(draw, route)
      .map((r) => r.kind)
      .sort();
  assert.deepEqual(kinds(), ['lines']);
  Object.assign(route, {
    type: 'area',
    path: undefined,
    ring: [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0],
    ],
  });
  first.add(route);
  assert.deepEqual(kinds(), ['lines', 'shapes']);
  assert.doesNotThrow(() => first.remove(null));
  first.destroy();
  second.destroy();
  assert.equal(route._draw, null);
  first.add(route);
  assert.equal(route._draw, null, 'a destroyed renderer draws nothing more');
  assert.equal([...draw.sets.values()].filter((r) => !r.disposed).length, 0);
});
