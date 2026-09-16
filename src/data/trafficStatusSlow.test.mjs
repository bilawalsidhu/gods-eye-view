// src/data/trafficStatusSlow.test.mjs
// The status probe ANSWERS, but slowly. The first viewport load races flow
// application against the paint deadline (250 ms); a probe still in flight
// loses that race, the dots paint immediately in simulation white, and the
// late flow job recolors in place — which, keyless, is a no-op guard.
//
// Owns a dedicated module instance: the layer caches its status verdict once
// per process (`_flowStatusPromise`).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import trafficLayer from './traffic.js';

const STATUS_DELAY_MS = 600; // comfortably past the 250 ms paint deadline
const SETTLE_MS = STATUS_DELAY_MS + 1400; // debounce + both passes + the late probe
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const overpassFixture = () => ({
  elements: [
    {
      type: 'way', id: 1,
      tags: { highway: 'primary' },
      geometry: [
        { lat: 30.3, lon: -97.7 }, { lat: 30.302, lon: -97.698 }, { lat: 30.304, lon: -97.696 },
      ],
    },
  ],
});

function makeViewer() {
  const added = [];
  const removed = [];
  return {
    scene: {
      primitives: {
        add: (p) => { added.push(p); return p; },
        remove: (p) => {
          const i = added.indexOf(p);
          if (i >= 0) added.splice(i, 1);
          removed.push(p);
        },
      },
      groundPrimitives: {
        add: () => { throw new Error('ground primitives are live-mode only'); },
        remove: () => {},
      },
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender: new Cesium.Event(),
      sampleHeightSupported: true,
      sampleHeight: () => 12,
    },
    camera: {
      percentageChanged: 0.5,
      changed: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
      positionCartographic: Cesium.Cartographic.fromDegrees(-97.75, 30.25, 1000),
      positionWC: Cesium.Cartesian3.fromDegrees(-97.75, 30.25, 1000),
      computeViewRectangle: () => Cesium.Rectangle.fromDegrees(-97.9, 30.1, -97.6, 30.4),
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(-97.75, 30.25),
    },
    __added: added,
    __removed: removed,
  };
}

// Installed at module scope before any test runs; restored when the file ends.
const prevFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tomtom/status')) {
    await sleep(STATUS_DELAY_MS);
    return new Response(JSON.stringify({ hasKey: false }),
      { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/api/overpass')) {
    return new Response(JSON.stringify(overpassFixture()),
      { headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`status-slow harness: unexpected fetch ${u}`);
};
after(() => { globalThis.fetch = prevFetch; });

test('a slow status probe never blocks first paint', async (t) => {
  const viewer = makeViewer();
  t.after(() => { try { trafficLayer.destroy(viewer); } catch { /* unwound */ } });
  trafficLayer.init(viewer);
  trafficLayer.enable(viewer);

  // Inside the probe's shadow the layer is honestly "loading" — the flow
  // job has claimed the batch before its first await, from the tick the
  // debounced load starts.
  await sleep(450);
  const midStats = trafficLayer.getStats();
  assert.equal(midStats.loading, true, 'the in-flight probe holds the loading batch open');

  await sleep(SETTLE_MS - 450);
  const stats = trafficLayer.getStats();
  assert.ok(stats.count > 0, 'the paint deadline rendered dots without flow');
  assert.equal(stats.loading, false, 'everything settled after the probe landed');
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.error, null);
  assert.equal(stats.loadingLabel, 'SIMULATED — add TomTom key for live');
  assert.equal(stats.flowBuckets.sim, stats.count, 'late-recolor keeps every dot simulated');
});
