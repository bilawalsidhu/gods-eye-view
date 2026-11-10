// Street Traffic road lines build one set at a time: rebuilds asked for while
// a set is building wait, and only the newest of them runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createRendering } from './rendering.js';

// Cesium tests a material's uniforms against these browser classes.
for (const name of [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'ImageBitmap',
  'OffscreenCanvas',
])
  globalThis[name] ??= class {};
// A line primitive's render state is checked against the context's limits,
// which only a WebGL context sets.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 1;

/** A road with flow; `level` picks its bucket (0.1 jam, 0.6 slow, 1 free). */
function road(level = 1) {
  return {
    flow: { level, closure: false },
    segmentDist: [100],
    waypoints: Cesium.Cartesian3.fromDegreesArray([
      -97.744, 30.267, -97.742, 30.267,
    ]),
  };
}

/**
 * Rendering over a scene that records its ground primitives. Each added
 * primitive is replaced by a stand-in whose `ready` the test sets, as Cesium
 * sets it once the asynchronous geometry is built.
 */
function harness() {
  const scene = [];
  const added = [];
  let linesOn = true;
  const state = {
    _viewer: {
      scene: {
        globe: { show: true },
        groundPrimitives: {
          add(primitive) {
            const line = {
              ready: false,
              roads: primitive.geometryInstances.length,
            };
            scene.push(line);
            added.push(line);
            return line;
          },
          remove(line) {
            const index = scene.indexOf(line);
            if (index >= 0) scene.splice(index, 1);
          },
        },
      },
    },
    _liveMode: true,
    _showLines: true,
    _heatSupported: true,
    _heatJamPrim: null,
    _heatSlowPrim: null,
    _heatFreePrim: null,
    _heatRetired: [],
    _heatPendingRoads: null,
    _heatLineCount: 0,
  };
  const rendering = createRendering({
    state,
    services: {},
    source: {},
    parts: {
      style: { heatlineOn: () => linesOn },
      animation: { syncRenderDemand() {} },
    },
  });
  return {
    state,
    rendering,
    scene,
    added,
    setLines(on) {
      linesOn = on;
      state._showLines = on;
    },
    /** Finish every build in the scene, then run a frame. */
    frame({ built = true } = {}) {
      if (built) for (const line of scene) line.ready = true;
      rendering.retireHeatLines();
    },
  };
}

const roads = (count) => Array.from({ length: count }, () => road());

test('rebuilds asked for while lines build do not start more builds', () => {
  const { rendering, scene, added, frame } = harness();
  rendering.rebuildHeatLines(roads(1));
  assert.equal(added.length, 1);
  // Progressive paints while the first set builds.
  for (const count of [2, 3, 4]) rendering.rebuildHeatLines(roads(count));
  frame({ built: false });
  assert.equal(added.length, 1, 'no build started during a build');
  assert.equal(scene.length, 1);
  assert.deepEqual(scene[0].roads, 1);
});

test('the newest rebuild asked for during a build is the one that runs', () => {
  const { state, rendering, scene, added, frame } = harness();
  rendering.rebuildHeatLines(roads(1));
  for (const count of [2, 3, 4]) rendering.rebuildHeatLines(roads(count));
  frame();
  // One build for the three requests, of the last one's roads.
  assert.deepEqual(
    added.map((line) => line.roads),
    [1, 4],
  );
  assert.equal(state._heatLineCount, 4);
  assert.equal(state._heatPendingRoads, null);
  // The set it replaces stays drawn while it builds, then goes.
  assert.deepEqual(
    scene.map((line) => line.roads),
    [1, 4],
  );
  frame();
  assert.deepEqual(
    scene.map((line) => line.roads),
    [4],
  );
  // Nothing is waiting, so later frames start nothing.
  frame();
  assert.equal(added.length, 2);
});

test('a rebuild with nothing building starts at once', () => {
  const { rendering, added, frame } = harness();
  rendering.rebuildHeatLines(roads(1));
  frame();
  rendering.rebuildHeatLines(roads(2));
  assert.deepEqual(
    added.map((line) => line.roads),
    [1, 2],
  );
});

test('turning lines off during a build removes them at once and drops the waiting rebuild', () => {
  const { state, rendering, scene, added, setLines, frame } = harness();
  rendering.rebuildHeatLines(roads(1));
  frame();
  rendering.rebuildHeatLines(roads(2));
  rendering.rebuildHeatLines(roads(3));
  assert.equal(scene.length, 2, 'the drawn set and the building one');
  setLines(false);
  rendering.rebuildHeatLines(roads(3));
  assert.deepEqual(scene, [], 'not deferred behind the build');
  assert.equal(state._heatPendingRoads, null);
  assert.equal(state._heatLineCount, 0);
  frame();
  assert.equal(added.length, 2, 'the waiting rebuild never runs');
  assert.deepEqual(scene, []);
});

test('a rebuild right after a build finishes does not keep the lines that build replaced', () => {
  const { rendering, scene } = harness();
  rendering.rebuildHeatLines(roads(1));
  for (const line of scene) line.ready = true;
  rendering.rebuildHeatLines(roads(2));
  // The second build finishes, and a third is asked for before a frame ran.
  for (const line of scene) line.ready = true;
  rendering.rebuildHeatLines(roads(3));
  assert.deepEqual(
    scene.map((line) => line.roads),
    [2, 3],
  );
});

test('removing the lines drops the waiting rebuild', () => {
  const { state, rendering, scene, added, frame } = harness();
  rendering.rebuildHeatLines(roads(1));
  rendering.rebuildHeatLines(roads(2));
  rendering.removeHeatLines();
  assert.deepEqual(scene, []);
  assert.equal(state._heatPendingRoads, null);
  frame();
  assert.equal(added.length, 1);
});

test('a stream of rebuilds never leaves more than two sets in the scene, and ends with one', () => {
  const { rendering, scene, added, frame } = harness();
  let most = 0;
  const lines = [road(0.1), road(0.6), road(1)];
  // Three primitives per set: one per flow bucket.
  for (let paint = 0; paint < 40; paint += 1) {
    rendering.rebuildHeatLines(lines);
    most = Math.max(most, scene.length);
    // A build takes several paints.
    if (paint % 5 === 4) frame();
    else frame({ built: false });
    most = Math.max(most, scene.length);
  }
  frame();
  frame();
  assert.equal(most <= 6, true, `${most} primitives at once`);
  assert.equal(scene.length, 3, 'only the current set remains');
  assert.equal(
    scene.every((line) => line.ready),
    true,
  );
  // Without coalescing every paint builds: 40 sets, 120 primitives.
  assert.equal(
    added.length <= 3 * 10,
    true,
    `${added.length} primitives built`,
  );
});
