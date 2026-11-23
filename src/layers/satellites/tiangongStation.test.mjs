// src/layers/satellites/tiangongStation.test.mjs — Tiangong's STATION
// description: every wing can be set apart from the others, and Automatic
// hands them all back to the Sun.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createTiangongArticulation,
  TIANGONG_ONE_AXIS_WINGS,
  TIANGONG_TWO_AXIS_WINGS,
} from './tiangongArticulation.js';
import { issAxisMatrix } from './issArticulation.js';
import { tiangongStationDescription } from './tiangongStation.js';
import { TIANGONG_NORAD } from './policy.js';

function recordingArticulation() {
  const calls = [];
  return {
    calls,
    setOverride: (fn) => calls.push(['override', fn === null ? null : 'fn']),
    setJoint: (node, pivot, axis, angle) => calls.push(['joint', node, angle]),
    resumeArm: (key) => calls.push(['resumeArm', key ?? null]),
    setWingAngle: (node, angle) => calls.push(['wing', node, angle]),
    resumeWings: () => calls.push(['resumeWings']),
  };
}

function description() {
  const layerState = {
    _trackedNorad: TIANGONG_NORAD,
    _catalog: new Map([[TIANGONG_NORAD, { name: 'CSS (TIANHE)' }]]),
    _points: new Map(),
    _trackedFrameCartesian: null,
  };
  const parts = { tiangongModel: { _articulation: null } };
  return tiangongStationDescription({ state: layerState, parts });
}

test('the description offers one slider per wing joint: two on Tianhe, eight on the labs', () => {
  const d = description();
  const tianhe = d.groups.find((g) => g.id === 'tianhe-wings');
  const labs = d.groups.find((g) => g.id === 'lab-wings');
  assert.equal(tianhe.kind, 'sliders');
  assert.deepEqual(
    tianhe.sliders.map((s) => s.id),
    TIANGONG_ONE_AXIS_WINGS.slice(0, 2).map((w) => w.node),
  );
  assert.equal(labs.sliders.length, 8);
  assert.deepEqual(
    labs.sliders.map((s) => s.id),
    TIANGONG_TWO_AXIS_WINGS.flatMap((p) => [p.alpha.node, p.beta.node]),
  );
  const labels = new Set(labs.sliders.map((s) => s.label));
  assert.equal(labels.size, 8, 'every lab slider has a label of its own');
  for (const slider of [...tianhe.sliders, ...labs.sliders]) {
    assert.equal(slider.min, -180);
    assert.equal(slider.max, 180);
  }
  // The arms are still there, after the wings.
  assert.deepEqual(
    d.groups.map((g) => g.id),
    ['sun', 'tianhe-wings', 'lab-wings', 'cmm', 'emm'],
  );
});

test('a wing slider sets that wing alone, in radians; the group resume frees them all', () => {
  const d = description();
  const a = recordingArticulation();
  const labs = d.groups.find((g) => g.id === 'lab-wings');
  labs.sliders[3].apply(a, 90);
  assert.deepEqual(a.calls, [['wing', labs.sliders[3].id, Math.PI / 2]]);
  labs.resumeApply(a);
  assert.deepEqual(a.calls.at(-1), ['resumeWings']);
  assert.equal(labs.resume, 'Follow the Sun');
});

test('Automatic hands the Sun, the wings and the arms back', () => {
  const d = description();
  const a = recordingArticulation();
  d.automatic(a);
  assert.deepEqual(a.calls, [
    ['override', null],
    ['resumeWings'],
    ['resumeArm', null],
  ]);
});

/** A stand-in model whose nodes keep the last matrix written. */
function fakeModel() {
  const nodes = new Map();
  return {
    ready: true,
    nodes,
    getNode(name) {
      // Cesium's node clones the matrix it is given; the driver writes a
      // shared scratch matrix, so the stand-in must clone too.
      if (!nodes.has(name))
        nodes.set(name, {
          _matrix: null,
          get matrix() {
            return this._matrix;
          },
          set matrix(value) {
            this._matrix = Cesium.Matrix4.clone(value);
          },
        });
      return nodes.get(name);
    },
  };
}

test('the driver holds a wing set by hand at its angle while the others follow the Sun', () => {
  const driver = createTiangongArticulation();
  const model = fakeModel();
  const date = new Date('2026-11-13T12:00:00Z');
  const position = new Cesium.Cartesian3(6_780_000, 0, 0);
  const axes = { x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
  // A fixed Sun: the real one would fetch Cesium's Earth-orientation data.
  const fixed = { sun: [0, 0.6, 0.8], sunlit: true };
  driver.setOverride(() => fixed);
  driver.update(model, date, position, axes, 1000);
  const port = TIANGONG_ONE_AXIS_WINGS[0];
  const starboard = TIANGONG_ONE_AXIS_WINGS[1];
  const portBefore = Cesium.Matrix4.clone(model.getNode(port.node).matrix);
  const starboardBefore = Cesium.Matrix4.clone(
    model.getNode(starboard.node).matrix,
  );
  driver.setWingAngle(port.node, 1.2);
  // Long after the last frame: the step is not rate-limited.
  driver.update(model, date, position, axes, 11_000);
  const expected = issAxisMatrix(
    port.pivot,
    port.axis,
    1.2,
    new Cesium.Matrix4(),
  );
  assert.ok(
    Cesium.Matrix4.equalsEpsilon(
      model.getNode(port.node).matrix,
      expected,
      1e-9,
    ),
    'the port wing is at the set angle',
  );
  assert.ok(
    Cesium.Matrix4.equalsEpsilon(
      model.getNode(starboard.node).matrix,
      starboardBefore,
      1e-9,
    ),
    'the starboard wing kept its Sun angle (same Sun, same date)',
  );
  assert.equal(
    Cesium.Matrix4.equals(model.getNode(port.node).matrix, portBefore),
    false,
    'the set angle differs from the Sun angle',
  );
  driver.resumeWings();
  driver.update(model, date, position, axes, 21_000);
  assert.ok(
    Cesium.Matrix4.equalsEpsilon(
      model.getNode(port.node).matrix,
      portBefore,
      1e-9,
    ),
    'back to the Sun once freed',
  );
  // Null frees one wing on its own.
  driver.setWingAngle(port.node, 0.3);
  driver.setWingAngle(port.node, null);
  driver.update(model, date, position, axes, 31_000);
  assert.ok(
    Cesium.Matrix4.equalsEpsilon(
      model.getNode(port.node).matrix,
      portBefore,
      1e-9,
    ),
  );
});
