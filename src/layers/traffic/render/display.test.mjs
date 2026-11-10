// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { GROUND_HARNESSES } from '../../../testSupport/groundDisplayEngines.mjs';
import { Rgba, nearFarScale } from '../../shared/color.js';
import { createState } from '../state.js';
import { createStyle } from '../style.js';
import { createRendering } from '../rendering.js';
import {
  HEAT_JAM_BASE_ALPHA,
  HEAT_JAM_COLOR,
  HEAT_JAM_GLOW_POWER,
  HEAT_JAM_PULSE_ALPHA,
  HEAT_JAM_PULSE_PERIOD_MS,
  HEAT_LINE_JAM_WIDTH,
  HEAT_LINE_SLOW_WIDTH,
  HEAT_SLOW_COLOR,
  MAX_DOTS,
  SIM_DOT_COLOR,
} from '../policy.js';
import {
  TRAFFIC_SET_IDS as IDS,
  createTrafficDisplay,
  nearFarValue,
} from './display.js';

// GroundPolylinePrimitive checks its render state's line width against the
// context's limits, which a stub scene has none of.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;

const CAMERA_M = 1000;
const near = (actual, expected, label, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `${label}: ${actual} vs ${expected}`,
  );
const nearAll = (actual, expected, label, epsilon = 1e-6) =>
  expected.forEach((value, index) =>
    near(actual[index], value, `${label}[${index}]`, epsilon),
  );

// A mover set's drawn instances on either engine: size in px, rgba, shown.
function drawn(h, id) {
  const listed = h.engine.movers.list().find((set) => set.id === id);
  if (!listed) return undefined;
  const rows = [];
  {
    const { store, options } = h.engine.fake.moverSet(id);
    for (let i = 0; i < store.count; i++)
      rows.push({
        sizePx: options.point.sizePx * store.scales[i],
        color: [...store.colors.slice(i * 4, i * 4 + 4)],
        shown: store.shows[i] === 1,
      });
  }
  return rows;
}

function fixture(t, makeHarness) {
  const h = makeHarness();
  t.after(() => h.destroy());
  // The camera straight above the dots, CAMERA_M up.
  h.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, CAMERA_M),
  });
  const display = createTrafficDisplay(h.engine);
  t.after(() => display.destroy());
  return { h, display };
}

// A dot's look as the layer writes it (animation.js spawnDotsForRoad).
function dot(fields = {}) {
  return {
    point: {
      position: geo.cartesian3.fromDegrees(0, 0, 0),
      pixelSize: 5,
      color: SIM_DOT_COLOR,
      show: true,
      scaleByDistance: nearFarScale(100, 1.5, 8000, 0.3),
      translucencyByDistance: nearFarScale(100, 1, 10000, 0),
      outlineColor: null,
      outlineWidth: 0,
      ...fields,
    },
  };
}

test('distance scalars interpolate over the squared distance, eased by ^0.2, and clamp', () => {
  const scalar = nearFarScale(100, 1.5, 8000, 0.3);
  assert.equal(nearFarValue(null, 5000), 1);
  assert.equal(nearFarValue(scalar, 50), 1.5);
  assert.equal(nearFarValue(scalar, 100), 1.5);
  near(nearFarValue(scalar, 8000), 0.3, 'far');
  near(nearFarValue(scalar, 20000), 0.3, 'beyond far');
  const t = Math.pow((1000 ** 2 - 100 ** 2) / (8000 ** 2 - 100 ** 2), 0.2);
  near(nearFarValue(scalar, 1000), 1.5 + (0.3 - 1.5) * t, 'between');
});

