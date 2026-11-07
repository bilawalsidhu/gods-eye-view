import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeaSurfaceTemperatureSource } from './source.js';

const MANIFEST = {
  schemaVersion: 1,
  source: 'noaa-crw-coraltemp',
  field: { kind: 'sea-surface-temperature', units: 'degC' },
  cycle: { date: '20261022', validIso: '2026-10-22T12:00:00.000Z' },
  grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180 },
  minValue: -1.8,
  maxValue: 30,
  ageMs: 0,
  stale: true,
  gridUrl: '/api/sea-surface-temperature/grid/a.bin',
};

function gridBytes(values) {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return new Uint8Array(buffer);
}

function source(routes) {
  const asked = [];
  return {
    asked,
    feed: createSeaSurfaceTemperatureSource({
      fetchImpl: async (url, options) => {
        asked.push(url);
        assert.ok(
          options.signal === undefined || options.signal instanceof AbortSignal,
        );
        const answer = routes[url];
        if (answer instanceof Error) throw answer;
        return answer ?? new Response('', { status: 404 });
      },
    }),
  };
}

test('the manifest then its grid are read through the same-origin route', async () => {
  const { asked, feed } = source({
    '/api/sea-surface-temperature': Response.json(MANIFEST),
    '/api/sea-surface-temperature/grid/a.bin': new Response(
      gridBytes([1, NaN, 3, 2]),
    ),
  });
  const snapshot = await feed.getSnapshot();
  assert.deepEqual(asked, [
    '/api/sea-surface-temperature',
    '/api/sea-surface-temperature/grid/a.bin',
  ]);
  assert.equal(snapshot.values[2], 3);
  assert.ok(Number.isNaN(snapshot.values[1]));
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.validIso, MANIFEST.cycle.validIso);
});

test('failures come back as the English shapes the status text translates', async () => {
  const cases = [
    [
      { '/api/sea-surface-temperature': new Response('{}', { status: 502 }) },
      'Sea surface temperature HTTP 502',
    ],
    [
      { '/api/sea-surface-temperature': new TypeError('fetch failed') },
      'Sea surface temperature network error',
    ],
    [
      {
        '/api/sea-surface-temperature': Response.json({
          ...MANIFEST,
          schemaVersion: 9,
        }),
      },
      'Malformed sea surface temperature response',
    ],
    [
      { '/api/sea-surface-temperature': new Response('not json') },
      'Malformed sea surface temperature response',
    ],
    [
      { '/api/sea-surface-temperature': Response.json(MANIFEST) },
      'Sea surface temperature HTTP 404',
    ],
    [
      {
        '/api/sea-surface-temperature': Response.json(MANIFEST),
        '/api/sea-surface-temperature/grid/a.bin': new Response(
          gridBytes([1, 2, 3]),
        ),
      },
      'Malformed sea surface temperature response',
    ],
  ];
  for (const [routes, message] of cases) {
    const { feed } = source(routes);
    await assert.rejects(feed.getSnapshot(), { message });
  }
  const { feed } = source({
    '/api/sea-surface-temperature': new Response('', { status: 502 }),
  });
  await assert.rejects(feed.getSnapshot(), { retryable: true, status: 502 });
});

test('an aborted read rejects with the abort, not as a malformed answer', async () => {
  const controller = new AbortController();
  controller.abort(new Error('left the page'));
  const { asked, feed } = source({
    '/api/sea-surface-temperature': Response.json(MANIFEST),
  });
  await assert.rejects(feed.getSnapshot({ signal: controller.signal }), {
    message: 'left the page',
  });
  assert.deepEqual(asked, []);
});
