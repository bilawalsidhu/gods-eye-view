import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationOperations } from './operations.js';

function requests(terrain, boundaries = { query: async () => [] }) {
  return {
    terrain,
    boundaries,
    regional: { getBrief: async () => ({}) },
    weather: { getConditions: async () => ({}) },
    summary: { summarize: async () => ({}) },
  };
}

test('surface cache and stack listeners belong to the supplied application lifetime', async (t) => {
  const a = new AbortController();
  const b = new AbortController();
  t.after(() => {
    a.abort();
    b.abort();
  });
  const target = new EventTarget();
  let calls = 0;
  const first = createApplicationOperations({
    signal: a.signal,
    eventTarget: target,
    requests: requests({
      async getHeights(points) {
        calls++;
        return points.map(() => ({ ellipsoid: 123 }));
      },
    }),
  });
  const second = createApplicationOperations({
    signal: b.signal,
    eventTarget: target,
    requests: requests({
      async getHeights(points) {
        return points.map(() => ({ ellipsoid: 456 }));
      },
    }),
  });
  const point = { lat: 30, lon: -97 };
  await first.surface.terrain.resolveEllipsoidalGround([point]);
  await first.surface.terrain.resolveEllipsoidalGround([point]);
  await second.surface.terrain.resolveEllipsoidalGround([point]);
  assert.equal(calls, 1);
  assert.equal(first.surface.groundFloor.cachedGroundFloor(30, -97), 123);
  assert.equal(second.surface.groundFloor.cachedGroundFloor(30, -97), 456);
  target.dispatchEvent(
    new CustomEvent('gev:map-stack-changed', {
      detail: { activeId: 'esri-imagery' },
    }),
  );
  assert.equal(first.surface.groundFloor.meshFloorPreferred(), false);
  a.abort();
  assert.equal(first.surface.terrain.cachedEllipsoidalGround(30, -97), null);
  target.dispatchEvent(
    new CustomEvent('gev:map-stack-changed', {
      detail: { activeId: 'photoreal' },
    }),
  );
  assert.equal(
    first.surface.groundFloor.meshFloorPreferred(),
    false,
    'disposed listener cannot update the old owner',
  );
  assert.equal(second.surface.groundFloor.meshFloorPreferred(), true);
});

test('a terrain reply after application abort cannot refill the cache or become a fallback', async () => {
  const lifetime = new AbortController();
  let respond;
  let receivedSignal;
  const operations = createApplicationOperations({
    signal: lifetime.signal,
    eventTarget: null,
    requests: requests({
      getHeights(_points, { signal }) {
        receivedSignal = signal;
        return new Promise((resolve) => {
          respond = resolve;
        });
      },
    }),
  });
  const pending = operations.surface.terrain.resolveEllipsoidalGround([
    { lat: 30, lon: -97 },
  ]);
  lifetime.abort();
  respond([{ ellipsoid: 123 }]);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(receivedSignal.aborted, true);
  assert.equal(
    operations.surface.terrain.cachedEllipsoidalGround(30, -97),
    null,
  );
});

test('annotation lookup and cached outlines use the supplied source independently', async (t) => {
  const priorWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  const a = new AbortController();
  const b = new AbortController();
  t.after(() => {
    a.abort();
    b.abort();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  });
  const calls = [0, 0];
  const make = (signal, index) =>
    createApplicationOperations({
      signal,
      eventTarget: null,
      requests: requests(
        { getHeights: async () => [] },
        {
          query: async () => {
            calls[index]++;
            const delta = index * 0.0001;
            return [
              {
                type: 'way',
                id: index + 1,
                tags: { building: 'yes', name: 'Source fixture hall' },
                geometry: [
                  { lat: 30 - 0.0001, lon: -97 - 0.0001 + delta },
                  { lat: 30 - 0.0001, lon: -97 + 0.0001 + delta },
                  { lat: 30 + 0.0001, lon: -97 + 0.0001 + delta },
                  { lat: 30 + 0.0001, lon: -97 - 0.0001 + delta },
                  { lat: 30 - 0.0001, lon: -97 - 0.0001 + delta },
                ],
              },
            ];
          },
        },
      ),
    });
  const first = make(a.signal, 0);
  const second = make(b.signal, 1);
  const query = {
    viewer: {},
    target: 'Source fixture hall',
    latitude: 30,
    longitude: -97,
    footprint: true,
    entityKind: 'building',
  };
  const resultA = await first.annotationResolver.resolveAnnotationTarget(query);
  const resultB =
    await second.annotationResolver.resolveAnnotationTarget(query);
  assert.ok(resultA.ring?.length >= 4);
  assert.ok(resultB.ring?.length >= 4);
  assert.notDeepEqual(resultA.ring, resultB.ring);
  const before = calls[0];
  const cached = await first.annotationResolver.resolveAnnotationTarget(query);
  assert.deepEqual(cached.ring, resultA.ring);
  assert.equal(calls[0], before);
  a.abort();
  await assert.rejects(
    first.annotationResolver.resolveAnnotationTarget(query),
    { name: 'AbortError' },
  );
});