for (const makeHarness of GROUND_HARNESSES) {
  const name = makeHarness().name;

  test(`vehicles are two depth-tested point sets, outline under fill, never picked (${name})`, (t) => {
    const { h } = fixture(t, makeHarness);
    const sets = h.engine.movers.list();
    assert.deepEqual(
      sets.map(({ id }) => id),
      [IDS.outline, IDS.fill],
    );
    for (const [index, id] of [IDS.outline, IDS.fill].entries()) {
      const { options } = h.engine.fake.moverSet(id);
      assert.equal(
        sets.find((set) => set.id === id).capacity,
        MAX_DOTS,
        `${id} capacity`,
      );
      if (options) {
        assert.equal(options.kind, 'point');
        assert.equal(options.order, index);
        assert.equal(options.depthTest, 'normal');
        assert.equal(options.pickable, false);
        assert.equal(options.point.sizePx, 1);
        assert.equal(options.point.outlinePx, 0);
      }
    }
  });

  test(`each dot is sized and faded by its camera distance, its outline a wider disc under it (${name})`, (t) => {
    const { h, display } = fixture(t, makeHarness);
    const outline = new Rgba(0, 0, 0, 0.9);
    const jam = new Rgba(1, 0.2, 0.2, 0.9);
    display.drawDots([
      dot(),
      dot({
        pixelSize: 7,
        color: jam,
        outlineColor: outline,
        outlineWidth: 2,
        scaleByDistance: nearFarScale(100, 1.5, 8000, 0.55),
      }),
    ]);
    const distance = geo.cartesian3.distance(
      h.engine.camera.livePosition,
      geo.cartesian3.fromDegrees(0, 0, 0),
    );
    near(distance, CAMERA_M, 'camera distance', 1e-3);
    const fade = nearFarValue(nearFarScale(100, 1, 10000, 0), distance);
    const simScale = nearFarValue(nearFarScale(100, 1.5, 8000, 0.3), distance);
    const jamScale = nearFarValue(nearFarScale(100, 1.5, 8000, 0.55), distance);
    const fills = drawn(h, IDS.fill);
    assert.equal(fills.length, 2);
    near(fills[0].sizePx, 5 * simScale, 'sim size', 1e-4);
    nearAll(
      fills[0].color,
      [1, 1, 1, 0.85 * fade],
      'sim colour (white 0.85, faded)',
      1e-6,
    );
    near(fills[1].sizePx, 7 * jamScale, 'jam size', 1e-4);
    nearAll(fills[1].color, [1, 0.2, 0.2, 0.9 * fade], 'jam colour', 1e-6);
    // Cesium: pixelSize plus outlineWidth on each side, scaled as a whole.
    const outlines = drawn(h, IDS.outline);
    assert.equal(outlines.length, 1, 'only the outlined dot has an outline');
    near(outlines[0].sizePx, (7 + 2 * 2) * jamScale, 'outline size', 1e-4);
    nearAll(outlines[0].color, [0, 0, 0, 0.9 * fade], 'outline colour', 1e-6);
  });

  test(`hidden, zero-size, faded-out and over-the-horizon dots draw nothing (${name})`, (t) => {
    const { h, display } = fixture(t, makeHarness);
    const outline = { outlineColor: new Rgba(0, 0, 0, 0.9), outlineWidth: 2 };
    display.drawDots([
      dot({ show: false, ...outline }),
      dot({ pixelSize: 0, ...outline }),
      dot({ translucencyByDistance: nearFarScale(100, 1, 200, 0) }),
      dot({ position: geo.cartesian3.fromDegrees(180, 0, 0), ...outline }),
      dot(),
    ]);
    assert.equal(drawn(h, IDS.fill).length, 1);
    assert.equal(drawn(h, IDS.outline).length, 0);
    // The population empties: one write of nothing.
    display.drawDots([]);
    assert.equal(drawn(h, IDS.fill).length, 0);
  });

  test(`hiding the vehicles clears them until shown and drawn again (${name})`, (t) => {
    const { h, display } = fixture(t, makeHarness);
    const dots = [dot(), dot()];
    display.drawDots(dots);
    assert.equal(drawn(h, IDS.fill).length, 2);
    display.show(false);
    assert.equal(drawn(h, IDS.fill).length, 0);
    display.drawDots(dots);
    assert.equal(drawn(h, IDS.fill).length, 0, 'hidden: nothing draws');
    display.show(true);
    display.drawDots(dots);
    assert.equal(drawn(h, IDS.fill).length, 2);
  });

  test(`heat lines are corridors draped on 3D tiles, jam under slow, one per road (${name})`, (t) => {
    const { h, display } = fixture(t, makeHarness);
    const roads = [
      {
        coords: [
          [0, 0],
          [0.001, 0],
        ],
      },
      {
        coords: [
          [0, 0.001],
          [0.001, 0.001],
          [0.002, 0.002],
        ],
      },
    ];
    display.setHeat('jam', roads, { color: [1, 0, 0, 0.55], widthPx: 9 });
    display.setHeat('slow', roads.slice(1), {
      color: [1, 0.7, 0.2, 0.2],
      widthPx: 4,
    });
    display.setHeat('slow', [], { color: [1, 0.7, 0.2, 0.2], widthPx: 4 });
    assert.equal(h.set(IDS.slow), undefined, 'no roads: no set');
    display.setHeat('slow', roads.slice(1), {
      color: [1, 0.7, 0.2, 0.2],
      widthPx: 4,
    });
    const jam = h.set(IDS.jam);
    const slow = h.set(IDS.slow);
    for (const [set, order] of [
      [jam, 0],
      [slow, 1],
    ]) {
      assert.equal(set.options.kind, 'corridor');
      assert.equal(set.options.drape, 'tiles');
      assert.equal(set.options.pickable, false);
      assert.equal(set.options.order, order);
      assert.equal(set.shown, true);
    }
    assert.equal(jam.items.length, 2);
    assert.deepEqual(jam.items[1].positions, roads[1].coords);
    assert.equal(jam.items[0].widthPx, 9);
    assert.deepEqual(jam.items[0].color, [1, 0, 0, 0.55]);
    assert.equal(slow.items.length, 1);
    assert.equal(slow.items[0].widthPx, 4);

    display.clearHeat();
    assert.equal(h.set(IDS.jam), undefined);
    assert.equal(h.set(IDS.slow), undefined);
  });

  test(`the layer's heat lines: jam red, glowing and pulsing about its base alpha, slow amber; mono presets in grey (${name})`, (t) => {
    const { h, display } = fixture(t, makeHarness);
    const state = createState({ services: {} });
    Object.assign(state, {
      _display: display,
      _liveMode: true,
      _jamViz: 'heatline',
    });
    const parts = {};
    const context = { state, services: {}, parts, source: {} };
    parts.style = createStyle(context);
    parts.rendering = createRendering(context);
    const road = (level, offset, metres) => ({
      flow: { level, closure: false },
      coords: [
        [offset, 0],
        [offset + 0.001, 0],
      ],
      segmentDist: [metres],
    });
    const roads = [
      road(0.9, 0, 100),
      road(0.7, 0.01, 100),
      road(0.1, 0.02, 50),
      road(0.1, 0.03, 300),
      { ...road(0.1, 0.04, 100), flow: { level: 0.1, closure: true } },
    ];
    parts.rendering.rebuildHeatLines(roads);
    const jam = h.set(IDS.jam);
    const slow = h.set(IDS.slow);
    assert.equal(jam.items.length, 2, 'jam roads, the closure left out');
    assert.deepEqual(
      jam.items.map((item) => item.positions[0][0]),
      [0.03, 0.02],
      'longest first',
    );
    nearAll(
      jam.items[0].color,
      [...HEAT_JAM_COLOR.rgba().slice(0, 3), 1],
      'jam colour',
    );
    assert.equal(jam.items[0].widthPx, HEAT_LINE_JAM_WIDTH);
    // Cesium's PolylineGlow at glowPower 0.25, its alpha 0.55 ± 0.2 on
    // sin(now / 260 ms).
    assert.deepEqual(jam.items[0].glow, { power: HEAT_JAM_GLOW_POWER });
    assert.equal(HEAT_JAM_GLOW_POWER, 0.25);
    near(HEAT_JAM_PULSE_PERIOD_MS, 2 * Math.PI * 260, 'pulse period');
    nearAll(
      [jam.items[0].pulse.min, jam.items[0].pulse.max],
      [
        HEAT_JAM_BASE_ALPHA - HEAT_JAM_PULSE_ALPHA,
        HEAT_JAM_BASE_ALPHA + HEAT_JAM_PULSE_ALPHA,
      ],
      'pulse',
    );
    assert.equal(jam.items[0].pulse.periodMs, HEAT_JAM_PULSE_PERIOD_MS);
    assert.equal(slow.items[0].glow, undefined, 'slow lines are flat');
    assert.equal(slow.items[0].pulse, undefined);
    assert.equal(
      h.engine.ground.list().find(({ id }) => id === IDS.jam).animated,
      true,
    );

    assert.equal(slow.items.length, 1);
    nearAll(slow.items[0].color, HEAT_SLOW_COLOR.rgba(), 'slow colour');
    assert.equal(slow.items[0].widthPx, HEAT_LINE_SLOW_WIDTH);
    assert.equal(state._heatLineCount, 3);
    // NVG and the other mono presets re-encode in luminance.
    state._stylePreset = 'surveillance';
    parts.rendering.rebuildHeatLines(roads);
    nearAll(h.set(`${IDS.jam}-1`).items[0].color, [1, 1, 1, 1], 'mono jam');
    nearAll(
      h.set(`${IDS.slow}-1`).items[0].color,
      [0.7, 0.7, 0.7, HEAT_SLOW_COLOR.alpha],
      'mono slow',
    );
    // Heat lines off: none drawn.
    state._jamViz = 'density';
    parts.rendering.rebuildHeatLines(roads);
    assert.equal(h.set(IDS.jam), undefined);
    assert.equal(h.set(`${IDS.jam}-1`), undefined);
    assert.equal(state._heatLineCount, 0);
  });

  test(`flow lines cover all buckets, keep their draw order and never pulse (${name})`, (t) => {
    const { h, display } = fixture(t, makeHarness);
    const state = createState({ services: {} });
    Object.assign(state, {
      _engine: h.engine,
      _display: display,
      _liveMode: true,
      _showLines: true,
    });
    const parts = {};
    const context = { state, services: {}, parts, source: {} };
    parts.style = createStyle(context);
    parts.rendering = createRendering(context);
    const roads = [0.1, 0.6, 1].map((level, i) => ({
      flow: { level, closure: false },
      coords: [
        [i, 0],
        [i + 0.001, 0],
      ],
      segmentDist: [100],
    }));
    parts.rendering.rebuildHeatLines(roads);
    for (const [order, bucket] of ['free', 'slow', 'jam'].entries()) {
      const set = h.set(IDS[bucket]);
      assert.equal(set.options.order, order);
      assert.equal(set.options.drape, 'both');
      assert.equal(set.items.length, 1);
      assert.equal(set.items[0].widthPx, 4);
      nearAll(
        set.items[0].color,
        [...state._activeBucketColors[bucket].rgba().slice(0, 3), 0.8],
        bucket,
      );
      assert.equal(set.items[0].pulse, undefined);
      assert.equal(set.items[0].glow, undefined);
    }
    state._stylePreset = 'surveillance';
    parts.rendering.rebuildHeatLines(roads);
    for (const [bucket, level] of [
      ['jam', 1],
      ['slow', 0.7],
      ['free', 0.45],
    ])
      nearAll(
        h.set(`${IDS[bucket]}-1`).items[0].color,
        [level, level, level, 0.8],
        bucket,
      );
    parts.rendering.removeHeatLines();
    assert.equal(h.sets(), 0);
  });

  test(`heights are sampled through the vehicle sets, and destroy removes every set (${name})`, (t) => {
    const { h, display } = fixture(t, makeHarness);
    const excluded = display.excluded();
    assert.equal(excluded.length, 2);
    display.setHeat(
      'jam',
      [
        {
          coords: [
            [0, 0],
            [0.001, 0],
          ],
        },
      ],
      {
        color: [1, 0, 0, 0.55],
        widthPx: 9,
      },
    );
    display.drawDots([dot()]);
    display.destroy();
    display.destroy();
    assert.equal(h.engine.movers.list().length, 0);
    assert.equal(h.sets(), 0);
    assert.deepEqual(display.excluded(), []);
    display.drawDots([dot()]);
    display.setHeat(
      'slow',
      [
        {
          coords: [
            [0, 0],
            [0.001, 0],
          ],
        },
      ],
      {
        color: [1, 1, 1, 1],
        widthPx: 4,
      },
    );
    assert.equal(h.sets(), 0, 'nothing draws after destroy');
  });
}
