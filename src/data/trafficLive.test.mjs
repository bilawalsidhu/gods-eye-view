// src/data/trafficLive.test.mjs
// The live-key session: `/api/tomtom/status` answers `hasKey:true`, so the
// layer configures as LIVE — and when every covering flow tile 503s, the
// stats must degrade honestly instead of presenting a stale "LIVE · N% cov"
// over simulated white dots.
//
// This file exists apart from traffic.test.mjs because the layer caches its
// sim-vs-live verdict once per module instance (`_flowStatusPromise`): the
// keyless battery and this keyed session can never share a process.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import trafficLayer from './traffic.js';

/** The app's live markers — see traffic.test.mjs. */
const LIVE_CLAIM = /\bLIVE\b|\bGPS\b|\breal[- ]?time\b/;

const SETTLE_MS = 500; // 320 ms debounce + both proxy round-trips + flow race
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
    {
      type: 'way', id: 2,
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
  const viewer = {
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
        add: () => { throw new Error('heat lines are heatline-mode only'); },
        remove: () => {},
      },
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender: new Cesium.Event(),
      sampleHeightSupported: false,
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
  return viewer;
}

// Deliberately installed at module scope, before any test runs: the layer's
// single status probe fires on the first enable, and every fetch in this
// process must flow through this router. Restored when the file ends.
const flowCalls = [];
const globalsWithPrev = {};
const fetchImpl = async (url) => {
  const u = String(url);
  if (u.includes('/api/tomtom/status')) {
    return new Response(JSON.stringify({ hasKey: true }),
      { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/api/overpass')) {
    return new Response(JSON.stringify(overpassFixture()),
      { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/api/tomtom/flow/')) {
    flowCalls.push(u);
    return new Response('keyless proxy', { status: 503 });
  }
  throw new Error(`live harness: unexpected fetch ${u}`);
};
globalsWithPrev.fetch = globalThis.fetch;
globalThis.fetch = fetchImpl;
after(() => { globalThis.fetch = globalsWithPrev.fetch; });

test('a keyed session with a dead flow feed degrades honestly, live-configured', async () => {
  const viewer = makeViewer();
  trafficLayer.init(viewer);
  trafficLayer.enable(viewer);
  assert.equal(viewer.__added[0].show, true);

  await sleep(SETTLE_MS);
  const stats = trafficLayer.getStats();

  // mode is the CONFIGURED source; the outage rides on error, not mode.
  assert.equal(stats.mode, 'live');
  assert.equal(stats.error, 'SIMULATED — TomTom key unavailable');
  assert.equal(stats.loadingLabel, stats.error,
    'the degraded label IS the error text: the manager drops loadingLabel in its error branch');
  assert.ok(!LIVE_CLAIM.test(stats.loadingLabel),
    `degraded label must not claim live data: ${stats.loadingLabel}`);
  assert.ok(stats.loadingLabel.startsWith('SIMULATED'));

  assert.ok(stats.count > 0, 'roads still render as simulated dots');
  assert.equal(stats.flowBuckets.sim, stats.count, 'every dot is simulated white');
  assert.equal(stats.flowCoveragePct, 0, 'the stale coverage number is dropped');
  assert.ok(stats.tilesFetched >= 1, 'flow tiles were actually requested');
  assert.equal(stats.closedRoads, 0);
  assert.equal(stats.heatLines, 0, 'no heat-lines without bucketed flow');
  assert.equal(stats.loading, false, 'the load and the flow race both settled');
  assert.ok(stats.lastUpdate !== null);

  await trafficLayer.update();
  trafficLayer.disable(viewer);
});
