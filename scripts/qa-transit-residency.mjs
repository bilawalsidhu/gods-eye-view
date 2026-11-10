import * as Cesium from 'cesium';
import { createRendering } from '../src/layers/transit/rendering.js';

// Native collections, no WebGL: measure marker ownership work independently of
// rasterization. Run with Node 24: node scripts/qa-transit-residency.mjs.
for (const name of [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'ImageBitmap',
  'OffscreenCanvas',
])
  globalThis[name] ??= class {};

function sample(count, migrate) {
  const state = {
    _markers: new Cesium.BillboardCollection(),
    _animatedMarkers: new Cesium.BillboardCollection(),
    _moving: new Set(),
    _visible: new Set(),
    _stylePreset: 'normal',
  };
  let lengthReads = 0,
    compactedSlots = 0;
  const length = Object.getOwnPropertyDescriptor(
    Cesium.BillboardCollection.prototype,
    'length',
  ).get;
  for (const collection of [state._markers, state._animatedMarkers])
    Object.defineProperty(collection, 'length', {
      get() {
        lengthReads++;
        if (this._billboardsRemoved) compactedSlots += this._billboards.length;
        return length.call(this);
      },
    });
  const rendering = createRendering({
    state,
    parts: {},
    services: { render: {} },
  });
  const entries = Array.from({ length: count }, (_, key) => {
    const entry = {
      key: String(key),
      mode: 'bus',
      courseDeg: 0,
      toCart: new Cesium.Cartesian3(1, 2, 3),
      surfaceReady: true,
      sample: { phase: 'playing', segmentSpeedMps: 1 },
    };
    rendering.addMarker(entry.key, entry);
    entry.marker.show = true;
    state._visible.add(entry);
    return entry;
  });
  const started = performance.now();
  for (const entry of entries)
    if (migrate) rendering.schedulePlayback(entry);
    else rendering.releaseMarker(entry);
  const elapsedMs = performance.now() - started;
  const pendingAfter = state._markers._billboardsToUpdate.length;
  state._markers.destroy();
  state._animatedMarkers.destroy();
  return { elapsedMs, lengthReads, compactedSlots, pendingAfter };
}

for (const migrate of [false, true]) {
  sample(256, migrate);
  for (const count of [4096, 8192]) {
    const runs = Array.from({ length: 5 }, () => sample(count, migrate));
    const timings = runs.map((run) => run.elapsedMs).sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        operation: migrate ? 'migrate' : 'release',
        count,
        medianMs: +timings[2].toFixed(3),
        minMs: +timings[0].toFixed(3),
        maxMs: +timings[4].toFixed(3),
        lengthReads: runs[0].lengthReads,
        compactedSlots: runs[0].compactedSlots,
        pendingAfter: runs[0].pendingAfter,
      }),
    );
  }
}
