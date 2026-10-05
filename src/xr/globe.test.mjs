import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGlobe } from './globe.js';
import { LAYERS } from './data.js';

test('Earth occludes far-side contacts and disabled instances cannot be picked', async () => {
  // Geometry and picking need no browser texture. An aborted texture load
  // leaves the procedural sphere intact, as it would during page teardown.
  const signal = AbortSignal.abort();
  const scene = new THREE.Scene(); let inspected;
  const globe = createGlobe({ scene, signal, onSelect: record => { inspected = record; }, onStatus() {} });
  globe.focus(0, -90);
  const front = { id: 'front', lat: 0, lon: -90, layer: 'earthquakes' };
  const back = { id: 'back', lat: 0, lon: 90, layer: 'earthquakes' };
  const states = Object.fromEntries(LAYERS.map(layer => [layer.id, { enabled: layer.id === 'earthquakes', records: layer.id === 'earthquakes' ? [front, back] : [] }]));
  globe.sync(Object.fromEntries(LAYERS.map(layer => [layer.id, { enabled: false, records: [] }])));
  // Prime Three's picking caches while every feed is still empty.
  scene.updateMatrixWorld(true);
  new THREE.Raycaster(new THREE.Vector3(0, 1.3, 1), new THREE.Vector3(0, 0, -1)).intersectObjects(globe.targets, false);
  globe.sync(states); scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 1.3, 1), new THREE.Vector3(0, 0, -1));
  let hit = ray.intersectObjects(globe.targets, false)[0];
  assert.equal(globe.selectHit(hit), true); assert.equal(inspected.id, 'front');
  states.earthquakes.records = [back]; globe.sync(states);
  hit = ray.intersectObjects(globe.targets, false)[0];
  assert.equal(hit.object, globe.sphere); assert.equal(globe.selectHit(hit), false);
  states.earthquakes.records = [front]; globe.sync(states);
  states.earthquakes.enabled = false; globe.sync(states);
  assert.equal(ray.intersectObjects(globe.targets, false)[0].object, globe.sphere);
  globe.dispose(); await Promise.resolve();
});
