import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTrafficLayer } from './index.js';
import { TRAFFIC_KEYLESS_REASON } from './model.js';
import { layerFeedState } from '../../data/feedState.js';
import { DataLayerManager } from '../../data/manager.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(t, requestRoads, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const camera = {
    positionCartographic: Cesium.Cartographic.fromDegrees(
      -97.744,
      30.267,
      3200,
    ),
    get positionWC() {
      return Cesium.Cartesian3.fromRadians(
        this.positionCartographic.longitude,
        this.positionCartographic.latitude,
        this.positionCartographic.height,
      );
    },
    changed: new Cesium.Event(),
    moveEnd: new Cesium.Event(),
    percentageChanged: 0.5,
    computeViewRectangle() {
      const { longitude, latitude } = this.positionCartographic;
      return new Cesium.Rectangle(
        longitude - 0.0002,
        latitude - 0.0002,
        longitude + 0.0002,
        latitude + 0.0002,
      );
    },
    pickEllipsoid: () => null,
  };
  const viewer = {
    camera,
    scene: {
      canvas: { width: 100, height: 100 },
      preRender: new Cesium.Event(),
      primitives: { add: (value) => value, remove: () => true },
    },
  };
  const layer = createTrafficLayer({
    services: {
      credits: overrides.credits || {},
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    },
    source: {
      requestRoads,
      getStatus: async () => ({ hasKey: false }),
      fetchFlowForBounds: async () => [],
      getFlowSessionStats: () => ({ tilesFetched: 0 }),
      resetFlowTileCache() {},
      ...overrides.source,
    },
  });
  layer.init(viewer);
  t.after(() => layer.destroy(viewer));
  const move = (lon, lat, height = 3200) => {
    camera.positionCartographic = Cesium.Cartographic.fromDegrees(
      lon,
      lat,
      height,
    );
    camera.changed.raiseEvent();
    camera.moveEnd.raiseEvent();
  };
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return { layer, viewer, move, tick };
}
function roads(bounds) {
  return {
    ok: true,
    json: async () => ({
      roads: [
        {
          type: 'primary',
          oneway: 0,
          coordinates: [
            [bounds.west, bounds.south],
            [bounds.west + 0.005, bounds.south + 0.005],
          ],
        },
      ],
    }),
  };
}

test('traffic recovers a failed destination request after another city has loaded', async (t) => {
  let londonCalls = 0;
  const { layer, viewer, move, tick } = setup(t, async (bounds) => {
    if (bounds.south > 50 && ++londonCalls === 1)
      throw new Error('temporary Overpass outage');
    return roads(bounds);
  });
  layer.enable(viewer);
  await tick(400);
  await tick(2000);
  assert.ok(layer.getStats().count > 0);
  move(-40, 40, 1000000);
  move(-0.1276, 51.5072);
  await tick(400);
  assert.equal(londonCalls, 1);
  for (let i = 0; i < 20; i++) await tick(1500);
  assert.ok(
    londonCalls >= 2,
    'the stationary destination must retry without a toggle',
  );
  assert.ok(layer.getStats().count > 0);
  assert.equal(layer.getStats().loading, false);
});

test('a superseded road response cannot release the current request controller', async (t) => {
  const pending = [];
  const { layer, viewer, move, tick } = setup(t, (bounds, { signal }) => {
    const result = deferred();
    pending.push({ ...result, bounds, signal });
    return result.promise;
  });
  layer.enable(viewer);
  await tick(400);
  move(-0.1276, 51.5072);
  await tick(400);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(roads(pending[0].bounds));
  await tick(0);
  layer.disable(viewer);
  assert.equal(
    pending[1].signal.aborted,
    true,
    'disable must still cancel the destination request',
  );
  pending[1].resolve(roads(pending[1].bounds));
  await tick(0);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().loading, false);
});

test('leaving traffic altitude cancels queued and in-flight work', async (t) => {
  const pending = [];
  const { layer, viewer, move, tick } = setup(t, (bounds, { signal }) => {
    const result = deferred();
    pending.push({ ...result, bounds, signal });
    return result.promise;
  });
  layer.enable(viewer);
  move(-40, 40, 1000000);
  await tick(400);
  assert.equal(
    pending.length,
    0,
    'a departing city debounce must not fetch above traffic altitude',
  );
  move(-0.1276, 51.5072);
  await tick(400);
  assert.equal(pending.length, 1);
  move(-40, 40, 1000000);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(roads(pending[0].bounds));
  await tick(0);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().loading, false);
});

