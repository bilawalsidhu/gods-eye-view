// Street Traffic road lines build one set at a time: rebuilds asked for while
// a set is building wait, and only the newest of them runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createTrafficDisplay } from './render/display.js';
import { createRendering } from './rendering.js';

/** A road with flow; `level` picks its bucket (0.1 jam, 0.6 slow, 1 free). */
function road(level = 1) {
  return {
    flow: { level, closure: false },
    segmentDist: [100],
    coords: [
      [-97.744, 30.267],
      [-97.742, 30.267],
    ],
  };
}

/** Ground sets whose readiness follows the simulated asynchronous build. */
function harness(t) {
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  const scene = [];
  const added = [];
  let linesOn = true;
  const createSet = engine.ground.createSet;
  engine.ground.createSet = (options) => {
    const set = createSet(options);
    const line = { ready: false, roads: 0 };
    scene.push(line);
    added.push(line);
    return {
      ...set,
      ready: () => line.ready,
      replace(items) {
        line.roads = items.length;
        set.replace(items);
      },
      destroy() {
        set.destroy();
        const index = scene.indexOf(line);
        if (index >= 0) scene.splice(index, 1);
      },
    };
  };
  const display = createTrafficDisplay(engine);
  const state = {
    _engine: engine,
    _display: display,
    _liveMode: true,
    _showLines: true,
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

test('rebuilds asked for while lines build do not start more builds', (t) => {
  const { rendering, scene, added, frame } = harness(t);
  rendering.rebuildHeatLines(roads(1));
  assert.equal(added.length, 1);
  // Progressive paints while the first set builds.
  for (const count of [2, 3, 4]) rendering.rebuildHeatLines(roads(count));
  frame({ built: false });
  assert.equal(added.length, 1, 'no build started during a build');
  assert.equal(scene.length, 1);
  assert.deepEqual(scene[0].roads, 1);
});

test('the newest rebuild asked for during a build is the one that runs', (t) => {
  const { state, rendering, scene, added, frame } = harness(t);
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

test('a rebuild with nothing building starts at once', (t) => {
  const { rendering, added, frame } = harness(t);
  rendering.rebuildHeatLines(roads(1));
  frame();
  rendering.rebuildHeatLines(roads(2));
  assert.deepEqual(
    added.map((line) => line.roads),
    [1, 2],
  );
});

test('turning lines off during a build removes them at once and drops the waiting rebuild', (t) => {
  const { state, rendering, scene, added, setLines, frame } = harness(t);
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

test('a rebuild right after a build finishes does not keep the lines that build replaced', (t) => {
  const { rendering, scene } = harness(t);
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

test('removing the lines drops the waiting rebuild', (t) => {
  const { state, rendering, scene, added, frame } = harness(t);
  rendering.rebuildHeatLines(roads(1));
  rendering.rebuildHeatLines(roads(2));
  rendering.removeHeatLines();
  assert.deepEqual(scene, []);
  assert.equal(state._heatPendingRoads, null);
  frame();
  assert.equal(added.length, 1);
});

test('a stream of rebuilds never leaves more than two sets in the scene, and ends with one', (t) => {
  const { rendering, scene, added, frame } = harness(t);
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
