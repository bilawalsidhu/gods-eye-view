import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTrafficLayer } from './index.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(t, requestRoads) {
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
      credits: {},
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    },
    source: {
      requestRoads,
      getStatus: async () => ({ hasKey: false }),
      fetchFlowForBounds: async () => [],
      getFlowSessionStats: () => ({ tilesFetched: 0 }),
      resetFlowTileCache() {},
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

test('a declined road request reaches the row as the reason, not as a shrug', async (t) => {
  // Issue #661: with every public Overpass mirror refusing a network, the row
  // read "Road data temporarily unavailable" while the console already held
  // "Overpass API returned 406". The reporter went looking for a bad TomTom
  // key — the other half of this layer, and never the problem. The status the
  // code already has must survive the trip to the panel.
  let status = 406;
  const { layer, viewer, tick } = setup(t, async () => ({ ok: false, status }));
  layer.enable(viewer);
  await tick(400);
  assert.equal(
    layer.getStats().error,
    'Overpass refused the road query (HTTP 406)',
  );

  status = 429;
  for (let i = 0; i < 20; i++) await tick(1500);
  assert.equal(
    layer.getStats().error,
    'Overpass rate-limited',
    'a rate limit is a different instruction to the reader than a refusal',
  );
});

test('an unclassified road failure keeps the general line', async (t) => {
  // The complement of the test above, and the reason this is not just
  // `e.message`: a dropped socket throws whatever the platform felt like
  // saying, and "Failed to fetch" on a panel row helps nobody.
  const { layer, viewer, tick } = setup(t, async () => {
    throw new Error('socket hang up');
  });
  layer.enable(viewer);
  await tick(400);
  assert.equal(layer.getStats().error, 'Road data temporarily unavailable');
});