test('arrival below the camera change threshold loads the final city and unsubscribes on disable', async (t) => {
  const seen = [];
  const { layer, viewer, tick } = setup(t, async (bounds) => {
    seen.push(bounds);
    return roads(bounds);
  });
  layer.enable(viewer);
  await tick(400);
  viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -0.1276,
    51.5072,
    3200,
  );
  viewer.camera.moveEnd.raiseEvent();
  await tick(400);
  assert.ok(seen.some((bounds) => bounds.south > 50));
  layer.disable(viewer);
  assert.equal(viewer.camera.moveEnd.numberOfListeners, 0);
  assert.equal(viewer.camera.changed.numberOfListeners, 0);
});

const KEYLESS_META =
  'DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds)';

/** The DATA LAYERS row meta line for an enabled traffic layer with these stats. */
function metaLine(stats) {
  return new DataLayerManager({})._buildMetaText({
    id: 'traffic',
    source: 'OpenStreetMap',
    enabled: true,
    stats,
  });
}

function keylessStatus() {
  return {
    hasKey: false,
    dailyCount: 0,
    budget: 40000,
    requestCount: 0,
    requestBudget: 2000,
    date: '2026-09-18',
    provider: {
      status: 'degraded',
      source: 'TomTom',
      error:
        'TOMTOM_API_KEY not set — flow colours are simulated on live OSM roads',
    },
    providerStatus: {
      status: 'degraded',
      source: 'TomTom',
      fetchedAtMs: Date.now(),
      ageSec: 0,
      error:
        'TOMTOM_API_KEY not set — flow colours are simulated on live OSM roads',
      count: null,
    },
  };
}

test('a keyless layer toggled on loads OSM roads and reads DEGRADED with the TomTom key reason', async (t) => {
  const statusCalls = [];
  const { layer, viewer, tick } = setup(t, async (bounds) => roads(bounds), {
    source: {
      getStatus: async (options) => {
        statusCalls.push(options);
        return keylessStatus();
      },
    },
  });
  // Boot: nothing has been asked yet — today's FALLBACK presentation.
  assert.equal(layerFeedState(layer.getStats()), 'fallback');
  layer.enable(viewer);
  await tick(400);
  const stats = layer.getStats();
  assert.ok(stats.count > 0, 'OSM roads render without a TomTom key');
  assert.equal(stats.loading, false);
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.error, null);
  assert.equal(stats.status, 'degraded');
  assert.equal(stats.degraded, true);
  assert.equal(stats.providerStatus, 'degraded');
  assert.equal(stats.providerSource, 'TomTom');
  assert.equal(stats.source, 'TomTom');
  assert.equal(stats.providerError, TRAFFIC_KEYLESS_REASON);
  assert.equal(stats.loadingLabel, 'SIMULATED — add TomTom key for live');
  assert.equal(stats.flowSegment, null);
  assert.deepEqual(stats.flowBudget, {
    date: '2026-09-18',
    tiles: { count: 0, budget: 40000 },
    requests: { count: 0, budget: 2000 },
  });
  assert.equal(layerFeedState(stats), 'degraded');
  assert.equal(metaLine(stats), KEYLESS_META);
  // The probe carried the scene point (camera position, degrees) and ran once.
  assert.equal(statusCalls.length, 1);
  assert.ok(Math.abs(statusCalls[0].point.lat - 30.267) < 1e-6);
  assert.ok(Math.abs(statusCalls[0].point.lon - -97.744) < 1e-6);
  layer.disable(viewer);
  layer.enable(viewer);
  await tick(400);
  assert.equal(statusCalls.length, 1, 'keyless sessions never re-ask');
});

test('a keyed layer surfaces the live-speed probe and reads LIVE once tiles arrive', async (t) => {
  let credited = 0;
  const fetchedAt = new Date().toISOString();
  const { layer, viewer, tick } = setup(t, async (bounds) => roads(bounds), {
    credits: {
      registerDynamicCredit() {
        credited += 1;
      },
      TOMTOM_CREDIT: { id: 'tomtom' },
    },
    source: {
      getStatus: async () => ({
        hasKey: true,
        dailyCount: 12,
        budget: 40000,
        requestCount: 1,
        requestBudget: 2000,
        date: '2026-09-18',
        flowSegment: {
          ok: true,
          currentSpeed: 37,
          freeFlowSpeed: 55,
          confidence: 0.9,
          fetchedAt,
          stale: false,
        },
        providerStatus: {
          status: 'live',
          source: 'TomTom',
          fetchedAtMs: Date.parse(fetchedAt),
          ageSec: 0,
          error: null,
          count: null,
        },
      }),
      fetchFlowForBounds: async () => [],
      getFlowSessionStats: () => ({
        tilesFetched: 4,
        provider: {
          status: 'live',
          fetchedAtMs: Date.parse(fetchedAt),
          ageSec: 0,
          error: null,
        },
      }),
    },
  });
  layer.enable(viewer);
  await tick(400);
  const stats = layer.getStats();
  assert.ok(stats.count > 0);
  assert.equal(stats.mode, 'live');
  assert.equal(stats.error, null);
  assert.equal(stats.status, 'live');
  assert.equal(stats.providerStatus, 'live');
  assert.equal(stats.providerSource, 'TomTom');
  assert.equal(stats.providerError, null);
  assert.equal(stats.flowSegment.currentSpeed, 37);
  assert.equal(stats.flowSegment.freeFlowSpeed, 55);
  assert.equal(stats.flowSegment.confidence, 0.9);
  assert.equal(stats.flowSegment.fetchedAt, fetchedAt);
  assert.equal(stats.tilesFetched, 4);
  assert.equal(stats.flowBudget.tiles.count, 12);
  assert.equal(credited, 1, 'the TomTom attribution registers once');
  assert.equal(layerFeedState(stats), 'nominal');
  assert.equal(metaLine(stats), 'OpenStreetMap · LIVE · TomTom flow · 0% cov');
});

