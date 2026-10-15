import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSceneEngine } from './globeEngine.js';
import { createCesiumEngine } from '../globe/cesium/createCesiumEngine.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the scene engine is built on the viewer and destroyed by the scene lifetime', () => {
  const viewer = { name: 'viewer' };
  const tilesetRef = { current: null };
  const cleanups = [];
  const calls = [];
  const engine = createSceneEngine(viewer, {
    tilesetRef,
    defer: (dispose) => cleanups.push(dispose),
    createEngine(target, options) {
      calls.push([target, options]);
      return { kind: 'cesium', destroy: () => calls.push('destroy') };
    },
  });
  assert.equal(engine.kind, 'cesium');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], viewer);
  assert.equal(calls[0][1].tilesetRef, tilesetRef);
  assert.equal(cleanups.length, 1, 'engine teardown is deferred at once');
  cleanups[0]();
  assert.equal(calls.at(-1), 'destroy');
});

test('the scene engine defaults to the Cesium engine factory', () => {
  assert.throws(
    () => createSceneEngine({}, { tilesetRef: null, defer: () => {} }),
    /createCesiumEngine needs a viewer/,
  );
  assert.equal(typeof createCesiumEngine, 'function');
});

test('the scene constructs the engine with the viewer and returns it beside the viewer', () => {
  const scene = read('src/app/scene.js');
  const viewerTeardown = scene.indexOf('uninstallRenderGovernor(viewer);');
  const engineAt = scene.indexOf('createSceneEngine(viewer, {');
  assert.ok(viewerTeardown >= 0 && engineAt >= 0);
  // Cleanups run last-in first-out: the engine goes before the viewer.
  assert.ok(engineAt > viewerTeardown, 'engine teardown must precede viewer');
  assert.match(scene, /tilesetRef\.current = tileset;/);
  assert.match(
    scene,
    /return \{ viewer, engine, tileset, mapStackController, operations \};/,
  );
});

test('the debug handle exposes the engine beside the viewer', () => {
  const tools = read('src/app/tools.js');
  assert.match(
    tools,
    /const \{ viewer, engine, tileset, mapStackController, operations \} = scene;/,
  );
  assert.match(tools, /window\.__godsEyeView = \{\n\s+viewer,\n\s+engine,/);
});

test('the scene engine is the one engineFromViewer returns for its viewer until teardown', async () => {
  const { engineFromViewer } =
    await import('../globe/cesium/engineFromViewer.js');
  const { createFakeEngine } = await import('../globe/testing/fakeEngine.js');
  const viewer = { name: 'viewer' };
  const cleanups = [];
  const engine = createSceneEngine(viewer, {
    tilesetRef: null,
    defer: (dispose) => cleanups.push(dispose),
    createEngine: () => createFakeEngine(),
  });
  assert.equal(engineFromViewer(viewer), engine);
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(engine.fake.destroyed, true);
  assert.throws(
    () => engineFromViewer(viewer),
    /createCesiumEngine needs a viewer/,
    'no longer registered: a fresh one would be built',
  );
});
