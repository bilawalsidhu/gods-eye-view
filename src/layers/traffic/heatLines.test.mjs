import test from 'node:test';
import assert from 'node:assert/strict';
import { createRendering } from './rendering.js';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';
import {
  HEAT_JAM_BASE_ALPHA,
  HEAT_JAM_COLOR,
  HEAT_JAM_PULSE_ALPHA,
  HEAT_LINE_CAP,
  HEAT_LINE_JAM_WIDTH,
  HEAT_LINE_SLOW_WIDTH,
  HEAT_SLOW_COLOR,
} from './policy.js';

/** A road of `length` metres along x, in the flow bucket `level` gives. */
const road = (level, length = 100, x = 0) => ({
  flow: { level },
  segmentDist: [length],
  waypoints: [
    { x, y: 6378137, z: 0 },
    { x: x + length, y: 6378137, z: 0 },
  ],
});

function setup({ live = true, heatline = true, preset = 'normal' } = {}) {
  const draw = fakeDrawPort();
  const demand = [];
  const state = {
    _viewer: {},
    _liveMode: live,
    _presetDots: 'on',
    _stylePreset: preset,
    _heatJam: [],
    _heatLineCount: 0,
    _heatSet: draw.lines({ id: 'traffic:1:heat', clampTo: 'tiles' }),
  };
  const rendering = createRendering({
    state,
    services: {},
    parts: {
      style: { heatlineOn: () => heatline },
      animation: { syncRenderDemand: () => demand.push(state._heatLineCount) },
    },
    source: {},
  });
  const items = () => [...draw.set('traffic:1:heat').items.values()];
  return {
    state,
    rendering,
    items,
    demand,
    record: draw.set('traffic:1:heat'),
  };
}

test('congested roads drape heat-lines on the tiles: jam glowing, slow flat', () => {
  const { state, rendering, items, demand } = setup();
  rendering.rebuildHeatLines([
    road(0.9), // free: none
    road(0.2, 50, 1), // jam
    road(0.6, 80, 2), // slow
    { ...road(0.2), flow: { level: 0.2, closure: true } }, // closed: none
  ]);
  const lines = items();
  assert.equal(lines.length, 2);
  const [jam, slow] = lines;
  assert.equal(jam.mode, 'draped');
  assert.equal(jam.clampTo, 'tiles');
  assert.equal(jam.widthPx, HEAT_LINE_JAM_WIDTH);
  assert.deepEqual(jam.style, {
    kind: 'glow',
    color: [...HEAT_JAM_COLOR.slice(0, 3), HEAT_JAM_BASE_ALPHA],
    power: 0.25,
  });
  assert.deepEqual(jam.positions, [
    { x: 1, y: 6378137, z: 0 },
    { x: 51, y: 6378137, z: 0 },
  ]);
  assert.equal(slow.widthPx, HEAT_LINE_SLOW_WIDTH);
  assert.deepEqual(slow.style, { kind: 'solid', color: HEAT_SLOW_COLOR });
  assert.equal(state._heatLineCount, 2);
  assert.equal(rendering.heatPulsing(), true);
  assert.deepEqual(demand, [2]);
});

test('the jam heat-lines pulse together, recoloured where they are', () => {
  const { rendering, items, record } = setup();
  rendering.rebuildHeatLines([road(0.2), road(0.25, 50), road(0.6)]);
  const writes = record.writes;
  rendering.pulseHeatLines(260 * (Math.PI / 2));
  assert.equal(record.writes, writes + 1, 'one upsert a frame');
  const alpha = HEAT_JAM_BASE_ALPHA + HEAT_JAM_PULSE_ALPHA;
  const [a, b, slow] = items();
  assert.ok(Math.abs(a.style.color[3] - alpha) < 1e-12);
  assert.equal(b.style, a.style);
  assert.equal(slow.style.kind, 'solid', 'slow lines do not pulse');
});

test('heat-lines are capped jam first, longest first', () => {
  const { items } = (() => {
    const s = setup();
    const roads = [];
    for (let i = 0; i < HEAT_LINE_CAP; i++) roads.push(road(0.6, 10 + i));
    roads.push(road(0.2, 5));
    s.rendering.rebuildHeatLines(roads);
    return s;
  })();
  const lines = items();
  assert.equal(lines.length, HEAT_LINE_CAP);
  assert.equal(lines[0].style.kind, 'glow', 'the jam line kept first');
  assert.equal(lines[1].widthPx, HEAT_LINE_SLOW_WIDTH);
  assert.equal(lines[1].positions[1].x, 10 + HEAT_LINE_CAP - 1);
});

test('mono presets draw heat-lines in luminance', () => {
  const { rendering, items } = setup({ preset: 'surveillance' });
  rendering.rebuildHeatLines([road(0.2), road(0.6)]);
  const [jam, slow] = items();
  assert.deepEqual(jam.style.color, [1, 1, 1, HEAT_JAM_BASE_ALPHA]);
  assert.deepEqual(slow.style.color, [0.7, 0.7, 0.7, HEAT_SLOW_COLOR[3]]);
});

test('no heat-lines in simulation or with the mode off, and removal empties the set', () => {
  for (const options of [{ live: false }, { heatline: false }]) {
    const { rendering, items, record } = setup(options);
    rendering.rebuildHeatLines([road(0.2)]);
    assert.equal(items().length, 0);
    assert.equal(record.writes, 0, 'an empty set is left alone');
    assert.equal(rendering.heatPulsing(), false);
  }
  const { state, rendering, items } = setup();
  rendering.rebuildHeatLines([road(0.2)]);
  rendering.removeHeatLines();
  assert.equal(items().length, 0);
  assert.equal(state._heatLineCount, 0);
  assert.equal(rendering.heatPulsing(), false);
  rendering.pulseHeatLines(0);
  assert.equal(items().length, 0, 'nothing to pulse');
});

test('heat-lines are asked for draped whatever the renderer, with no check of their own', () => {
  const { rendering, items } = setup();
  rendering.rebuildHeatLines([road(0.2)]);
  assert.equal(items().length, 1);
  assert.equal(items()[0].mode, 'draped');
});

test('lines stack as their per-bucket primitives were added: flow lines jam on top, heat-lines slow over jam', () => {
  const s = setup();
  const draw = fakeDrawPort();
  s.state._heatSet = draw.lines({ id: 'traffic:2:heat', clampTo: 'tiles' });
  s.state._heatOverSet = draw.lines({
    id: 'traffic:2:heat-over',
    clampTo: 'tiles',
  });
  const under = () => [...draw.set('traffic:2:heat').items.values()];
  const over = () => [...draw.set('traffic:2:heat-over').items.values()];
  const roads = [road(0.2, 50, 1), road(0.6, 80, 2), road(0.9, 90, 3)];

  // Heat-lines: jam in the set made first, slow in the one made after it.
  s.rendering.rebuildHeatLines(roads);
  assert.deepEqual(
    under().map((line) => line.style.kind),
    ['glow'],
  );
  assert.deepEqual(
    over().map((line) => line.widthPx),
    [HEAT_LINE_SLOW_WIDTH],
  );
  assert.equal(s.state._heatLineCount, 2);

  // Flow lines: one set, free first and jam last, as free, slow and jam
  // primitives were added; the slow set empties.
  s.state._showLines = true;
  s.rendering.rebuildHeatLines(roads);
  assert.deepEqual(
    under().map((line) => line.positions[0].x),
    [3, 2, 1],
  );
  assert.equal(over().length, 0);

  s.rendering.removeHeatLines();
  assert.equal(under().length + over().length, 0);
});
