// src/data/trafficStatusDown.test.mjs
// The status probe itself fails: `/api/tomtom/status` is unreachable. The
// layer must simulate honestly — and distinguish "the server says no key"
// from "we could not ask" (`SIMULATED — traffic service unreachable`).
//
// Owns a dedicated module instance: the layer caches its status verdict once
// per process (`_flowStatusPromise`), so this session can never share a file
// with a session whose probe succeeded.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import trafficLayer from './traffic.js';

const SETTLE_MS = 500; // 320 ms debounce + the failing probe + the failed load
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const overpassFixture = () => ({
  elements: [
    {
      type: 'way', id: 1,
      tags: { highway: 'motorway', oneway: 'yes' },
      geometry: [
        { lat: 30.2, lon: -97.8 }, { lat: 30.22, lon: -97.78 }, { lat: 30.24, lon: -97.76 },
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

// Installed at module scope: the layer's single status probe fires on the
// first enable, and every fetch in this process must flow through this
// router. Restored when the file ends.
const prevFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tomtom/status')) {
    return new Response('status probe down', { status: 503 });
  }
  if (u.includes('/api/overpass')) {
    return new Response(JSON.stringify(overpassFixture()),
      { headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`status-down harness: unexpected fetch ${u}`);
};
after(() => { globalThis.fetch = prevFetch; });

test('an unreachable status probe simulates with its own honest label', async (t) => {
  const viewer = makeViewer();
  t.after(() => { try { trafficLayer.destroy(viewer); } catch { /* unwound */ } });
  trafficLayer.init(viewer);
  trafficLayer.enable(viewer);

  await sleep(SETTLE_MS);
  const stats = trafficLayer.getStats();

  // The probe's own catch RESOLVES the cached verdict (it can never reject),
  // so the session degrades gracefully: simulation carries on, and the only
  // trace of the outage is the label — which must name could-not-ask, not
  // impersonate a plain keyless build.
  assert.ok(stats.count > 0, 'simulation renders while the status probe is down');
  assert.equal(stats.loading, false, 'the loads settled');
  assert.equal(stats.mode, 'sim', 'cannot-ask is simulation, not live');
  assert.equal(stats.error, null, 'a down probe is not a flow outage');
  assert.equal(stats.loadingLabel, 'SIMULATED — traffic service unreachable');
  assert.equal(stats.flowBuckets.sim, stats.count, 'every dot is simulated white');
});