test('a rejected key is reported by the probe before any tile and by the tiles after', async (t) => {
  const { layer, viewer, tick } = setup(t, async (bounds) => roads(bounds), {
    credits: { registerDynamicCredit() {}, TOMTOM_CREDIT: {} },
    source: {
      getStatus: async () => ({
        hasKey: true,
        flowSegment: { ok: false, error: 'TomTom rejected TOMTOM_API_KEY' },
        providerStatus: {
          status: 'degraded',
          source: 'TomTom',
          fetchedAtMs: Date.now(),
          ageSec: 0,
          error: 'TomTom rejected TOMTOM_API_KEY',
          count: null,
        },
      }),
      fetchFlowForBounds: async () => {
        throw Object.assign(new Error('flow tile 12/1/1: HTTP 503 bad_key'), {
          status: 503,
          code: 'bad_key',
          provider: {
            status: 'unavailable',
            error: 'TomTom rejected TOMTOM_API_KEY',
          },
        });
      },
    },
  });
  layer.enable(viewer);
  await tick(400);
  const stats = layer.getStats();
  assert.ok(stats.count > 0, 'roads still render on simulated colours');
  assert.equal(stats.mode, 'live');
  assert.equal(stats.error, 'SIMULATED — TomTom rejected TOMTOM_API_KEY');
  assert.equal(stats.providerError, 'TomTom rejected TOMTOM_API_KEY');
  assert.equal(stats.providerStatus, 'degraded');
  assert.equal(stats.flowSegment.ok, false);
  assert.equal(layerFeedState(stats), 'degraded');
  assert.equal(
    metaLine(stats),
    'DEGRADED · TomTom · SIMULATED — TomTom rejected TOMTOM_API_KEY',
  );
});

test('an unreachable status probe degrades with its reason and is retried after the cooldown', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let statusCalls = 0;
  const { layer, viewer, move, tick } = setup(
    t,
    async (bounds) => roads(bounds),
    {
      source: {
        getStatus: async () => {
          statusCalls += 1;
          if (statusCalls === 1) throw new Error('HTTP 502');
          return keylessStatus();
        },
      },
    },
  );
  layer.enable(viewer);
  await tick(400);
  let stats = layer.getStats();
  assert.ok(stats.count > 0);
  assert.equal(stats.error, 'TomTom status unreachable — simulated flow');
  assert.equal(stats.degraded, true);
  assert.equal(stats.status, 'degraded');
  assert.equal(layerFeedState(stats), 'degraded');
  assert.equal(
    metaLine(stats),
    'DEGRADED · TomTom · TomTom status unreachable — simulated flow',
  );
  // Within the cooldown a new load does not re-ask …
  move(-97.75, 30.27);
  await tick(400);
  assert.equal(statusCalls, 1);
  // … after it, the next load does, and the answer replaces the outage.
  now += 31_000;
  move(-97.76, 30.28);
  await tick(400);
  assert.equal(statusCalls, 2);
  stats = layer.getStats();
  assert.equal(stats.error, null);
  assert.equal(stats.providerError, TRAFFIC_KEYLESS_REASON);
  assert.equal(layerFeedState(stats), 'degraded');
  assert.equal(metaLine(stats), KEYLESS_META);
});

test('parked failures back off and disabling cancels the scheduled retry', async (t) => {
  let calls = 0;
  const { layer, viewer, tick } = setup(t, async () => {
    calls++;
    throw new Error('temporary Overpass outage');
  });
  layer.enable(viewer);
  await tick(400);
  assert.equal(calls, 1);
  assert.equal(layer.getStats().loading, false);
  assert.equal(layer.getStats().error, 'Road data temporarily unavailable');
  await tick(1500);
  await tick(400);
  assert.equal(calls, 2);
  await tick(1500);
  await tick(400);
  assert.equal(calls, 2, 'second failure waits longer than the first');
  layer.disable(viewer);
  await tick(60000);
  assert.equal(calls, 2);
  assert.equal(layer.getStats().error, null);
});
