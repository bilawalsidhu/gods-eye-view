import { createFakeEngine } from '../globe/testing/fakeEngine.js';
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
      const engine = createFakeEngine();
      engine.destroy = () => calls.push('destroy');
      return engine;
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
  const viewerTeardown = scene.indexOf(
    'if (!viewer.isDestroyed()) viewer.destroy();',
  );
  const engineAt = scene.indexOf('createSceneEngine(viewer, {');
  assert.ok(viewerTeardown >= 0 && engineAt >= 0);
  // Cleanups run last-in first-out: the engine goes before the viewer.
  assert.ok(engineAt > viewerTeardown, 'engine teardown must precede viewer');
  assert.match(scene, /tilesetRef\.current = tileset;/);
  assert.match(
    scene.replace(/\s+/g, ' '),
    /return \{ viewer, engine, tileset, mapStackController, operations, services,? \};/,
  );
});

test('the debug handle exposes the engine beside the viewer', () => {
  const tools = read('src/app/tools.js');
  // The handle belongs to the application; its globe fields are the
  // attached scene's.
  assert.match(tools, /window\.__godsEyeView = debug;/);
  assert.match(
    tools,
    /Object\.assign\(debug, \{\n\s+viewer: next\.viewer \?\? null,\n\s+engine: next\.engine,/,
  );
});
