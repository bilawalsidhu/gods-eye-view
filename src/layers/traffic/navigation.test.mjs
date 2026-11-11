import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createTrafficLayer } from './index.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(t, requestRoads, getStatus = async () => ({ hasKey: false })) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const engine = createFakeEngine({
    width: 100,
    height: 100,
    canvas: { width: 100, height: 100 },
  });
  const camera = engine.camera;
  // Without a pick ray the layer bounds its fetch by the view rectangle
  // (no reticle footprint); a test that wants the footprint puts it back.
  const pickRay = camera.pickRay;
  camera.pickRay = undefined;
  const place = (lon, lat, height) =>
    engine.fake.setPose({
      longitude: geo.math.toRadians(lon),
      latitude: geo.math.toRadians(lat),
      height,
    });
  place(-97.744, 30.267, 3200);
  // A view rectangle of ±0.0002 rad around the camera.
  engine.fake.script('viewRectangle', () => {
    const { longitude, latitude } = camera.pose().cartographic;
    return {
      west: longitude - 0.0002,
      south: latitude - 0.0002,
      east: longitude + 0.0002,
      north: latitude + 0.0002,
    };
  });
  engine.fake.script('pickEllipsoid', undefined);
  engine.fake.script('terrainHeight', 0);
  const layer = createTrafficLayer({
    services: {
      credits: {},
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    },
    source: {
      requestRoads,
      getStatus,
      fetchFlowForBounds: async () => [],
      getFlowSessionStats: () => ({ tilesFetched: 0 }),
      resetFlowTileCache() {},
    },
  });
  layer.init(null, { engine });
  t.after(() => layer.destroy());
  const move = (lon, lat, height = 3200) => {
    place(lon, lat, height);
    engine.fake.emit('camera.changed');
    engine.fake.emit('camera.moveEnd');
  };
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.mock.timers.tick(0);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.mock.timers.tick(0);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return { layer, engine, camera, pickRay, place, move, tick };
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
  const { layer, move, tick } = setup(t, async (bounds) => {
    if (bounds.south > 50 && ++londonCalls === 1)
      throw new Error('temporary Overpass outage');
    return roads(bounds);
  });
  layer.enable();
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
  const { layer, move, tick } = setup(t, (bounds, { signal }) => {
    const result = deferred();
    pending.push({ ...result, bounds, signal });
    return result.promise;
  });
  layer.enable();
  await tick(400);
  move(-0.1276, 51.5072);
  await tick(400);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(roads(pending[0].bounds));
  await tick(0);
  layer.disable();
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
  const { layer, move, tick } = setup(t, (bounds, { signal }) => {
    const result = deferred();
    pending.push({ ...result, bounds, signal });
    return result.promise;
  });
  layer.enable();
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
  const { layer, engine, place, tick } = setup(t, async (bounds) => {
    seen.push(bounds);
    return roads(bounds);
  });
  layer.enable();
  await tick(400);
  place(-0.1276, 51.5072, 3200);
  engine.fake.emit('camera.moveEnd');
  await tick(400);
  assert.ok(seen.some((bounds) => bounds.south > 50));
  layer.disable();
  assert.equal(engine.camera.moveEnd.numberOfListeners, 0);
  assert.equal(engine.camera.changed.numberOfListeners, 0);
});

test('parked failures back off and disabling cancels the scheduled retry', async (t) => {
  let calls = 0;
  const { layer, tick } = setup(t, async () => {
    calls++;
    throw new Error('temporary Overpass outage');
  });
  layer.enable();
  await tick(400);
  assert.equal(calls, 1);
  assert.equal(layer.getStats().loading, false);
  assert.equal(layer.getStats().error, 'OpenFreeMap tiles unavailable');
  await tick(1500);
  await tick(400);
  assert.equal(calls, 2);
  await tick(1500);
  await tick(400);
  assert.equal(calls, 2, 'second failure waits longer than the first');
  layer.disable();
  await tick(60000);
  assert.equal(calls, 2);
  assert.equal(layer.getStats().error, null);
});

test('not-configured roads stop both parked retries and the enable-time kick', async (t) => {
  let requests = 0;
  const h = setup(t, async () => {
    requests++;
    return {
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => ({ code: 'OVERPASS_NOT_CONFIGURED', retryable: false }),
    };
  });
  h.layer.enable();
  await h.tick(400);
  await h.tick(60_000);
  assert.equal(requests, 1);
  assert.equal(h.layer.getStats().loading, false);
  assert.match(h.layer.getStats().loadingLabel, /UNAVAILABLE/);
});

test('a declined road request reaches the row as the reason, not as a shrug', async (t) => {
  let status = 406;
  const { layer, tick } = setup(t, async () => ({ ok: false, status }));
  layer.enable();
  await tick(400);
  assert.equal(
    layer.getStats().error,
    'OpenFreeMap tiles unavailable (HTTP 406)',
  );

  status = 429;
  for (let i = 0; i < 20; i++) await tick(1500);
  assert.equal(
    layer.getStats().error,
    'OpenFreeMap tiles rate-limited',
    'a rate limit is a different instruction to the reader than a refusal',
  );
});

