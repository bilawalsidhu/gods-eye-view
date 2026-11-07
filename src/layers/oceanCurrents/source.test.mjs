import assert from 'node:assert/strict';
import test from 'node:test';
import { createOceanCurrentsSource } from './source.js';

const MANIFEST = {
  schemaVersion: 1,
  field: {
    kind: 'surface-sea-water-velocity',
    units: 'm/s',
    components: ['u', 'v'],
  },
  cycle: {
    runIso: '2026-10-24T00:00:00.000Z',
    validIso: '2026-10-24T12:00:00.000Z',
  },
  grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180 },
  maxSpeed: 1,
  ageMs: 0,
  stale: false,
  gridUrl: '/api/ocean-currents/grid/a.bin',
};

function bytes(values) {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return new Uint8Array(view.buffer);
}

function source(routes) {
  const asked = [];
  return {
    asked,
    feed: createOceanCurrentsSource({
      fetchImpl: async (url) => {
        asked.push(url);
        const answer = routes[url];
        if (answer instanceof Error) throw answer;
        return answer ?? new Response('', { status: 404 });
      },
    }),
  };
}

test('the manifest then one grid are read, and the grid splits into u and v', async () => {
  const { asked, feed } = source({
    '/api/ocean-currents': Response.json(MANIFEST),
    '/api/ocean-currents/grid/a.bin': new Response(
      bytes([1, NaN, 0, 0, -1, 0.5, 0, 0]),
    ),
  });
  const snapshot = await feed.getSnapshot();
  assert.deepEqual(asked, [
    '/api/ocean-currents',
    '/api/ocean-currents/grid/a.bin',
  ]);
  assert.equal(snapshot.u[0], 1);
  assert.ok(Number.isNaN(snapshot.u[1]));
  assert.deepEqual(Array.from(snapshot.v), [-1, 0.5, 0, 0]);
  assert.equal(snapshot.values, undefined);
  assert.equal(snapshot.maxSpeed, 1);
});

test('failures come back as the English shapes the status text translates', async () => {
  for (const [routes, message] of [
    [
      { '/api/ocean-currents': new Response('{}', { status: 502 }) },
      'Ocean currents HTTP 502',
    ],
    [
      { '/api/ocean-currents': new TypeError('fetch failed') },
      'Ocean currents network error',
    ],
    [
      {
        '/api/ocean-currents': Response.json({ ...MANIFEST, schemaVersion: 2 }),
      },
      'Malformed ocean currents response',
    ],
    [
      {
        '/api/ocean-currents': Response.json(MANIFEST),
        '/api/ocean-currents/grid/a.bin': new Response(bytes([1, 2, 3, 4])),
      },
      'Malformed ocean currents response',
    ],
  ]) {
    const { feed } = source(routes);
    await assert.rejects(feed.getSnapshot(), { message });
  }
});
