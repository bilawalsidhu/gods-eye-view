import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeaStateSource } from './source.js';

const MANIFEST = {
  schemaVersion: 1,
  field: { kind: 'significant-wave-height', units: 'm' },
  cycle: {
    forecastHour: 12,
    runIso: '2026-10-23T18:00:00.000Z',
    validIso: '2026-10-24T06:00:00.000Z',
  },
  grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180 },
  maxValue: 3,
  ageMs: 0,
  stale: true,
  gridUrl: '/api/sea-state/grid/a.bin',
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
    feed: createSeaStateSource({
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
    '/api/sea-state': Response.json(MANIFEST),
    '/api/sea-state/grid/a.bin': new Response(gridBytes([1, NaN, 3, 2])),
  });
  const snapshot = await feed.getSnapshot();
  assert.deepEqual(asked, ['/api/sea-state', '/api/sea-state/grid/a.bin']);
  assert.equal(snapshot.values[2], 3);
  assert.ok(Number.isNaN(snapshot.values[1]));
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.validIso, MANIFEST.cycle.validIso);
});

test('failures come back as the English shapes the status text translates', async () => {
  const cases = [
    [
      { '/api/sea-state': new Response('{}', { status: 502 }) },
      'Sea state HTTP 502',
    ],
    [
      { '/api/sea-state': new TypeError('fetch failed') },
      'Sea state network error',
    ],
    [
      { '/api/sea-state': Response.json({ ...MANIFEST, schemaVersion: 9 }) },
      'Malformed sea state response',
    ],
    [
      { '/api/sea-state': new Response('not json') },
      'Malformed sea state response',
    ],
    [{ '/api/sea-state': Response.json(MANIFEST) }, 'Sea state HTTP 404'],
    [
      {
        '/api/sea-state': Response.json(MANIFEST),
        '/api/sea-state/grid/a.bin': new Response(gridBytes([1, 2, 3])),
      },
      'Malformed sea state response',
    ],
  ];
  for (const [routes, message] of cases) {
    const { feed } = source(routes);
    await assert.rejects(feed.getSnapshot(), { message });
  }
  const { feed } = source({
    '/api/sea-state': new Response('', { status: 502 }),
  });
  await assert.rejects(feed.getSnapshot(), { retryable: true, status: 502 });
});

test('an aborted read rejects with the abort, not as a malformed answer', async () => {
  const controller = new AbortController();
  controller.abort(new Error('left the page'));
  const { asked, feed } = source({ '/api/sea-state': Response.json(MANIFEST) });
  await assert.rejects(feed.getSnapshot({ signal: controller.signal }), {
    message: 'left the page',
  });
  assert.deepEqual(asked, []);
});