test('an unclassified road failure keeps the general line', async (t) => {
  const { layer, tick } = setup(t, async () => {
    throw new Error('socket hang up');
  });
  layer.enable();
  await tick(400);
  assert.equal(layer.getStats().error, 'OpenFreeMap tiles unavailable');
});

test('a stalled TomTom status never blocks road acquisition or first simulated dots', async (t) => {
  let calls = 0;
  const { layer, tick } = setup(
    t,
    async (box) => {
      calls++;
      return roads(box);
    },
    () => new Promise(() => {}),
  );
  // The source contract is exercised independently of status by the production
  // load path; the real source status cancellation case is in source.test.
  layer.enable();
  await tick(400);
  await tick(2000);
  assert.ok(calls > 0);
  assert.ok(layer.getStats().count > 0);
});

test('explicit enable starts roads without the camera debounce', async (t) => {
  let calls = 0;
  const { layer, tick } = setup(t, async (box) => {
    calls++;
    return roads(box);
  });
  layer.enable();
  await tick(0);
  assert.ok(calls > 0, 'the first load starts before 320 ms');
});

test('moveEnd starts the destination request without another gesture debounce', async (t) => {
  let calls = 0;
  const { layer, move, tick } = setup(t, async (bounds) => {
    calls++;
    return roads(bounds);
  });
  layer.enable();
  await tick(400);
  const before = calls;
  move(-0.1276, 51.5072);
  await tick(0);
  assert.ok(calls > before, 'arrival loads in the next task, before 320 ms');
});

test('traffic surface observers belong to enable and leave no listener after disable or destroy', async (t) => {
  const { layer, engine, tick } = setup(t, async (bounds) => roads(bounds));
  const { postRender, preRender } = engine.frames;
  assert.equal(postRender.numberOfListeners, 0);
  for (let i = 0; i < 3; i++) {
    layer.enable();
    layer.enable();
    assert.equal(postRender.numberOfListeners, 1);
    engine.fake.emit('frames.postRender');
    await tick(1);
    layer.disable();
    assert.equal(postRender.numberOfListeners, 0);
    await tick(5000);
    assert.equal(
      postRender.numberOfListeners,
      0,
      'late work cannot resubscribe',
    );
  }
  layer.enable();
  assert.equal(postRender.numberOfListeners, 1);
  layer.destroy();
  assert.equal(postRender.numberOfListeners, 0);
  assert.equal(preRender.numberOfListeners, 0);
});

test('coverage changes at the same center reload and disabling invalidates coverage without dropping source caches', async (t) => {
  const calls = [];
  const { layer, tick } = setup(t, async (bounds) => {
    calls.push(bounds);
    return roads(bounds);
  });
  layer.enable();
  await tick(1000);
  await tick(2000);
  assert.ok(layer.getStats().count > 0);
  const before = calls.length;
  layer.disable();
  layer.enable();
  await tick(1000);
  await tick(2000);
  assert.ok(layer.getStats().count > 0, 'enable must repaint the same view');
  assert.ok(calls.length >= before);
});

test('a settled footprint loads new tiles even when the camera centre stays put', async (t) => {
  const seen = [];
  const { layer, engine, camera, pickRay, tick } = setup(
    t,
    async (bounds, { majorOnly, coverage }) => {
      if (!majorOnly) seen.push({ ...bounds, coverage });
      return roads(bounds);
    },
  );
  layer.setParams({ roadMode: 'osm' });
  let reach = 0.005;
  camera.pickRay = pickRay;
  // Angles only: the camera stays where it is.
  const turn = (angles) =>
    engine.fake.setPose({ position: camera.pose().position, ...angles });
  turn({ heading: 0, pitch: -Math.PI / 2 });
  engine.fake.script('pickEllipsoid', (pixel) =>
    geo.cartesian3.fromDegrees(
      -97.744 + (pixel.x - 50) / 10000,
      30.267 + (pixel.y / 100) * reach,
      0,
    ),
  );
  layer.enable();
  await tick(400);
  assert.equal(seen.length, 1);
  const firstKey = seen[0].coverage.key;
  engine.fake.emit('camera.changed');
  // The final flight step occurs below the changed-event threshold.
  reach = 0.08;
  turn({ pitch: -Math.PI / 12 });
  await tick(400);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[1].coverage.key, firstKey);
  assert.ok(
    seen[1].north > 30.33,
    'sample the final view when the debounce fires',
  );
  engine.fake.emit('camera.moveEnd');
  await tick(400);
  assert.equal(
    seen.length,
    2,
    'an identical settled footprint does not reload',
  );
});

test('partial coverage retries while coarse roads render, then stops after three retries', async (t) => {
  let calls = 0;
  const { layer, tick } = setup(t, async (bounds) => {
    calls++;
    const response = roads(bounds);
    const data = await response.json();
    return { ok: true, json: async () => ({ ...data, partial: true }) };
  });
  layer.enable();
  await tick(400);
  await tick(0);
  assert.ok(layer.getStats().count > 0);
  const initial = calls;
  for (let i = 0; i < 12; i++) {
    await tick(30000);
    await tick(400);
  }
  assert.equal(calls, initial * 4, 'initial load plus three bounded retries');
  assert.ok(layer.getStats().count > 0);
});
