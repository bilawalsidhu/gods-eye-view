// A turned-off layer's draw commands must not stay reachable through Cesium's
// reused per-pass command arrays (src/sceneCommandRelease.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  installLayerReleaseTrim,
  trimStaleSceneCommands,
} from './sceneCommandRelease.js';

const frustum = (lists, counts) => ({
  commands: lists.map((list) => [...list]),
  indices: [...counts],
});

test('the main view keeps what the last frame drew and drops the stale tail', () => {
  const view = {
    frustumCommandsList: [frustum([['a', 'b', 'stale'], ['c'], []], [2, 1, 0])],
  };
  trimStaleSceneCommands({ _defaultView: view });
  assert.deepEqual(view.frustumCommandsList[0].commands, [
    ['a', 'b'],
    ['c'],
    [],
  ]);
  assert.deepEqual(view.frustumCommandsList[0].indices, [2, 1, 0]);
});

test('the offscreen pick view is emptied, since every pick rebuilds it', () => {
  const extents = [{ command: 'x' }, { command: 'y' }];
  const pick = {
    frustumCommandsList: [frustum([['p', 'q'], ['r']], [2, 1])],
    _commandExtents: extents,
  };
  trimStaleSceneCommands({
    _defaultView: { frustumCommandsList: [] },
    _picking: { _pickOffscreenView: pick },
  });
  assert.deepEqual(pick.frustumCommandsList[0].commands, [[], []]);
  assert.deepEqual(pick.frustumCommandsList[0].indices, [0, 0]);
  assert.deepEqual(
    extents.map((e) => e.command),
    [undefined, undefined],
  );
});

test('a layer disable renders one frame and trims after it', () => {
  const listeners = new Set();
  const postRender = new Set();
  const requests = [];
  const view = { frustumCommandsList: [frustum([['a', 'stale']], [1])] };
  const scene = {
    _defaultView: view,
    postRender: {
      addEventListener(fn) {
        postRender.add(fn);
        return () => postRender.delete(fn);
      },
    },
  };
  const uninstall = installLayerReleaseTrim({
    scene,
    dataManager: {
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    requestRender: (reason) => requests.push(reason),
  });
  const emit = (change) => listeners.forEach((fn) => fn(change));

  emit({ type: 'visibility', layerId: 'x', enabled: true });
  assert.equal(requests.length, 0, 'enabling trims nothing');
  emit({ type: 'visibility', layerId: 'x', enabled: false });
  emit({ type: 'visibility', layerId: 'y', enabled: false });
  assert.deepEqual(
    requests,
    ['layer-release-trim'],
    'one frame for back-to-back disables',
  );
  assert.equal(
    view.frustumCommandsList[0].commands[0].length,
    2,
    'not before the frame',
  );
  postRender.forEach((fn) => fn());
  assert.deepEqual(view.frustumCommandsList[0].commands, [['a']]);
  assert.equal(postRender.size, 0, 'the frame listener is one-shot');
  uninstall();
  assert.equal(listeners.size, 0);
});

// The workaround reads private Cesium fields. Pin the shape it relies on, and
// fail when Cesium starts clearing the tail itself so the module can go.
test('Cesium still reuses per-pass command arrays without clearing their tail', () => {
  const require = createRequire(import.meta.url);
  const enginePkg = require.resolve('@cesium/engine/package.json');
  const read = (rel) =>
    readFileSync(new URL(rel, pathToFileURL(enginePkg)), 'utf8');
  const scene = read('./Source/Scene/Scene.js');
  const view = read('./Source/Scene/View.js');
  const frustumCommands = read('./Source/Scene/FrustumCommands.js');
  const picking = read('./Source/Scene/Picking.js');
  // Every private field the trim reads. A rename would otherwise turn the
  // trim into a silent no-op (it reaches them through `?.` and `|| []`).
  assert.match(scene, /this\._picking = new Picking\(this\);/);
  assert.match(scene, /this\._defaultView = new View\(/);
  assert.match(picking, /this\._pickOffscreenView = new View\(/);
  assert.match(view, /this\.frustumCommandsList = \[\];/);
  assert.match(view, /frustumCommandsList\[n\]\.indices\[p\] = 0;/);
  assert.match(view, /this\._commandExtents = \[\];/);
  assert.match(
    frustumCommands,
    /this\.commands = commands;\s*this\.indices = indices;/,
  );
  // Cesium truncates only the voxel, Gaussian-splat and translucent passes,
  // each in its own draw step; the opaque and other passes keep their tail.
  // A change here means Cesium's handling moved: re-check whether this
  // module is still needed.
  assert.doesNotMatch(
    view,
    /\.length\s*=\s*[^;]*indices\[/,
    'View.js now truncates the per-pass arrays: remove src/sceneCommandRelease.js',
  );
  assert.deepEqual(
    [
      ...scene.matchAll(
        /commands\.length = frustumCommands\.indices\[Pass\.(\w+)\];/g,
      ),
    ].map((match) => match[1]),
    ['VOXELS', 'GAUSSIAN_SPLATS', 'TRANSLUCENT'],
    'Scene.js truncates a different set of passes: re-check src/sceneCommandRelease.js',
  );
});
