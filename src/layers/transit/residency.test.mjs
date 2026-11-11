import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTrack } from '../../data/contactPlayback.js';
import { createRendering } from './rendering.js';
import { createIngestion } from './ingestion.js';

function harness(t) {
  for (const name of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ]) {
    const previous = globalThis[name];
    globalThis[name] = class {};
    t.after(() => {
      if (previous === undefined) delete globalThis[name];
      else globalThis[name] = previous;
    });
  }
  const state = {
    _markers: new Cesium.BillboardCollection(),
    _animatedMarkers: new Cesium.BillboardCollection(),
    _moving: new Set(),
    _visible: new Set(),
    _heightDirty: new Set(),
    _vehicles: new Map(),
    _stylePreset: 'normal',
    _detectRevision: 0,
  };
  let lengthReads = 0;
  const clears = new Map();
  for (const collection of [state._markers, state._animatedMarkers]) {
    const getter = Object.getOwnPropertyDescriptor(
      Cesium.BillboardCollection.prototype,
      'length',
    ).get;
    Object.defineProperty(collection, 'length', {
      get() {
        lengthReads++;
        return getter.call(this);
      },
    });
    clears.set(collection, t.mock.method(collection, 'removeAll').mock);
    t.after(() => collection.destroy());
  }
  const services = { render: {}, credits: {} };
  const parts = {
    height: { releaseVehicle() {} },
    selection: {
      clearSelection() {
        state._selectedKey = null;
      },
    },
  };
  parts.rendering = createRendering({ state, services, parts });
  parts.ingestion = createIngestion({ state, services, parts });
  function add(key) {
    const entry = {
      key,
      mode: 'bus',
      courseDeg: 0,
      toCart: new Cesium.Cartesian3(1, 2, 3),
      surfaceReady: true,
      sample: { phase: 'playing', segmentSpeedMps: 1 },
      track: createTrack(),
    };
    parts.rendering.addMarker(key, entry);
    entry.marker.show = true;
    state._vehicles.set(key, entry);
    state._visible.add(entry);
    return entry;
  }
  return { state, parts, add, clears, lengthReads: () => lengthReads };
}

test('mass viewport release clears native pending references without compacting per marker', (t) => {
  const app = harness(t);
  const entries = Array.from({ length: 1024 }, (_, i) => app.add(String(i)));
  assert.ok(app.state._markers._billboardsToUpdate.length > 0);
  for (const entry of entries) app.parts.rendering.releaseMarker(entry);
  assert.equal(app.lengthReads(), 0);
  assert.equal(app.clears.get(app.state._markers).callCount(), 1);
  assert.equal(app.state._markers._billboardsToUpdate.length, 0);
  assert.equal(app.state._markers._billboards.length, 0);
  assert.equal(
    app.state._vehicles.size,
    entries.length,
    'viewport eviction preserves logical records',
  );
  assert.ok(entries.every((entry) => entry.track && entry.marker === null));
  // A repeated release must not decrement counts or clear another resident.
  app.parts.rendering.releaseMarker(entries[0]);
  const fresh = app.add('fresh');
  app.parts.rendering.releaseMarker(fresh);
  assert.equal(app.clears.get(app.state._markers).callCount(), 2);
});

test('motion migrations preserve picking and cached positions while emptying source queues', (t) => {
  const app = harness(t);
  const entries = Array.from({ length: 512 }, (_, i) => app.add(String(i)));
  for (const entry of entries) {
    entry.detectContact = { position: entry.marker.position };
    app.parts.rendering.schedulePlayback(entry);
    assert.equal(entry.markerCollection, app.state._animatedMarkers);
    assert.equal(entry.marker.id, entry.key);
    assert.equal(entry.detectContact.position, entry.marker.position);
  }
  assert.equal(app.clears.get(app.state._markers).callCount(), 1);
  assert.equal(app.state._markers._billboardsToUpdate.length, 0);
  for (const entry of entries) {
    entry.sample.phase = 'idle';
    app.parts.rendering.schedulePlayback(entry);
    assert.equal(entry.markerCollection, app.state._markers);
  }
  assert.equal(app.lengthReads(), 0);
  assert.equal(app.clears.get(app.state._animatedMarkers).callCount(), 1);
  assert.equal(app.state._animatedMarkers._billboardsToUpdate.length, 0);
});

test('ingestion eviction and bulk clear share marker ownership across reuse', (t) => {
  const app = harness(t);
  const first = app.add('first');
  const second = app.add('second');
  app.parts.rendering.schedulePlayback(first);
  app.parts.ingestion.removeVehicle(first.key);
  app.parts.ingestion.removeVehicle(second.key);
  assert.equal(app.state._moving.size, 0);
  assert.equal(first.markerCollection, null);
  assert.equal(app.state._markers._billboardsToUpdate.length, 0);
  assert.equal(app.state._animatedMarkers._billboardsToUpdate.length, 0);
  app.add('before-disable');
  app.parts.rendering.clearMarkers();
  const after = app.add('after-enable');
  app.parts.ingestion.removeVehicle(after.key);
  assert.equal(app.lengthReads(), 0);
  assert.equal(app.state._markers._billboards.length, 0);
  assert.equal(app.state._markers._billboardsToUpdate.length, 0);
});
